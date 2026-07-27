import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT_TOOL_SPECS,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_BATCH_FILES,
  MAX_EXEC_TIMEOUT_MS,
  MAX_FILE_BYTES,
  UNDELETABLE,
  clampOutput,
  exec,
  execSummary,
  fsBatchWrite,
  fsDelete,
  fsList,
  fsRead,
  fsWrite,
  isExecRunning,
  killExec,
  normalizePath,
  runTool,
  validateExec,
  type ProjectFile,
  type SpawnedProcess,
  type ToolContext,
} from './agent-tools'

/** Let queued microtasks (flushWrites, spawn) resolve. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A controllable fake process. */
function fakeProcess(opts: { exitCode?: number; output?: string; hang?: boolean } = {}) {
  let resolveExit: (code: number) => void = () => {}
  const exit = new Promise<number>(resolve => {
    resolveExit = resolve
  })
  let handler: ((chunk: string) => void) | undefined
  const proc: SpawnedProcess & { killed: boolean; emit(chunk: string): void } = {
    killed: false,
    exit,
    onOutput(next) {
      handler = next
      if (opts.output) next(opts.output)
    },
    kill() {
      this.killed = true
      resolveExit(143)
    },
    emit(chunk: string) {
      handler?.(chunk)
    },
  }
  if (!opts.hang) queueMicrotask(() => resolveExit(opts.exitCode ?? 0))
  return proc
}

function makeContext(
  files: ProjectFile[] = [],
  overrides: Partial<ToolContext> & { process?: ReturnType<typeof fakeProcess> } = {},
) {
  const applied: { path: string; content: string }[] = []
  const removed: string[] = []
  const logs: string[] = []
  const spawned: { command: string; args: string[] }[] = []
  const flushes: number[] = []
  let current = [...files]

  const ctx: ToolContext = {
    files: () => current,
    applyFile(path, content) {
      applied.push({ path, content })
      const index = current.findIndex(file => file.path === path)
      if (index === -1) current.push({ path, content })
      else current[index] = { path, content }
    },
    removeFile(path) {
      removed.push(path)
      current = current.filter(file => file.path !== path)
    },
    async readContainerFile(path) {
      return path === 'dist/index.js' ? 'built output' : undefined
    },
    async flushWrites() {
      flushes.push(applied.length)
    },
    async spawn(command, args) {
      spawned.push({ command, args })
      return overrides.process ?? fakeProcess()
    },
    log(line) {
      logs.push(line)
    },
    ...overrides,
  }
  return { ctx, applied, removed, logs, spawned, flushes, files: () => current }
}

beforeEach(() => {
  killExec()
})

describe('normalizePath — the single path policy', () => {
  it('accepts ordinary relative paths', () => {
    expect(normalizePath('src/App.tsx')).toEqual({ ok: true, path: 'src/App.tsx' })
    expect(normalizePath('  BRAIN.md  ')).toEqual({ ok: true, path: 'BRAIN.md' })
  })

  it.each([
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/system.ini', 'windows drive'],
    ['../secrets.txt', 'parent escape'],
    ['src/../../etc/passwd', 'nested parent escape'],
    ['src\\App.tsx', 'backslash'],
    ['src//App.tsx', 'empty segment'],
    ['./src/App.tsx', 'dot segment'],
    ['', 'empty'],
    ['   ', 'blank'],
  ])('refuses %s (%s)', path => {
    const verdict = normalizePath(path)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0)
  })

  it('refuses a null byte', () => {
    expect(normalizePath('src/App\0.tsx').ok).toBe(false)
  })

  it('refuses non-strings', () => {
    expect(normalizePath(undefined).ok).toBe(false)
    expect(normalizePath(42).ok).toBe(false)
    expect(normalizePath(null).ok).toBe(false)
  })

  it.each(['node_modules/react/index.js', 'dist/index.js', '.git/config', '.cache/x', 'coverage/lcov.info'])(
    'refuses generated path %s',
    path => {
      const verdict = normalizePath(path)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/generated/)
    },
  )

  it.each(['.env', '.env.local', '.env.production', 'server.pem', 'private.key', 'cert.p12', 'id_rsa', '.npmrc'])(
    'refuses secret-bearing path %s',
    path => {
      // Denied rather than approval-gated: strictly stronger, and the env-var
      // channel the locked decision would gate does not exist in the app.
      const verdict = normalizePath(path)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/secrets|keys/)
    },
  )

  it('allows a file that merely mentions env in its name', () => {
    expect(normalizePath('src/environment.ts').ok).toBe(true)
    expect(normalizePath('src/env-utils.ts').ok).toBe(true)
  })
})

