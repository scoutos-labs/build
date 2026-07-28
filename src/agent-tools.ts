import { WORKSPACE_PREFIX, isWorkspacePath } from './workspace-store'
/**
 * The agent's tools — the WebContainer as control plane.
 *
 * This is the module that makes Build's harness different from a hosted chat
 * agent: `exec` is not a rented microVM, it is `wc.spawn()` against the same
 * container the user's preview is already running in. The agent can run
 * `npx tsc --noEmit`, read the real diagnostics, fix them, and re-check before
 * handing back.
 *
 * Two rules govern everything here.
 *
 * **1. Writes go through the project actor, never straight to the container.**
 * `project.files` is the source of truth; the container FS is a replica that
 * feeds nothing else. `project.FileApplied` updates both. A direct
 * `wc.fs.writeFile` would leave the editor, ZIP export, publish, autosave, and
 * the next turn's prompt context reading stale bytes — a silent desync with no
 * error anywhere.
 *
 * **2. Results never echo content.** A write returns `ok · 412 bytes`, not the
 * bytes. Tool results are re-sent to the model on the next step, so echoing
 * would pay for the same content twice and inflate every subsequent step.
 *
 * Path policy and the `exec` allowlist are enforced in one function each so
 * there is a single place to audit and a single place a test can pin.
 */

/** Per-file write cap. Bigger than any sane source file, small enough that a
 * runaway generation cannot fill IndexedDB. */
export const MAX_FILE_BYTES = 64 * 1024
/** Files in one `fs_batch_write`. */
export const MAX_BATCH_FILES = 20
/** Cap on what any single tool result sends back to the model. */
export const MAX_RESULT_CHARS = 8_000
/** `exec` output kept from the head — `tsc` puts diagnostics first. */
export const EXEC_HEAD_CHARS = 2_000
/** …and from the tail, where the summary count lives. */
export const EXEC_TAIL_CHARS = 6_000
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000
export const MAX_EXEC_TIMEOUT_MS = 180_000

/**
 * Paths the agent may never touch.
 *
 * `.env` and friends are **denied rather than approval-gated**. The locked
 * decision was to gate secrets, but the mechanism it would gate does not exist:
 * there is no env-var channel wired through the Gleam effects or the server
 * request body. Denying is strictly stronger than gating, needs no approval UI,
 * and matches reality — `isSyncableTextFile` in `webcontainer.ts` would silently
 * drop a written `.env` on the next "Sync from terminal" anyway.
 *
 * `node_modules` / `dist` / `.git` are denied because they are generated: the
 * agent editing them is always a mistake, and they would bloat `project.files`,
 * the ZIP, and every published deploy.
 */
const DENIED_PREFIXES = ['node_modules/', 'dist/', '.git/', '.cache/', 'coverage/']
// All case-insensitive: the asymmetry of some patterns carrying `i` and others
// not made `.ENV` and `ID_RSA` writable, which reads as an oversight rather than
// a decision.
const DENIED_EXACT = new Set(['.env'])
const DENIED_PATTERNS = [/^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /^id_rsa/i, /^\.npmrc$/i]

/**
 * Files that may be written but never deleted: removing any of them breaks the
 * app or the database bridge in a way the agent cannot recover from.
 * (Consumed by `fs_delete`, which lands in a later unit; defined here so the
 * policy has one home.)
 */
export const UNDELETABLE = new Set([
  'package.json',
  'vite.config.ts',
  'zepto-bridge.js',
  'server.js',
  'index.html',
  'src/db.ts',
  'src/main.tsx',
  'src/build-inspector.ts',
  'src/lib/utils.ts',
  'src/style.css',
  'tailwind.config.js',
  'postcss.config.js',
  'BRAIN.md',
])

export type PathVerdict = { ok: true; path: string } | { ok: false; reason: string }

/**
 * The single path policy. Every `fs_*` tool routes through this.
 *
 * Rejects rather than sanitizes: silently rewriting `../../etc/passwd` into
 * something harmless teaches the model nothing, whereas a refusal with a reason
 * lands in the transcript and steers the next attempt.
 */
