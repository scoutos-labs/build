import { designGuidancePrompt } from './design-guidance'
import { buildSelectedElementPrompt, type SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'
import { FetchLLMClient } from './llm-client'
import type { ModelMessage as PortMessage, ToolCall } from './llm-port'

// `paths`: files the turn touched (assistant turns with patches); rides the
// saved message so the chat's narration chips survive reloads.
export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string; paths?: string[] }
export type AgentProvider = 'ollama' | 'openrouter'
export type AgentPatch = { path: string; content: string }
export type AgentResult = { reply: string; patches: AgentPatch[]; envVars?: Record<string, string> }


/**
 * Assemble the agent system prompt from named sections.
 *
 * Decomposed into sections so each is independently testable and the
 * prompt can be lazily built without recomputing static parts.
 *
 * The Rules block must stay in sync with server/src/prompt.ts (the managed
 * source of truth) — src/prompt-parity.test.ts enforces this, with
 * client-only rules declared there explicitly.
 */
export function buildSystemPrompt(): string {
  const header = [
    'You are an app-building agent inside a browser-only StackBlitz WebContainer.',
    'Return ONLY valid JSON with this exact shape: {"reply":"short user-facing summary","patches":[{"path":"src/main.tsx","content":"full file content"}]}',
  ].join('. ')

  const planning = 'Planning: For simple one-file changes, just do it. For broad, ambiguous, design-sensitive, or multi-file changes, understand the codebase first, plan your changes, then execute — verify each change makes sense before returning it.'

  const rules = [
    'Modify files by returning full replacement contents.',
    'Prefer Vite + React + TypeScript.',
    'Use Tailwind CSS for styling and shadcn/ui for components.',
    'Tailwind, PostCSS, and the cn() helper in src/lib/utils.ts are preconfigured; do not modify tailwind.config.js or postcss.config.js, and only change package.json to add a genuinely new dependency.',
    'For persistence, use the db client in src/db.ts; it calls the hyper-zepto data port that zepto-bridge.js serves at /api/db (mounted by vite.config.ts in dev and server.js in production). Never import hyper-zepto in browser code.',
    'Preserve vite.config.ts, zepto-bridge.js, and server.js (they host the database API and the production server) unless the user explicitly asks to change the backend.',
    'Do not use native Node modules, server-only packages, Docker, or external databases.',
    'Vite: pin to ^7.x. Vite 8+ uses rolldown WASM that crashes in WebContainers.',
    'Dependency versions must be peer-compatible. If adding packages, check their peer dep requirements.',
    'Keep changes small, coherent, and runnable.',
    'If changing dependencies, replace package.json too.',
    "Preserve src/build-inspector.ts and the './build-inspector' import unless the user explicitly asks to remove Build preview selection.",
    'Apply the bundled design guidance unless the user asks for a different brand or visual direction.',
    'Maintain BRAIN.md, the project\'s plain-language wiki: keep "## What & Why" describing the user\'s goals (change it only when the user changes their goals), keep "## How it works" a current plain-language summary of the app, record brand choices under "## Brand", and append dated entries under "## Decisions" when you make significant design or engineering choices.',
    'Keep BRAIN.md under 6,000 characters: prune superseded decisions and never paste code into it.',
    'Your user is usually a non-technical founder: write the reply in plain language, with no jargon and no file paths unless they ask.',
    'After a substantive change, end the reply with one short "Next:" sentence naming the most valuable next step for this app; when the user seems stuck, offer two or three concrete options instead of open-ended questions.',
    'On the first build, propose a brand that fits the user\'s stated style: an app name, a 3-5 color palette in hex, a one-line tone of voice, and a described (not generated) logo direction; record them under "## Brand" in BRAIN.md and apply the palette in the app.',
    'When the user asks for branding help later, update the "## Brand" section and the code together; never contradict the recorded brand silently.',
    'Secrets and API keys are set in the .env file; set them via the envVars field in your response.',
    'Never include markdown, prose, progress updates, or code fences outside the JSON object.',
  ]

  const verification = [
    'Verify imports resolve (no missing or wrong imports).',
    'Verify the code is syntactically valid.',
    'Verify all patches are complete file contents, not partial edits.',
    'Verify your reply is a useful, specific summary.',
  ]

  const contextRequest = 'If you need more context (a file is stubbed, or a referenced module is missing), return {"reply":"I need the full contents of X, Y to proceed.","patches":[]} and the system will send them.'

  return [
    header,
    '',
    planning,
    '',
    'Rules:',
    ...rules.map(r => `- ${r}`),
    '',
    'Self-verification (before returning):',
    ...verification.map(v => `- ${v}`),
    '',
    contextRequest,
    '',
    'Design guidance:',
    designGuidancePrompt(),
  ].join('\n')
}