describe('fs_list', () => {
  it('returns paths with sizes, sorted', () => {
    const { ctx } = makeContext([
      { path: 'src/b.ts', content: 'xx' },
      { path: 'src/a.ts', content: 'x' },
    ])
    const result = fsList(ctx, {})
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toEqual([
      { path: 'src/a.ts', bytes: 1 },
      { path: 'src/b.ts', bytes: 2 },
    ])
  })

  it('filters by prefix', () => {
    const { ctx } = makeContext([
      { path: 'src/a.ts', content: 'x' },
      { path: 'public/b.svg', content: 'y' },
    ])
    expect(JSON.parse(fsList(ctx, { prefix: 'src/' }).content)).toHaveLength(1)
  })

  it('says so plainly when nothing matches', () => {
    const { ctx } = makeContext([{ path: 'src/a.ts', content: 'x' }])
    const result = fsList(ctx, { prefix: 'nope/' })
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/No files under/)
  })

  it('never names a tool in its trail copy', () => {
    const { ctx } = makeContext([{ path: 'a.ts', content: 'x' }])
    expect(fsList(ctx, {}).summary).not.toMatch(/fs_list/)
  })
})

describe('fs_read', () => {
  it('returns file content from the project, not the container', async () => {
    const { ctx } = makeContext([{ path: 'src/App.tsx', content: 'export default App' }])
    const result = await fsRead(ctx, { path: 'src/App.tsx' })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('export default App')
  })

  it('points at fs_list when the file is missing', async () => {
    const { ctx } = makeContext([])
    const result = await fsRead(ctx, { path: 'src/Nope.tsx' })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/fs_list/)
  })

  it('reads build artifacts from the container when asked', async () => {
    const { ctx } = makeContext([])
    const result = await fsRead(ctx, { path: 'dist/index.js', from_container: true })
    // dist/ is denied for writes but readable as an artifact... except the path
    // policy denies it outright, which is the stricter and intended behavior.
    expect(result.ok).toBe(false)
  })

  it('reads a non-denied container path', async () => {
    const { ctx } = makeContext([], {
      async readContainerFile() {
        return 'npm log output'
      },
    })
    const result = await fsRead(ctx, { path: 'npm-debug.log', from_container: true })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('npm log output')
  })

  it('refuses a denied path', async () => {
    const { ctx } = makeContext([{ path: '.env', content: 'SECRET=1' }])
    const result = await fsRead(ctx, { path: '.env' })
    expect(result.ok).toBe(false)
    expect(result.content).not.toContain('SECRET')
  })
})

describe('fs_write', () => {
  it('applies through the project actor and reports size, never content', () => {
    const { ctx, applied } = makeContext([])
    const result = fsWrite(ctx, { path: 'src/App.tsx', content: 'hello' })
    expect(applied).toEqual([{ path: 'src/App.tsx', content: 'hello' }])
    expect(result.paths).toEqual(['src/App.tsx'])
    expect(result.content).toMatch(/^ok · 5 bytes/)
    // Echoing content would be re-sent to the model on every later step.
    expect(result.content).not.toContain('hello')
  })

  it('refuses a denied path without applying', () => {
    const { ctx, applied } = makeContext([])
    const result = fsWrite(ctx, { path: '.env', content: 'SECRET=1' })
    expect(result.ok).toBe(false)
    expect(applied).toEqual([])
  })

  it('refuses non-string content', () => {
    const { ctx, applied } = makeContext([])
    expect(fsWrite(ctx, { path: 'a.ts', content: 42 }).ok).toBe(false)
    expect(applied).toEqual([])
  })

  it('refuses a file over the size cap', () => {
    const { ctx, applied } = makeContext([])
    const result = fsWrite(ctx, { path: 'a.ts', content: 'x'.repeat(MAX_FILE_BYTES + 1) })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/limit/)
    expect(applied).toEqual([])
  })
})