export function normalizePath(raw: unknown): PathVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'Path must be a string.' }
  const path = raw.trim()
  if (!path) return { ok: false, reason: 'Path is empty.' }
  if (path.includes('\0')) return { ok: false, reason: 'Path contains a null byte.' }
  if (path.includes('\\')) return { ok: false, reason: 'Use forward slashes in paths.' }
  if (path.startsWith('/')) return { ok: false, reason: 'Paths must be relative to the project root.' }
  if (/^[a-zA-Z]:/.test(path)) return { ok: false, reason: 'Paths must be relative to the project root.' }

  const segments = path.split('/')
  if (segments.some(segment => segment === '..')) {
    return { ok: false, reason: 'Paths may not escape the project with "..".' }
  }
  if (segments.some(segment => segment === '')) {
    return { ok: false, reason: 'Path has an empty segment.' }
  }
  if (segments.some(segment => segment === '.')) {
    return { ok: false, reason: 'Path has a "." segment; write the plain path instead.' }
  }

  for (const prefix of DENIED_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
      return { ok: false, reason: `${prefix} is generated — it is not part of your project's source.` }
    }
  }
  const name = segments[segments.length - 1] ?? ''
  if (DENIED_EXACT.has(path.toLowerCase()) || DENIED_PATTERNS.some(pattern => pattern.test(name))) {
    return { ok: false, reason: 'That file holds secrets or keys; it is off limits.' }
  }
  return { ok: true, path }
}

export type ProjectFile = { path: string; content: string }

/**
 * Everything a tool needs from the outside world.
 *
 * Injected rather than imported so the whole tool surface is testable without a
 * WebContainer, a Gleam runtime, or a browser.
 */
export type ToolContext = {
  /** Current project files — the source of truth, not the container. */
  files(): ProjectFile[]
  /**
   * The workspace: `.build/` paths (skills, personas) that belong to the user
   * rather than to their app, and must never reach publish, the ZIP, or the
   * container. See `src/workspace-store.ts`.
   */
  readWorkspace(path: string): Promise<string | undefined>
  writeWorkspace(path: string, content: string): Promise<void>
  deleteWorkspace(path: string): Promise<void>
  listWorkspace(prefix: string): Promise<{ path: string; bytes: number }[]>
  /** Write through the project actor (`project.FileApplied`). */
  applyFile(path: string, content: string): void
  /** Remove through the project actor (`project.FileRemoved`). */
  removeFile(path: string): void
  /** Read a path from the container, for build artifacts `project.files` never sees. */
  readContainerFile(path: string): Promise<string | undefined>
  /** Flush queued container writes. Called before `exec` so a command sees what
   * the agent just wrote. */
  flushWrites(): Promise<void>
  /** Spawn a process in the container. */
  spawn(command: string, args: string[]): Promise<SpawnedProcess>
  /** Stream a line to the user's terminal. */
  log(line: string): void
}

export type SpawnedProcess = {
  /** Resolves with the exit code. */
  exit: Promise<number>
  /** Called with each output chunk. */
  onOutput(handler: (chunk: string) => void): void
  kill(): void
}

/**
 * What an executed tool reports back.
 *
 * `summary` is founder-facing trail copy — a verb and maybe an outcome, never a
 * tool name, a path list, or content. `content` is what the model sees.
 */
export type ToolResult = {
  ok: boolean
  /** Sent to the model. Capped; never echoes file content. */
  content: string
  /** Trail copy, past tense. */
  summary: string
  /** Files written, for chips and the build log. */
  paths?: string[]
  /** True only for an `exec` that successfully installed dependencies. */
  installed?: boolean
}

function refuse(reason: string, summary: string): ToolResult {
  return { ok: false, content: reason, summary }
}