// Backward-compatible constant for existing callers.
const JSON_SYSTEM_PROMPT = buildSystemPrompt()

type AgentArgs = {
  provider: AgentProvider
  apiKey?: string
  ollamaUrl?: string
  model: string
  userPrompt: string
  files: ProjectFile[]
  messages: ChatMessage[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
  envVars?: Record<string, string>
  signal?: AbortSignal
}

/**
 * Internal type alias — the port uses `ModelMessage` from llm-port;
 * we map ChatMessage → PortMessage before calling the LLM client.
 */
type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Context selection (mirror of server/src/prompt.ts, which is the source of
 * truth): under the budget the whole project ships; over it, files the
 * request plausibly touches stay full and the rest shrink to stubs.
 */
const FILE_CONTEXT_CHAR_BUDGET = 160_000
const STUB_LINES = 20
const STUB_MAX_CHARS = 1000
const ALWAYS_FULL = new Set(['package.json', 'vite.config.ts', 'zepto-bridge.js', 'server.js', 'index.html', 'src/db.ts', 'BRAIN.md'])
const SMALL_FILE_CHARS = 1500
const RECENT_MESSAGES = 6

/** BRAIN.md ships in full every request, so a runaway brain would eat the
 * context budget — past this cap it is truncated with a rewrite marker. */
const BRAIN_PATH = 'BRAIN.md'
const BRAIN_MAX_CHARS = 10_000
const BRAIN_TRUNCATION_NOTE = '\n\n[brain truncated — rewrite BRAIN.md so it is under 6000 characters]'

function guardBrainFile(file: ProjectFile): ProjectFile {
  if (file.path !== BRAIN_PATH || file.content.length <= BRAIN_MAX_CHARS) return file
  return { ...file, content: file.content.slice(0, BRAIN_MAX_CHARS) + BRAIN_TRUNCATION_NOTE }
}

type ContextFile = ProjectFile & { stub: boolean }

function basename(path: string) {
  return path.split('/').at(-1) ?? path
}

function selectContextFiles(args: {
  files: ProjectFile[]
  userPrompt: string
  messages: ChatMessage[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
}): ContextFile[] {
  const files = args.files.map(guardBrainFile)
  const total = files.reduce((sum, file) => sum + file.content.length, 0)
  if (total <= FILE_CONTEXT_CHAR_BUDGET) return files.map(file => ({ ...file, stub: false }))

  const mentionText = [
    args.userPrompt,
    ...args.messages.slice(-RECENT_MESSAGES).map(message => message.content),
    args.elementComment ?? '',
  ].join('\n')
  const elementMarkers = [args.selectedElement?.id, ...(args.selectedElement?.classes ?? [])].filter(
    (marker): marker is string => !!marker,
  )

  const priority = (file: ProjectFile): number => {
    if (ALWAYS_FULL.has(file.path)) return 0
    if (mentionText.includes(file.path) || mentionText.includes(basename(file.path))) return 1
    if (elementMarkers.some(marker => file.content.includes(marker))) return 2
    if (file.content.length <= SMALL_FILE_CHARS) return 3
    return 4
  }

  const ranked = files
    .map((file, index) => ({ file, index, priority: priority(file) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  let spent = 0
  const stubbed = new Set<string>()
  for (const entry of ranked) {
    if (spent + entry.file.content.length > FILE_CONTEXT_CHAR_BUDGET) {
      stubbed.add(entry.file.path)
    } else {
      spent += entry.file.content.length
    }
  }
  return files.map(file => ({ ...file, stub: stubbed.has(file.path) }))
}

const STUB_NOTE = `

Files marked [stub: ...] show only their first lines to fit the context budget. Never write a patch for a stubbed file based on its stub. If the change needs one, return {"reply":"<say which files you need, by exact path>","patches":[]} — files named in the conversation are sent in full on the next message.`

function projectContext(files: ContextFile[]) {
  return files
    .map(file => {
      if (!file.stub) return `--- ${file.path}\n${file.content}`
      const lines = file.content.split('\n')
      const shown = Math.min(STUB_LINES, lines.length)
      const head = lines.slice(0, shown).join('\n').slice(0, STUB_MAX_CHARS)
      return `--- ${file.path} [stub: first ${shown} of ${lines.length} lines]\n${head}`
    })
    .join('\n\n')
}

export async function call_agent(args: AgentArgs & { fetchFn?: typeof fetch }): Promise<AgentResult> {
  const fetchFn = args.fetchFn ?? globalThis.fetch.bind(globalThis)
  const messages: ModelMessage[] = []
  messages.push({ role: 'system', content: JSON_SYSTEM_PROMPT })
  if (args.files.length > 0) {
    const contextFiles = selectContextFiles(args)
    const note = contextFiles.some(file => file.stub) ? STUB_NOTE : ''
    messages.push({ role: 'system', content: `Current project files:\n\n${projectContext(contextFiles)}${note}` })
  }
  if (args.selectedElement && args.elementComment) {
    messages.push({ role: 'system', content: buildSelectedElementPrompt({ element: args.selectedElement, comment: args.elementComment }) })
  }
  if (args.envVars && Object.keys(args.envVars).length > 0) {
    const envLines = Object.entries(args.envVars)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${v}`)
    messages.push({ role: 'system', content: `Current env vars:\n${envLines.join('\n')}` })
  }
  for (const msg of args.messages) {
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
  }
  messages.push({ role: 'user', content: args.userPrompt })

  const llmMessages: PortMessage[] = messages.map(m => ({ role: m.role, content: m.content }))

  const client = new FetchLLMClient(fetchFn)
  const result = await client.call({
    provider: args.provider,
    model: args.model,
    messages: llmMessages,
    apiKey: args.apiKey,
    ollamaUrl: args.ollamaUrl,
    signal: args.signal,
    formatJson: args.provider === 'openrouter',
  })

  return {
    reply: result.reply,
    patches: result.patches,
    envVars: result.envVars,
  }
}

// Backward compatibility alias
export async function runAgent(args: AgentArgs & { fetchFn?: typeof fetch }): Promise<AgentResult> {
  return call_agent(args)
}

// ── Tool mode ────────────────────────────────────────────────────────────────
//
// The BYOK mirror of server/src/prompt.ts's tool-mode prompt.
// `src/prompt-parity.test.ts` compares the two verbatim.
//
// BYOK has no web tools — no SSRF guard, no server-held search key, no
// authenticated caller — so WEB_TOOL_RULES is deliberately absent here rather
// than conditional. A model told about a tool it will not be offered calls it
// and stalls.

export const TOOL_MODE_HEADER =
  'You are an app-building agent working inside a live browser development environment (a StackBlitz WebContainer). You have tools that read and write the project files and run commands in it. Use them to do the work, then tell the user what you did in plain language.'

export const TOOL_MODE_WORKFLOW = `How to work:
- DO THE WORK IN THIS TURN. If the user asked for a change, make it before you reply. Reading files is preparation, not an answer — never finish a turn having only looked around. Finish without changing anything only when the user asked a question rather than for a change.
- Read before you write, but read once. Use fs_list to see what exists and fs_read for the files you will actually change. You already have everything you have read this turn; re-reading the same file wastes a step you may need later.
- Write whole files. fs_write and fs_batch_write replace a file completely; send the full content, never a fragment or a diff.
- Group related changes into ONE fs_batch_write so a refactor cannot land half-applied.
- Check your work before you finish. After changing code, run \`npx tsc --noEmit\` (and \`npm run build\` for anything substantial) with exec, read the real errors, fix them, and check again. Do not hand back work you have not verified.
- exec runs exactly these and nothing else: \`npm install <package>\`, \`npm run build\`, \`npx tsc --noEmit\`, \`npx vite build\`, and \`node <file>\`. Anything else is refused and costs you a step, so do not guess at other commands.
- The dev server is already running and reloads automatically. Never start it.
- The starter page is a placeholder, not the user's app. Replace it with what they asked for rather than describing it back to them.
- Your final message is plain conversational text shown as-is in a chat bubble. No markdown, no asterisks, no backticks, no bullet lists, no headings — they render as literal characters. Two or three short sentences saying what changed, in the user's terms, not the codebase's. Do not name files unless the user asked about them, and never paste code.`

export const TOOL_MODE_RULES_HEADER = 'Rules:'

/** Shared with server/src/prompt.ts — the parity test compares this verbatim. */
export const SHARED_RULES = [
  'Prefer Vite + React + TypeScript.',
  'Use Tailwind CSS for styling and shadcn/ui for components.',
  'Tailwind, PostCSS, and the cn() helper in src/lib/utils.ts are preconfigured; do not modify tailwind.config.js or postcss.config.js, and only change package.json to add a genuinely new dependency.',
  'For persistence, use the db client in src/db.ts; it calls the hyper-zepto data port that zepto-bridge.js serves at /api/db (mounted by vite.config.ts in dev and server.js in production). Never import hyper-zepto in browser code.',
  'Preserve vite.config.ts, zepto-bridge.js, and server.js (they host the database API and the production server) unless the user explicitly asks to change the backend.',
  'Do not use native Node modules, server-only packages, Docker, or external databases.',
  'Vite: pin to ^7.x. Vite 8+ uses rolldown WASM that crashes in WebContainers.',
  'Dependency versions must be peer-compatible. If adding packages, check their peer dep requirements.',
  'Keep changes small, coherent, and runnable.',
  "Preserve src/build-inspector.ts and the './build-inspector' import unless the user explicitly asks to remove Build preview selection.",
  'Apply the bundled design guidance unless the user asks for a different brand or visual direction.',
  'Maintain BRAIN.md, the project\'s plain-language wiki: keep "## What & Why" describing the user\'s goals (change it only when the user changes their goals), keep "## How it works" a current plain-language summary of the app, record brand choices under "## Brand", and append dated entries under "## Decisions" when you make significant design or engineering choices.',
  'Keep BRAIN.md under 6,000 characters: prune superseded decisions and never paste code into it.',
  'Your user is usually a non-technical founder: write the reply in plain language, with no jargon and no file paths unless they ask.',
  'After a substantive change, end the reply with one short "Next:" sentence naming the most valuable next step for this app; when the user seems stuck, offer two or three concrete options instead of open-ended questions.',
  "On the first build, propose a brand that fits the user's stated style: an app name, a 3-5 color palette in hex, a one-line tone of voice, and a described (not generated) logo direction; record them under \"## Brand\" in BRAIN.md and apply the palette in the app.",
  'When the user asks for branding help later, update the "## Brand" section and the code together; never contradict the recorded brand silently.',
]

export function buildToolModePrompt(): string {
  return [
    TOOL_MODE_HEADER,
    '',
    TOOL_MODE_WORKFLOW,
    '',
    TOOL_MODE_RULES_HEADER,
    ...SHARED_RULES.map(rule => `- ${rule}`),
    '',
    'Design guidance:',
    designGuidancePrompt(),
  ].join('\n')
}

/**
 * A file listing rather than file contents.
 *
 * The change that makes multi-step turns affordable: with `fs_read` available,
 * step 0 ships a tree plus the few files that are always relevant, and the model
 * pulls what it needs.
 */
export function buildFileTree(files: { path: string; bytes: number }[]): string {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(file => `${file.path} (${file.bytes} bytes)`)
    .join('\n')
}

/**
 * Cap on the persona. It rides in EVERY turn, so unlike a skill body — pulled
 * only when relevant — its cost is unconditional.
 */
export const MAX_PERSONA_CHARS = 4000

/**
 * Frame the user's standing instructions as trusted guidance.
 *
 * Deliberately the opposite of `buildSkillsManifest`, and safe for exactly one
 * reason: `.build/agents/` is refused by every write tool, so only the account
 * owner can author this. See `src/agents.ts`.
 *
 * Lives here rather than in `agents.ts` so that BOTH prompt builders — this one
 * and `server/src/prompt.ts` — author the block themselves. The client sends
 * raw text; neither side accepts a pre-framed system message from the other.
 */
export function buildPersonaPrompt(source: string): string {
  const text = source.trim()
  if (!text) return ''
  const body =
    text.length > MAX_PERSONA_CHARS
      ? `${text.slice(0, MAX_PERSONA_CHARS)}\n\n[...truncated — the rest was over the ${MAX_PERSONA_CHARS}-character limit. Move standing detail into a skill instead.]`
      : text
  return [
    'The person you are building for wrote the following standing instructions.',
    'They apply to every turn. Follow them as you would the rules above; where they',
    'conflict with a specific request in this turn, the request wins.',
    '',
    body,
  ].join('\n')
}

/** Files worth shipping unasked on every step. */
const TOOL_MODE_ALWAYS_FULL = ['package.json', 'BRAIN.md', 'src/db.ts']

export type ToolModeStepArgs = {
  files: ProjectFile[]
  messages: ChatMessage[]
  userPrompt?: string
  selectedElement?: SelectedPreviewElement
  elementComment?: string
  /** Assistant tool_calls from the previous step, and their results. Providers
   * reject a `tool` message with no matching call, so the pair travels together. */
  toolCalls?: ToolCall[]
  toolResults?: { toolCallId: string; content: string }[]
  /** Names and descriptions of the user's saved skills — untrusted DATA. */
  skillsManifest?: string
  /** The user's standing instructions, RAW. Framed here rather than accepted
   * pre-framed, so the module that decides the trust wording is the same one
   * that emits it. Trusted because `.build/agents/` is not writable by any
   * tool; see `agents.ts`. */
  persona?: string
}

export function buildToolModeMessages(args: ToolModeStepArgs): PortMessage[] {
  const messages: PortMessage[] = [{ role: 'system', content: buildToolModePrompt() }]

  // Persona before skills: the user's own standing instructions outrank a saved
  // note, and the ordering says so before either is read.
  const persona = args.persona ? buildPersonaPrompt(args.persona) : ''
  if (persona) {
    messages.push({ role: 'system', content: persona })
  }
  if (args.skillsManifest) {
    messages.push({ role: 'system', content: args.skillsManifest })
  }

  if (args.files.length > 0) {
    const tree = args.files.map(file => ({ path: file.path, bytes: file.content.length }))
    messages.push({
      role: 'system',
      content: `The project contains these files. Use fs_read to see any of them:\n\n${buildFileTree(tree)}`,
    })
    for (const file of args.files) {
      if (!TOOL_MODE_ALWAYS_FULL.includes(file.path)) continue
      const guarded = guardBrainFile(file)
      messages.push({ role: 'system', content: `--- ${guarded.path}\n${guarded.content}` })
    }
  }
  if (args.selectedElement && args.elementComment) {
    messages.push({
      role: 'system',
      content: buildSelectedElementPrompt({
        element: args.selectedElement,
        comment: args.elementComment,
      }),
    })
  }
  for (const message of args.messages) {
    messages.push({ role: message.role as 'user' | 'assistant', content: message.content })
  }
  if (args.userPrompt) messages.push({ role: 'user', content: args.userPrompt })
  if (args.toolCalls?.length) {
    messages.push({ role: 'assistant', content: '', tool_calls: args.toolCalls })
  }
  for (const result of args.toolResults ?? []) {
    messages.push({ role: 'tool', content: result.content, tool_call_id: result.toolCallId })
  }
  return messages
}