describe('fs_batch_write — atomicity', () => {
  it('writes every file when all are valid', () => {
    const { ctx, applied } = makeContext([])
    const result = fsBatchWrite(ctx, {
      files: [
        { path: 'src/a.ts', content: 'a' },
        { path: 'src/b.ts', content: 'b' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(applied.map(entry => entry.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.summary).toBe('Wrote 2 files')
  })

  it('writes NOTHING when one entry is invalid', () => {
    // Half a refactor is worse than none: the model's next step would reason
    // about a file set that never existed as a coherent whole.
    const { ctx, applied } = makeContext([])
    const result = fsBatchWrite(ctx, {
      files: [
        { path: 'src/a.ts', content: 'a' },
        { path: '../escape.ts', content: 'b' },
        { path: 'src/c.ts', content: 'c' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/nothing was written/)
    expect(applied).toEqual([])
  })

  it('refuses duplicate paths in one batch', () => {
    const { ctx, applied } = makeContext([])
    const result = fsBatchWrite(ctx, {
      files: [
        { path: 'src/a.ts', content: 'first' },
        { path: 'src/a.ts', content: 'second' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/twice/)
    expect(applied).toEqual([])
  })

  it('refuses a batch over the file-count cap', () => {
    const { ctx, applied } = makeContext([])
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: 'x',
    }))
    expect(fsBatchWrite(ctx, { files }).ok).toBe(false)
    expect(applied).toEqual([])
  })

  it('refuses a non-array or empty files argument', () => {
    const { ctx } = makeContext([])
    expect(fsBatchWrite(ctx, { files: 'nope' }).ok).toBe(false)
    expect(fsBatchWrite(ctx, { files: [] }).ok).toBe(false)
    expect(fsBatchWrite(ctx, {}).ok).toBe(false)
  })
})

describe('validateExec — the allowlist', () => {
  it('allows the verification commands the product needs', () => {
    expect(validateExec('npx', ['tsc', '--noEmit']).ok).toBe(true)
    expect(validateExec('npm', ['run', 'build']).ok).toBe(true)
    expect(validateExec('npm', ['install', 'zod']).ok).toBe(true)
    expect(validateExec('node', ['scripts/seed.js']).ok).toBe(true)
    expect(validateExec('npx', ['vite', 'build']).ok).toBe(true)
  })

  it('flags install-shaped commands so the turn installs exactly once', () => {
    const verdict = validateExec('npm', ['install', 'zod'])
    expect(verdict.ok && verdict.install).toBe(true)
    const build = validateExec('npm', ['run', 'build'])
    expect(build.ok && build.install).toBe(false)
  })

  it('refuses commands outside the allowlist', () => {
    for (const command of ['sh', 'bash', 'curl', 'git', 'rm', 'python']) {
      expect(validateExec(command, []).ok).toBe(false)
    }
  })

  it('refuses starting a second dev server, and explains what to do instead', () => {
    for (const args of [['run', 'dev'], ['start'], ['run', 'preview']]) {
      const verdict = validateExec('npm', args)
      expect(verdict.ok).toBe(false)
      // The refusal must teach: a bare "no" invites a retry.
      if (!verdict.ok) expect(verdict.reason).toMatch(/tsc --noEmit|npm run build/)
    }
    expect(validateExec('npx', ['vite']).ok).toBe(false)
  })

  it('refuses node -e and friends', () => {
    // node <file> is allowed because the file had to be written first, and a
    // write is chip-visible; an inline script leaves no artifact at all.
    for (const flag of ['-e', '--eval', '-p', '--print']) {
      const verdict = validateExec('node', [flag, 'console.log(1)'])
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/fs_write/)
    }
  })

  it('restricts npx to tsc and vite', () => {
    // Bare `npx <pkg>` downloads and runs arbitrary remote code with no visible
    // artifact — strictly more capable than the node -e we deny above.
    for (const pkg of ['create-react-app', 'shadcn@latest', 'cowsay', 'http-server']) {
      const verdict = validateExec('npx', [pkg])
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/npm install/)
    }
  })

  it('refuses shell metacharacters in any argument', () => {
    for (const arg of ['a;b', 'a|b', 'a&b', 'a>b', 'a<b', '$(x)', '`x`', 'a\nb', 'a*b', 'a~b']) {
      const verdict = validateExec('npm', ['run', arg])
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/shell characters/)
    }
  })

  it('refuses a missing command or non-string args', () => {
    expect(validateExec(undefined, []).ok).toBe(false)
    expect(validateExec('npm', 'install').ok).toBe(false)
    expect(validateExec('npm', [42]).ok).toBe(false)
  })
})

describe('exec', () => {
  it('flushes queued writes before spawning, so tsc sees what was just written', async () => {
    // Otherwise the command typechecks the previous version and reports
    // phantom errors the agent then "fixes".
    const { ctx, flushes, spawned } = makeContext([])
    fsWrite(ctx, { path: 'src/App.tsx', content: 'x' })
    await exec(ctx, { command: 'npx', args: ['tsc', '--noEmit'] })
    expect(flushes).toEqual([1])
    expect(spawned).toEqual([{ command: 'npx', args: ['tsc', '--noEmit'] }])
  })

  it('returns the exit code and real output', async () => {
    const proc = fakeProcess({ exitCode: 2, output: 'src/App.tsx(3,1): error TS1005' })
    const { ctx } = makeContext([], { process: proc })
    const result = await exec(ctx, { command: 'npx', args: ['tsc', '--noEmit'] })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('[exit 2]')
    expect(result.content).toContain('error TS1005')
  })

  it('streams output to the terminal with an [agent] prefix', async () => {
    const proc = fakeProcess({ output: 'building...' })
    const { ctx, logs } = makeContext([], { process: proc })
    await exec(ctx, { command: 'npm', args: ['run', 'build'] })
    expect(logs[0]).toBe('[agent] npm run build')
    expect(logs).toContain('building...')
  })

  it('marks a successful install so the turn does not install twice', async () => {
    const { ctx } = makeContext([], { process: fakeProcess({ exitCode: 0 }) })
    const result = await exec(ctx, { command: 'npm', args: ['install', 'zod'] })
    expect(result.installed).toBe(true)
  })

  it('does NOT mark a failed install as installed', async () => {
    // Otherwise the turn-end retry is suppressed and the project is left
    // missing the dependency the model just added.
    const { ctx } = makeContext([], { process: fakeProcess({ exitCode: 1 }) })
    const result = await exec(ctx, { command: 'npm', args: ['install', 'zod'] })
    expect(result.installed).toBe(false)
  })

  it('kills and reports legibly on timeout', async () => {
    vi.useFakeTimers()
    try {
      const proc = fakeProcess({ hang: true, output: 'partial work' })
      const { ctx } = makeContext([], { process: proc })
      const pending = exec(ctx, { command: 'npm', args: ['run', 'build'], timeout_ms: 1_000 })
      await vi.advanceTimersByTimeAsync(1_500)
      const result = await pending
      expect(proc.killed).toBe(true)
      expect(result.ok).toBe(false)
      // Legible, not blank: whatever arrived is still reported.
      expect(result.content).toMatch(/\[timed out after 1s\]/)
      expect(result.content).toContain('partial work')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps a requested timeout to the maximum', async () => {
    vi.useFakeTimers()
    try {
      const proc = fakeProcess({ hang: true })
      const { ctx } = makeContext([], { process: proc })
      const pending = exec(ctx, { command: 'npm', args: ['run', 'build'], timeout_ms: 10 * 60_000 })
      await vi.advanceTimersByTimeAsync(MAX_EXEC_TIMEOUT_MS + 100)
      const result = await pending
      expect(result.content).toMatch(/timed out after 180s/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('soft-refuses a second concurrent command', async () => {
    const proc = fakeProcess({ hang: true })
    const { ctx } = makeContext([], { process: proc })
    const first = exec(ctx, { command: 'npm', args: ['run', 'build'] })
    await settle()
    const second = await exec(ctx, { command: 'npx', args: ['tsc'] })
    expect(second.ok).toBe(false)
    expect(second.content).toMatch(/already running/)
    proc.kill()
    await first
  })

  it('killExec stops a running command and clears the slot', async () => {
    const proc = fakeProcess({ hang: true })
    const { ctx } = makeContext([], { process: proc })
    const pending = exec(ctx, { command: 'npm', args: ['run', 'build'] })
    // The slot is claimed synchronously; let flushWrites and spawn settle so a
    // real process exists to kill.
    expect(isExecRunning()).toBe(true)
    await settle()
    killExec()
    expect(proc.killed).toBe(true)
    await pending
    expect(isExecRunning()).toBe(false)
  })

  it('honors a kill that lands while the command is still starting', async () => {
    // AbortAgent can arrive between the claim and the spawn resolving; the kill
    // must not be dropped on the floor.
    const proc = fakeProcess({ hang: true })
    const { ctx } = makeContext([], { process: proc })
    const pending = exec(ctx, { command: 'npm', args: ['run', 'build'] })
    killExec() // before spawn has resolved
    await settle()
    await pending
    expect(proc.killed).toBe(true)
    expect(isExecRunning()).toBe(false)
  })

  it('reports a spawn failure rather than throwing', async () => {
    const { ctx } = makeContext([], {
      async spawn() {
        throw new Error('container not booted')
      },
    })
    const result = await exec(ctx, { command: 'npm', args: ['run', 'build'] })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/container not booted/)
    expect(isExecRunning()).toBe(false)
  })

  it('refuses a denied command without spawning anything', async () => {
    const { ctx, spawned } = makeContext([])
    const result = await exec(ctx, { command: 'rm', args: ['-rf', 'src'] })
    expect(result.ok).toBe(false)
    expect(spawned).toEqual([])
  })
})

describe('clampOutput', () => {
  it('keeps short output whole', () => {
    expect(clampOutput('short')).toBe('short')
  })

  it('keeps the head as well as the tail', () => {
    // tsc puts diagnostics first and the count last — tail-only would hide the
    // errors the agent actually needs.
    const output = `FIRST${'x'.repeat(20_000)}LAST`
    const clamped = clampOutput(output)
    expect(clamped.startsWith('FIRST')).toBe(true)
    expect(clamped.endsWith('LAST')).toBe(true)
    expect(clamped).toMatch(/characters elided/)
    expect(clamped.length).toBeLessThan(output.length)
  })
})

describe('execSummary — outcomes, not statuses', () => {
  it('reports what the check found', () => {
    expect(execSummary('npx', ['tsc', '--noEmit'], 0, false, false)).toBe('Checked the code — no problems')
    expect(execSummary('npx', ['tsc', '--noEmit'], 2, false, false)).toBe('Checked the code — found problems')
  })

  it('reports build outcomes', () => {
    expect(execSummary('npm', ['run', 'build'], 0, false, false)).toBe('Built cleanly')
    expect(execSummary('npm', ['run', 'build'], 1, false, false)).toBe('Build failed')
  })

  it('reports installs', () => {
    expect(execSummary('npm', ['install', 'zod'], 0, true, false)).toBe('Installed dependencies')
    expect(execSummary('npm', ['install', 'zod'], 1, true, false)).toBe('Could not install dependencies')
  })

  it('reports a timeout distinctly', () => {
    expect(execSummary('npm', ['run', 'build'], 143, false, true)).toMatch(/too long/)
  })

  it('never leaks a tool name or a raw command into trail copy', () => {
    const summaries = [
      execSummary('npx', ['tsc'], 0, false, false),
      execSummary('npm', ['run', 'build'], 1, false, false),
      execSummary('node', ['x.js'], 0, false, false),
    ]
    for (const summary of summaries) {
      expect(summary).not.toMatch(/exec|npx|npm|tsc|node/)
    }
  })
})

describe('runTool dispatch', () => {
  it('routes each tool name', async () => {
    const { ctx } = makeContext([{ path: 'a.ts', content: 'x' }])
    expect((await runTool(ctx, 'fs_list', '{}')).ok).toBe(true)
    expect((await runTool(ctx, 'fs_read', '{"path":"a.ts"}')).ok).toBe(true)
    expect((await runTool(ctx, 'fs_write', '{"path":"b.ts","content":"y"}')).ok).toBe(true)
    expect((await runTool(ctx, 'fs_batch_write', '{"files":[{"path":"c.ts","content":"z"}]}')).ok).toBe(true)
  })

  it('turns malformed arguments into a recoverable tool error', async () => {
    const { ctx } = makeContext([])
    const result = await runTool(ctx, 'fs_write', '{not json')
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/valid JSON/)
  })

  it('refuses a non-object arguments payload', async () => {
    const { ctx } = makeContext([])
    expect((await runTool(ctx, 'fs_write', '[1,2]')).ok).toBe(false)
  })

  it('refuses an unknown tool — including web tools, which BYOK never offers', async () => {
    const { ctx } = makeContext([])
    for (const name of ['web_fetch', 'web_search', 'web_post', 'made_up']) {
      const result = await runTool(ctx, name, '{}')
      expect(result.ok).toBe(false)
      expect(result.content).toMatch(/not available/)
    }
  })
})

describe('tool specs', () => {
  it('offers exactly the client tool set', () => {
    expect(CLIENT_TOOL_SPECS.map(spec => spec.function.name)).toEqual([
      'fs_list',
      'fs_read',
      'fs_write',
      'fs_batch_write',
      'fs_delete',
      'exec',
    ])
  })

  it('names no gated tool — every client tool runs unattended by design', () => {
    // "Trust the sandbox": fs_* and exec are never approval-gated. If a future
    // refactor adds a gate here, this test is the tripwire.
    const names = CLIENT_TOOL_SPECS.map(spec => spec.function.name)
    expect(names).not.toContain('web_post')
    for (const spec of CLIENT_TOOL_SPECS) {
      expect(spec.function.description.toLowerCase()).not.toMatch(/approv/)
    }
  })

  it('tells the model why it must not start the dev server', () => {
    const execSpec = CLIENT_TOOL_SPECS.find(spec => spec.function.name === 'exec')!
    expect(execSpec.function.description).toMatch(/already running/)
    expect(execSpec.function.description).toMatch(/tsc --noEmit/)
  })

  it('every spec has a description and a parameters object', () => {
    for (const spec of CLIENT_TOOL_SPECS) {
      expect(spec.type).toBe('function')
      expect(spec.function.description.length).toBeGreaterThan(20)
      expect(spec.function.parameters).toBeTruthy()
    }
  })

  it('the default exec timeout is under the max', () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBeLessThanOrEqual(MAX_EXEC_TIMEOUT_MS)
  })
})

describe('undeletable set', () => {
  it('protects the entry module and the database bridge', () => {
    // A delete of any of these breaks the app in a way the agent cannot recover
    // from, and the damage ships to scoutos.live on the next publish.
    for (const path of ['src/main.tsx', 'index.html', 'src/db.ts', 'zepto-bridge.js', 'server.js', 'vite.config.ts']) {
      expect(UNDELETABLE.has(path)).toBe(true)
    }
  })
})


describe('fs_delete', () => {
  it('removes a file through the project actor', () => {
    const { ctx, removed } = makeContext([{ path: 'src/OldCard.tsx', content: 'x' }])
    const result = fsDelete(ctx, { path: 'src/OldCard.tsx' })
    expect(result.ok).toBe(true)
    expect(removed).toEqual(['src/OldCard.tsx'])
    expect(result.paths).toEqual(['src/OldCard.tsx'])
    expect(result.summary).toBe('Deleted OldCard.tsx')
  })

  it('refuses a file the app needs to run, and says why', () => {
    // A bare "no" invites a retry; these are writable but not removable.
    for (const path of ['src/main.tsx', 'index.html', 'src/db.ts', 'package.json', 'vite.config.ts']) {
      const { ctx, removed } = makeContext([{ path, content: 'x' }])
      const result = fsDelete(ctx, { path })
      expect(result.ok).toBe(false)
      expect(result.content).toMatch(/part of how the app runs/)
      expect(removed).toEqual([])
    }
  })

  it('refuses a path the policy denies', () => {
    const { ctx, removed } = makeContext([])
    expect(fsDelete(ctx, { path: '.env' }).ok).toBe(false)
    expect(fsDelete(ctx, { path: '../escape.ts' }).ok).toBe(false)
    expect(removed).toEqual([])
  })

  it('refuses a file that does not exist rather than silently succeeding', () => {
    const { ctx, removed } = makeContext([{ path: 'a.ts', content: 'x' }])
    const result = fsDelete(ctx, { path: 'src/Ghost.tsx' })
    expect(result.ok).toBe(false)
    expect(removed).toEqual([])
  })

  it('routes through runTool', async () => {
    const { ctx, removed } = makeContext([{ path: 'src/Old.tsx', content: 'x' }])
    const result = await runTool(ctx, 'fs_delete', '{"path":"src/Old.tsx"}')
    expect(result.ok).toBe(true)
    expect(removed).toEqual(['src/Old.tsx'])
  })
})

describe('BYOK offers no web tools', () => {
  it('the client tool set the BYOK loop passes to the provider has no web tool', () => {
    // BYOK has no SSRF guard, no server-held search key, and no authenticated
    // caller. A model told about a tool it will not be offered calls it and
    // stalls, so the absence has to be structural, not conditional.
    const names = CLIENT_TOOL_SPECS.map(spec => spec.function.name)
    for (const web of ['web_search', 'web_fetch', 'web_post']) {
      expect(names).not.toContain(web)
    }
  })
})