function cap(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]`
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** "src/App.tsx" → "App.tsx", for trail copy that doesn't read like a filesystem. */
function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

// ── fs_list ──────────────────────────────────────────────────────────────────

export async function fsList(ctx: ToolContext, args: { prefix?: unknown }): Promise<ToolResult> {
  const prefix = typeof args.prefix === 'string' ? args.prefix.trim() : ''
  // `.build/` is a virtual namespace over the workspace store, so a listing of
  // it must not consult project.files at all.
  if (isWorkspacePath(prefix)) {
    const entries = await ctx.listWorkspace(prefix)
    return {
      ok: true,
      content: entries.length ? cap(JSON.stringify(entries)) : `No saved files under "${prefix}".`,
      summary: 'Looked through your saved notes',
    }
  }
  const matched = ctx
    .files()
    .filter(file => !prefix || file.path.startsWith(prefix))
    .map(file => ({ path: file.path, bytes: byteLength(file.content) }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const workspace = prefix ? [] : await ctx.listWorkspace(WORKSPACE_PREFIX)

  if (matched.length === 0) {
    return {
      ok: true,
      content: prefix ? `No files under "${prefix}".` : 'The project has no files.',
      summary: prefix ? `Looked in ${prefix}` : 'Looked through the project',
    }
  }
  return {
    ok: true,
    content: cap(JSON.stringify([...matched, ...workspace])),
    summary: prefix ? `Looked in ${prefix}` : `Listed ${matched.length} files`,
  }
}

// ── fs_read ──────────────────────────────────────────────────────────────────

export async function fsRead(
  ctx: ToolContext,
  args: { path?: unknown; from_container?: unknown },
): Promise<ToolResult> {
  const verdict = normalizePath(args.path)
  if (!verdict.ok) return refuse(verdict.reason, 'Tried to read a file it may not open')

  if (isWorkspacePath(verdict.path)) {
    const saved = await ctx.readWorkspace(verdict.path)
    if (saved === undefined) {
      return refuse(`Nothing saved at ${verdict.path}.`, `Looked for ${basename(verdict.path)}`)
    }
    return { ok: true, content: cap(saved), summary: `Read your ${basename(verdict.path)} note` }
  }

  if (args.from_container === true) {
    const content = await ctx.readContainerFile(verdict.path)
    if (content === undefined) {
      return refuse(`No file at ${verdict.path} in the running app.`, `Looked for ${basename(verdict.path)}`)
    }
    return { ok: true, content: cap(content), summary: `Read ${basename(verdict.path)}` }
  }

  const file = ctx.files().find(entry => entry.path === verdict.path)
  if (!file) {
    return refuse(
      `No file at ${verdict.path}. Use fs_list to see what exists.`,
      `Looked for ${basename(verdict.path)}`,
    )
  }
  return { ok: true, content: cap(file.content), summary: `Read ${basename(verdict.path)}` }
}

// ── fs_write / fs_batch_write ────────────────────────────────────────────────

type WriteEntry = { path: string; content: string }

/**
 * Validate a whole batch before applying any of it.
 *
 * All-or-nothing matters because a partially applied batch leaves the project in
 * a state neither the model nor the user asked for — half a refactor is worse
 * than none, and the model's next step would be reasoning about a file set that
 * never existed as a coherent whole.
 */
function validateBatch(raw: unknown): { ok: true; files: WriteEntry[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'files must be an array of {path, content}.' }
  if (raw.length === 0) return { ok: false, reason: 'files was empty — nothing to write.' }
  if (raw.length > MAX_BATCH_FILES) {
    return { ok: false, reason: `Too many files in one batch (max ${MAX_BATCH_FILES}). Split it.` }
  }

  const files: WriteEntry[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const item = entry as { path?: unknown; content?: unknown } | null
    const verdict = normalizePath(item?.path)
    if (!verdict.ok) return { ok: false, reason: `${verdict.reason} (nothing was written)` }
    if (typeof item?.content !== 'string') {
      return { ok: false, reason: `Content for ${verdict.path} must be a string (nothing was written).` }
    }
    if (byteLength(item.content) > MAX_FILE_BYTES) {
      return {
        ok: false,
        reason: `${verdict.path} is over the ${MAX_FILE_BYTES / 1024}KB limit — split it into smaller modules (nothing was written).`,
      }
    }
    if (seen.has(verdict.path)) {
      return { ok: false, reason: `${verdict.path} appears twice in one batch (nothing was written).` }
    }
    seen.add(verdict.path)
    files.push({ path: verdict.path, content: item.content })
  }
  return { ok: true, files }
}

function applyAll(ctx: ToolContext, files: WriteEntry[]): ToolResult {
  for (const file of files) ctx.applyFile(file.path, file.content)
  const paths = files.map(file => file.path)
  const bytes = files.reduce((total, file) => total + byteLength(file.content), 0)
  // Report size, never content: the model already knows what it wrote, and
  // echoing it would be re-sent on every later step.
  const content =
    files.length === 1
      ? `ok · ${bytes} bytes written to ${paths[0]}`
      : `ok · ${files.length} files written (${bytes} bytes): ${paths.join(', ')}`
  const summary = files.length === 1 ? `Wrote ${basename(paths[0]!)}` : `Wrote ${files.length} files`
  return { ok: true, content, summary, paths }
}

export async function fsWrite(
  ctx: ToolContext,
  args: { path?: unknown; content?: unknown },
): Promise<ToolResult> {
  const validated = validateBatch([{ path: args.path, content: args.content }])
  if (!validated.ok) return refuse(validated.reason, 'Tried to write a file it may not change')
  const target = validated.files[0]!
  if (isWorkspacePath(target.path)) {
    await ctx.writeWorkspace(target.path, target.content)
    return {
      ok: true,
      content: `ok · saved ${byteLength(target.content)} bytes to ${target.path}`,
      summary: `Saved a note`,
      // Deliberately no `paths`: workspace files are not part of the app, so
      // they must not appear in the turn's narration chips or the Build Story.
    }
  }
  return applyAll(ctx, validated.files)
}

export async function fsBatchWrite(ctx: ToolContext, args: { files?: unknown }): Promise<ToolResult> {
  const validated = validateBatch(args.files)
  if (!validated.ok) return refuse(validated.reason, 'Tried to write files it may not change')
  // Mixing app files and saved notes in one atomic batch would mean two stores
  // with no shared transaction — refuse rather than half-apply.
  const workspace = validated.files.filter(file => isWorkspacePath(file.path))
  if (workspace.length > 0 && workspace.length !== validated.files.length) {
    return refuse(
      'Save app files and .build/ notes in separate calls; they cannot be written together.',
      'Tried to mix app files and notes',
    )
  }
  if (workspace.length > 0) {
    for (const file of workspace) await ctx.writeWorkspace(file.path, file.content)
    return {
      ok: true,
      content: `ok · saved ${workspace.length} notes`,
      summary: `Saved ${workspace.length} notes`,
    }
  }
  return applyAll(ctx, validated.files)
}

// ── fs_delete ────────────────────────────────────────────────────────────────

/**
 * Delete one file.
 *
 * Worth having despite the extra actor surface: without it the agent physically
 * cannot finish a refactor. It writes `Card.tsx` to replace `OldCard.tsx` and the
 * old file lingers forever — eating the context budget every turn, showing in the
 * Files list, and **shipping to scoutos.live on the next publish**.
 *
 * Bounded hard: one path per call, no directories, and the guarded set refuses
 * with an explanation rather than a bare no.
 */
export async function fsDelete(ctx: ToolContext, args: { path?: unknown }): Promise<ToolResult> {
  const verdict = normalizePath(args.path)
  if (!verdict.ok) return refuse(verdict.reason, 'Tried to delete a file it may not touch')
  if (isWorkspacePath(verdict.path)) {
    if ((await ctx.readWorkspace(verdict.path)) === undefined) {
      return refuse(`Nothing saved at ${verdict.path}.`, `Looked for ${basename(verdict.path)}`)
    }
    await ctx.deleteWorkspace(verdict.path)
    return { ok: true, content: `ok · deleted ${verdict.path}`, summary: 'Deleted a note' }
  }
  if (UNDELETABLE.has(verdict.path)) {
    return refuse(
      `${verdict.path} is part of how the app runs — it can be changed but not removed.`,
      'Tried to delete a file the app needs',
    )
  }
  if (!ctx.files().some(file => file.path === verdict.path)) {
    return refuse(`There is no file at ${verdict.path}.`, `Looked for ${basename(verdict.path)}`)
  }
  ctx.removeFile(verdict.path)
  return {
    ok: true,
    content: `ok · deleted ${verdict.path}`,
    summary: `Deleted ${basename(verdict.path)}`,
    paths: [verdict.path],
  }
}

// ── exec ─────────────────────────────────────────────────────────────────────

/**
 * Commands the agent may run, and with which first argument.
 *
 * A note on what this boundary is and is not. The user's own `jsh` terminal can
 * already run anything, and the sandbox is trusted by design — so this is a
 * **reliability and visibility** boundary, not an airtight security one. What it
 * actually buys:
 *
 * - argv form (not a shell string) means no backgrounding, no pipes outliving
 *   the kill, and no `sh -c` hiding the real command from the trail and timeout;
 * - `npx` is restricted to `tsc` and `vite` because bare `npx <pkg>` downloads
 *   and executes arbitrary remote code with no artifact the user can see —
 *   strictly more capable than `node -e`, which is denied two lines below;
 * - `node <file>` is allowed but `node -e` is not, because a file had to be
 *   written first, and a write is chip-visible in chat and one click from the
 *   editor. That converts an invisible primitive into a visible artifact.
 *
 * `npm install` running postinstall scripts remains an accepted, recorded
 * residual risk: the product cannot work without it.
 */
const NPX_ALLOWED = new Set(['tsc', 'vite'])
const ALLOWED_COMMANDS = new Set(['npm', 'npx', 'node'])
const SHELL_METACHARACTERS = /[;|&><$`\n\r(){}[\]*?~!#]/

/** Long-running servers: the dev server is already up and hot-reloading. */
const DENIED_NPM_SCRIPTS = new Set(['dev', 'start', 'serve', 'preview'])

export type ExecVerdict =
  | { ok: true; command: string; args: string[]; install: boolean }
  | { ok: false; reason: string }

export function validateExec(rawCommand: unknown, rawArgs: unknown): ExecVerdict {
  const command = typeof rawCommand === 'string' ? rawCommand.trim() : ''
  if (!command) return { ok: false, reason: 'exec needs a "command".' }
  if (!ALLOWED_COMMANDS.has(command)) {
    return {
      ok: false,
      reason: `"${command}" is not available. You can run npm, npx (tsc or vite), and node.`,
    }
  }
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    return { ok: false, reason: 'exec "args" must be an array of strings.' }
  }
  const args = (rawArgs ?? []) as unknown[]
  if (!args.every(arg => typeof arg === 'string')) {
    return { ok: false, reason: 'Every entry in "args" must be a string.' }
  }
  const argv = args as string[]

  // Checked before the metacharacter sweep: an inline script almost always
  // contains parentheses, and the generic "no shell characters" reason would
  // hide the one that actually helps — write the file, then run it.
  if (command === 'node' && argv.some(arg => arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print')) {
    return {
      ok: false,
      reason:
        'Inline scripts are not available. Write the script to a file with fs_write and run `node <file>` so it is visible in the project.',
    }
  }

  for (const arg of argv) {
    if (SHELL_METACHARACTERS.test(arg)) {
      return {
        ok: false,
        reason: `"${arg}" contains shell characters. Commands run directly, not through a shell — pass plain arguments.`,
      }
    }
  }

  if (command === 'npm' && argv[0] === 'run' && DENIED_NPM_SCRIPTS.has(argv[1] ?? '')) {
    return {
      ok: false,
      reason:
        'The dev server is already running and reloads your changes automatically. To check your work run `npm run build` or `npx tsc --noEmit`.',
    }
  }
  if (command === 'npm' && DENIED_NPM_SCRIPTS.has(argv[0] ?? '')) {
    return {
      ok: false,
      reason:
        'The dev server is already running and reloads your changes automatically. To check your work run `npm run build` or `npx tsc --noEmit`.',
    }
  }
  if (command === 'npx') {
    const target = argv[0] ?? ''
    if (!NPX_ALLOWED.has(target)) {
      return {
        ok: false,
        reason: `npx can only run ${[...NPX_ALLOWED].join(' or ')} here. To add a package use \`npm install <name>\`.`,
      }
    }
    if (target === 'vite' && !argv.includes('build')) {
      return { ok: false, reason: 'Only `npx vite build` is available — the dev server is already running.' }
    }
  }
  const install = command === 'npm' && ['install', 'i', 'ci', 'add'].includes(argv[0] ?? '')
  return { ok: true, command, args: argv, install }
}

/** Head + tail, because `tsc` puts diagnostics first and the count last —
 * tail-only would hide the errors the agent needs to fix. */
export function clampOutput(output: string): string {
  if (output.length <= EXEC_HEAD_CHARS + EXEC_TAIL_CHARS) return output
  const head = output.slice(0, EXEC_HEAD_CHARS)
  const tail = output.slice(-EXEC_TAIL_CHARS)
  const elided = output.length - EXEC_HEAD_CHARS - EXEC_TAIL_CHARS
  return `${head}\n…[${elided} characters elided]…\n${tail}`
}

/** Trail copy that reports an *outcome*, not a status — the hero beat of a
 * verifying turn is "Typechecked — 3 problems", not "exec finished". */
export function execSummary(
  command: string,
  args: string[],
  exitCode: number,
  install: boolean,
  timedOut: boolean,
): string {
  if (timedOut) return 'Command took too long and was stopped'
  const ok = exitCode === 0
  if (install) return ok ? 'Installed dependencies' : 'Could not install dependencies'
  const isTypecheck = command === 'npx' && args[0] === 'tsc'
  const isBuild = (command === 'npm' && args[1] === 'build') || (command === 'npx' && args[0] === 'vite')
  if (isTypecheck) return ok ? 'Checked the code — no problems' : 'Checked the code — found problems'
  if (isBuild) return ok ? 'Built cleanly' : 'Build failed'
  return ok ? 'Ran a command' : 'A command failed'
}

/**
 * Serializes agent commands. A second `exec` in the same step is refused rather
 * than queued: two concurrent installs would race `node_modules`, and the model
 * gets a clearer signal from a refusal than from a mysterious delay.
 */
let execInFlight: { kill: () => void } | null = null

export function isExecRunning(): boolean {
  return execInFlight !== null
}

/** Kill any running agent command. Idempotent, and safe when nothing runs. */
export function killExec(): void {
  execInFlight?.kill()
  execInFlight = null
}

export async function exec(
  ctx: ToolContext,
  args: { command?: unknown; args?: unknown; timeout_ms?: unknown },
): Promise<ToolResult> {
  const verdict = validateExec(args.command, args.args)
  if (!verdict.ok) return refuse(verdict.reason, 'Tried to run a command it may not run')

  if (execInFlight) {
    return refuse(
      'Another command is already running this step. Wait for it and try again next step.',
      'Tried to run two commands at once',
    )
  }

  const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_EXEC_TIMEOUT_MS
  const timeoutMs = Math.min(Math.max(1_000, requested), MAX_EXEC_TIMEOUT_MS)
  const label = [verdict.command, ...verdict.args].join(' ')

  // Claim the slot synchronously, BEFORE any await. Setting it after
  // `await spawn` would let two calls in the same step both pass the guard
  // above and race two installs against node_modules.
  //
  // Until the process exists, `kill` records the intent so a killExec() landing
  // during boot/spawn is honored the moment there is something to kill.
  let killRequested = false
  let live: SpawnedProcess | null = null
  const slot = {
    kill: () => {
      killRequested = true
      live?.kill()
    },
  }
  execInFlight = slot

  // A command must see the files the agent just wrote, or `tsc` typechecks the
  // previous version and reports phantom errors.
  await ctx.flushWrites()

  let output = ''
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const proc = await ctx.spawn(verdict.command, verdict.args)
    live = proc
    if (killRequested) proc.kill()
    ctx.log(`[agent] ${label}`)
    proc.onOutput(chunk => {
      output += chunk
      ctx.log(chunk)
    })
    timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    const exitCode = await proc.exit

    const clamped = clampOutput(output)
    const summary = execSummary(verdict.command, verdict.args, exitCode, verdict.install, timedOut)
    if (timedOut) {
      // A timeout must be legible: report whatever arrived, not a blank.
      return {
        ok: false,
        content: `[timed out after ${Math.round(timeoutMs / 1000)}s]\n${clamped}`,
        summary,
      }
    }
    return {
      ok: exitCode === 0,
      content: `[exit ${exitCode}]\n${clamped}`,
      summary,
      // Only a *successful* install clears the pending-install flag; a failed
      // one must still get the turn-end retry.
      installed: verdict.install && exitCode === 0,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return refuse(`Could not run ${label}: ${message}`, 'A command could not start')
  } finally {
    if (timer) clearTimeout(timer)
    // Only release our own claim: a killExec() followed by a new exec must not
    // have its slot cleared by this one's unwinding.
    if (execInFlight === slot) execInFlight = null
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/** Parse the provider's `arguments` string. A malformed blob is a recoverable
 * tool error, not a crash — the model gets told and can retry. */
function parseArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export async function runTool(ctx: ToolContext, name: string, argsJson: string): Promise<ToolResult> {
  const args = parseArgs(argsJson)
  if (!args) {
    return refuse(`Arguments for ${name} were not valid JSON. Send a JSON object.`, 'Sent a malformed request')
  }
  switch (name) {
    case 'fs_list':
      return fsList(ctx, args)
    case 'fs_read':
      return fsRead(ctx, args)
    case 'fs_write':
      return fsWrite(ctx, args)
    case 'fs_batch_write':
      return fsBatchWrite(ctx, args)
    case 'fs_delete':
      return fsDelete(ctx, args)
    case 'exec':
      return exec(ctx, args)
    default:
      // Includes the web tools in BYOK mode, which are never offered there.
      return refuse(`${name} is not available.`, 'Asked for a tool that is not available')
  }
}

// ── tool specs ───────────────────────────────────────────────────────────────

/**
 * The client-side tool set, in OpenAI function format.
 *
 * Descriptions are written for the model, not the user, and they carry the
 * *why* wherever a rule would otherwise look arbitrary — a model that
 * understands the dev server is already running does not try to start it.
 */
export const CLIENT_TOOL_SPECS = [
  {
    type: 'function' as const,
    function: {
      name: 'fs_list',
      description:
        "List the project's files with their sizes. Start here when you don't know what exists.",
      parameters: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional path prefix, e.g. "src/components/".' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fs_read',
      description:
        'Read a project file. Read before you rewrite — never guess at a file you have not seen. Set from_container to read build output instead of source.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root, e.g. "src/App.tsx".' },
          from_container: {
            type: 'boolean',
            description: 'Read from the running app (build artifacts, logs) rather than the project source.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fs_write',
      description:
        'Write one file, replacing it entirely. Send the complete file, never a fragment or a diff. Use fs_batch_write for a related set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
          content: { type: 'string', description: 'The complete file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fs_batch_write',
      description:
        'Write several related files at once. All of them save together or none do, so a refactor never lands half-applied. Prefer this over several fs_write calls.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'The files to write together.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string', description: 'The complete file content.' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fs_delete',
      description:
        'Delete one file. Use it when a refactor makes a file obsolete — a leftover file keeps shipping with the app. Files the app needs to run cannot be deleted.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'exec',
      description:
        "Run a command in the project's Node environment and read its real output. This is how you check your own work: `npx tsc --noEmit` to typecheck, `npm run build` to build, `npm install <pkg>` to add a dependency. Available commands are npm, npx (tsc or vite), and node. Do not start the dev server — it is already running and reloads your changes. Verify before you hand back.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'npm, npx, or node.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments, e.g. ["tsc", "--noEmit"]. Passed directly, not through a shell.',
          },
          timeout_ms: { type: 'number', description: `Optional, default ${DEFAULT_EXEC_TIMEOUT_MS}, max ${MAX_EXEC_TIMEOUT_MS}.` },
        },
        required: ['command'],
      },
    },
  },
]
