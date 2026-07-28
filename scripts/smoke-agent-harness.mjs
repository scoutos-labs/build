// Visual smoke test for the agent harness: drives a real multi-step turn
// against the real dev server, with the real tool executors running against the
// real project state. Nothing here is mocked below the model.
//
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/smoke-agent-harness.mjs
//
// Output: scripts/.smoke/agent-harness/*.png and a .webm video.
//
// The model is the only thing stood in for — the step responses are injected as
// if a provider had returned them, so the executors, the actor, the trail, the
// chips, the build log, and the file snapshot are all exercised for real. This
// is the test that catches desync between project.files and what the agent can
// see, which is the single hardest constraint in the design.
import { chromium } from 'playwright'
import { mkdir, rm, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const OUT = join(process.cwd(), 'scripts', '.smoke', 'agent-harness')
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const results = []
const note = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ name, ok })
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
})
const page = await context.newPage()
let shot = 0
const snap = async label => {
  shot += 1
  const file = join(OUT, `${String(shot).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file })
  console.log(`  📸 ${file}`)
}

const bridge = fn => page.evaluate(`(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  ${fn}
})()`)

await page.goto(BASE)
await page.waitForSelector('.app', { timeout: 20000 })

// Non-managed boots with the model-settings modal open; configure a model so it
// closes, then leave the onboarding interview so chat renders normally.
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-sonnet-4.6' })`)
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 5000 })
await page.waitForSelector('.interviewMsg', { timeout: 5000 })
await page.getByRole('button', { name: 'Just describe it instead' }).click()
await page.waitForSelector('.interviewMsg', { state: 'detached', timeout: 5000 })

// Reach the compiled actor so steps can be injected as a provider would return
// them.
await page.evaluate(async () => {
  const A = await import('/build/dev/javascript/build/build/actors/agent.mjs')
  const M = await import('/build/dev/javascript/build/build/msg.mjs')
  const L = await import('/build/dev/javascript/lustre/lustre.mjs')
  const G = await import('/build/dev/javascript/prelude.mjs')
  globalThis.__h = { A, M, toList: G.toList }
  globalThis.__go = m => globalThis.__buildGleamRuntime.send(L.dispatch(m))
})

const startTurn = () =>
  page.evaluate(() => {
    const { A, M } = globalThis.__h
    __go(M.Msg$Agent(A.Msg$AgentRequestStarted('smoke', Date.now())))
  })
const step = calls =>
  page.evaluate(calls => {
    const { A, M, toList } = globalThis.__h
    __go(
      M.Msg$Agent(
        A.Msg$AgentStepReturned(
          'smoke',
          toList(calls.map(c => A.ToolCall$ToolCall(c.id, c.name, c.args))),
          '',
        ),
      ),
    )
  }, calls)
const answer = reply =>
  page.evaluate(reply => {
    const { A, M, toList } = globalThis.__h
    __go(M.Msg$Agent(A.Msg$AgentStepReturned('smoke', toList([]), reply)))
  }, reply)

// ── 1. The agent can see the project ────────────────────────────────────────
// project.files is the source of truth and the container FS is a lossy replica,
// so the snapshot the tools read must be seeded from the model. An empty
// snapshot means the agent is blind to files it is about to rewrite.
await startTurn()
await step([{ id: 'c1', name: 'fs_list', args: '{}' }])
await page.waitForTimeout(600)

const listed = await page.evaluate(() => ({
  line: document.querySelector('.thinking')?.textContent?.trim() ?? '',
  snapshot: (globalThis.__buildProjectFiles ?? []).length,
}))
note('the agent sees the real project', listed.snapshot > 0, `${listed.snapshot} files in the snapshot`)
note('fs_list reports what it found', /Listed \d+ files/.test(listed.line), listed.line)
await snap('working-line')

// ── 2. The working line is ONE mutating row, not a growing list ─────────────
note(
  'working state is a single line, not a log',
  (await page.locator('.thinking').count()) === 1 &&
    (await page.locator('.trailSteps').count()) === 0,
)
note(
  'the working line speaks in verbs, not tool names',
  !/fs_list|fs_write|fs_read|exec\b/.test(listed.line),
  listed.line,
)

// ── 3. A real write lands through the one legal path ────────────────────────
await step([
  {
    id: 'c2',
    name: 'fs_write',
    args: JSON.stringify({
      path: 'src/SmokeProbe.tsx',
      content: 'export const SmokeProbe = () => null\n',
    }),
  },
])
await page.waitForTimeout(700)

const afterWrite = await page.evaluate(() => ({
  inSnapshot: (globalThis.__buildProjectFiles ?? []).some(f => f.path === 'src/SmokeProbe.tsx'),
}))
// S5: project.files and the tool snapshot must agree, or the editor, publish,
// autosave, and the next turn all read stale bytes.
note('a written file is immediately visible to the agent', afterWrite.inSnapshot)

// ── 4. The turn closes into one bubble, one log entry, correct chips ────────
await answer('Added a probe component. Next: wire it into the page.')
await page.waitForTimeout(600)

const closed = await page.evaluate(() => ({
  summary: document.querySelector('.trailCount')?.textContent?.trim() ?? '',
  collapsed: !document.querySelector('.trailSteps'),
  amber: document.querySelectorAll('.boltPulse').length,
  bubbles: [...document.querySelectorAll('.msg.assistant')].map(b => b.textContent.trim()),
  chips: [...document.querySelectorAll('.msgChip')].map(c => c.textContent.trim()),
}))
note('the trail collapses to a summary when the turn ends', closed.collapsed, closed.summary)
note('the summary counts steps and files', /2 steps · 1 file/.test(closed.summary), closed.summary)
note('one bubble for the whole turn', closed.bubbles.length === 1, closed.bubbles[0])
note(
  'chips name the files the turn touched',
  closed.chips.length === 1 && closed.chips[0] === 'src/SmokeProbe.tsx',
  closed.chips.join(', '),
)
// Amber is the working-state signature. Idle means none.
note('no amber once the turn is idle', closed.amber === 0)
await snap('collapsed-summary')

// ── 5. The receipts expand ──────────────────────────────────────────────────
await page.click('.trailSummary')
await page.waitForTimeout(300)
const expanded = await page.evaluate(() => ({
  steps: [...document.querySelectorAll('.trailStep')].map(s => s.textContent.trim()),
  composerOnScreen: (() => {
    const r = document.querySelector('.chat textarea')?.getBoundingClientRect()
    return r ? r.bottom <= window.innerHeight : false
  })(),
}))
note('expanding shows one row per step', expanded.steps.length === 2, expanded.steps.join(' | '))
note(
  'no step row names a tool',
  !expanded.steps.some(s => /fs_list|fs_write|fs_read|exec\b/.test(s)),
)
note('the composer stays on screen when expanded', expanded.composerOnScreen)
await snap('expanded-receipts')

// ── 6. A twelve-step turn must not push the composer off a phone ───────────
await page.setViewportSize({ width: 375, height: 780 })
await page.waitForTimeout(400)
const narrow = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > window.innerWidth,
  composerOnScreen: (() => {
    const r = document.querySelector('.chat textarea')?.getBoundingClientRect()
    return r ? r.bottom <= window.innerHeight : false
  })(),
}))
note('no horizontal overflow at 375px', !narrow.overflow)
note('the composer survives 375px with the trail expanded', narrow.composerOnScreen)
await snap('narrow-375')
await page.setViewportSize({ width: 1440, height: 900 })

// ── 7. Cancel is clean ──────────────────────────────────────────────────────
await startTurn()
await step([{ id: 'c3', name: 'fs_list', args: '{}' }])
await page.waitForTimeout(400)
await page.evaluate(async () => {
  const M = await import('/build/dev/javascript/build/build/msg.mjs')
  __go(M.Msg$CancelAgent())
})
await page.waitForTimeout(400)
const canceled = await page.evaluate(async () => {
  const agentJs = await import('/build/dev/javascript/build/gleam-externals/agent.mjs')
  return {
    pendingTurns: agentJs.pendingTurnCount(),
    working: document.querySelectorAll('.thinking').length,
  }
})
// A late step response must find nothing to continue from, or it would drive
// tool calls into a turn the user already stopped.
note('cancel leaves no turn state behind', canceled.pendingTurns === 0)
note('cancel clears the working line', canceled.working === 0)
await snap('after-cancel')

// ── 8. The model picker names jobs, never models ───────────────────────────
const picker = await page.evaluate(() => ({
  options: [...document.querySelectorAll('.jobPicker option')].map(o => o.textContent.trim()),
  selected: document.querySelector('.jobPicker select')?.value,
  leaksAModelId: /\//.test(document.querySelector('.jobPicker')?.textContent ?? ''),
}))
note('three jobs are offered', picker.options.length === 3, picker.options.join(' / '))
note('the picker never shows a model id', !picker.leaksAModelId)
note('the default job is the middle one', picker.selected === 'standard')

await page.selectOption('.jobPicker select', 'hard')
await page.waitForTimeout(300)
const picked = await page.evaluate(() => ({
  stored: globalThis.localStorage?.getItem('build.job'),
}))
note('the choice persists', picked.stored === 'hard')
await snap('job-picker')

// Ollama has no tool mode and no catalog, so a picker there would promise a
// choice that does not exist.
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'ollama', apiKey: '', model: 'glm-5:cloud' })`)
await page.waitForTimeout(300)
note(
  'no job picker for Ollama, which has no tool mode',
  (await page.locator('.jobPicker').count()) === 0,
)

// ── 9. web_post stops and asks ──────────────────────────────────────────────
// The one gated action: fs_*/exec run unattended because they cannot escape the
// WebContainer; this reaches out of it, so the user sees the whole request.
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-sonnet-4.6' })`)
await page.waitForTimeout(300)
await startTurn()
await page.evaluate(() => {
  const { A, M } = globalThis.__h
  __go(
    M.Msg$Agent(
      A.Msg$AgentApprovalRequested(
        'smoke',
        A.Approval$Approval('p1', 'https://hooks.example/notify', 'POST', '{"event":"built"}', ''),
      ),
    ),
  )
})
await page.waitForTimeout(300)
const card = await page.evaluate(() => {
  const el = document.querySelector('.approvalCard')
  return {
    present: !!el,
    headline: el?.querySelector('strong')?.textContent?.trim(),
    target: el?.querySelector('.approvalTarget')?.textContent?.trim(),
    exactBody: el?.querySelector('pre')?.textContent,
    buttons: [...(el?.querySelectorAll('button') ?? [])].map(b => b.textContent.trim()),
  }
})
note('web_post pauses for approval', card.present)
note('the card names the destination host', /hooks\.example/.test(card.headline ?? ''), card.headline)
note('the card shows the exact body, not a summary', card.exactBody === '{"event":"built"}', card.exactBody)
note('the card shows the method and full URL', /POST https:\/\/hooks\.example\/notify/.test(card.target ?? ''))
note('the user can send or refuse', card.buttons.length === 2, card.buttons.join(' / '))
await snap('web-post-approval')

// A turn that already read the web cannot send at all.
await page.evaluate(() => {
  const { A, M } = globalThis.__h
  __go(M.Msg$Agent(A.Msg$AgentApprovalResolved('smoke', false)))
  __go(
    M.Msg$Agent(
      A.Msg$AgentApprovalRequested(
        'smoke',
        A.Approval$Approval('p2', 'https://hooks.example/x', 'POST', '{}', 'read the web already'),
      ),
    ),
  )
})
await page.waitForTimeout(300)
const blocked = await page.evaluate(() => ({
  reason: document.querySelector('.approvalBlocked')?.textContent?.trim(),
  buttons: [...document.querySelectorAll('.approvalCard button')].map(b => b.textContent.trim()),
}))
note('a tainted turn shows no send button', blocked.buttons.length === 1, blocked.buttons.join(' / '))
note('and says why', (blocked.reason ?? '').length > 0, blocked.reason)
await snap('web-post-blocked')

// ── 10. Undo puts the project back ─────────────────────────────────────────
// The counterweight to unattended writing. Verified end to end because the
// obvious mechanism (project.RemountProject) silently discards its files and
// would have remounted a stale cache instead.
await page.reload()
await page.waitForSelector('.app', { timeout: 20000 })
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-sonnet-4.6' })`)
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 5000 })
const dismiss2 = await page.$('text=Just describe it instead')
if (dismiss2) { await dismiss2.click(); await page.waitForTimeout(400) }
await page.evaluate(async () => {
  const A = await import('/build/dev/javascript/build/build/actors/agent.mjs')
  const M = await import('/build/dev/javascript/build/build/msg.mjs')
  const L = await import('/build/dev/javascript/lustre/lustre.mjs')
  const G = await import('/build/dev/javascript/prelude.mjs')
  globalThis.__h = { A, M, toList: G.toList }
  globalThis.__go = m => globalThis.__buildGleamRuntime.send(L.dispatch(m))
})

const originalMain = await page.evaluate(
  () => (globalThis.__buildProjectFiles ?? []).find(f => f.path === 'src/main.tsx')?.content ?? '',
)
note('the project has a file to change', originalMain.length > 0)

// Start a turn carrying the current files as its snapshot, then overwrite one.
await page.evaluate(async () => {
  const { A, M, toList } = globalThis.__h
  const T = await import('/build/dev/javascript/build/build/pure/templates.mjs')
  const snapshot = toList(
    (globalThis.__buildProjectFiles ?? []).map(f => T.ProjectFile$ProjectFile(f.path, f.content)),
  )
  __go(M.Msg$Agent(A.Msg$AgentRequestStarted('undo', Date.now(), snapshot)))
  __go(M.Msg$Agent(A.Msg$AgentStepReturned('undo',
    toList([A.ToolCall$ToolCall('u1', 'fs_write',
      JSON.stringify({ path: 'src/main.tsx', content: '// CLOBBERED\n' }))]), '')))
})
await page.waitForTimeout(800)
await page.evaluate(() => {
  const { A, M, toList } = globalThis.__h
  __go(M.Msg$Agent(A.Msg$AgentStepReturned('undo', toList([]), 'Rewrote the entry file.')))
})
await page.waitForTimeout(500)

const clobbered = await page.evaluate(
  () => (globalThis.__buildProjectFiles ?? []).find(f => f.path === 'src/main.tsx')?.content ?? '',
)
note('the turn actually changed the file', clobbered.includes('CLOBBERED'))
note('undo is offered after a writing turn', (await page.locator('.trailUndo button').count()) === 1)
await snap('undo-offered')

await page.click('.trailUndo button')
await page.waitForTimeout(700)
const restored = await page.evaluate(
  () => (globalThis.__buildProjectFiles ?? []).find(f => f.path === 'src/main.tsx')?.content ?? '',
)
note('undo restores the exact pre-turn content', restored === originalMain)
note('undo is one-shot', (await page.locator('.trailUndo button').count()) === 0)
await snap('undo-applied')

// ── 11. fs_delete finishes a refactor ──────────────────────────────────────
// Without it a replaced file lingers forever — eating context every turn and
// shipping to scoutos.live on the next publish.
await page.evaluate(async () => {
  const { A, M, toList } = globalThis.__h
  const T = await import('/build/dev/javascript/build/build/pure/templates.mjs')
  const snapshot = toList(
    (globalThis.__buildProjectFiles ?? []).map(f => T.ProjectFile$ProjectFile(f.path, f.content)),
  )
  __go(M.Msg$Agent(A.Msg$AgentRequestStarted('del', Date.now(), snapshot)))
  __go(M.Msg$Agent(A.Msg$AgentStepReturned('del',
    toList([A.ToolCall$ToolCall('d0', 'fs_write',
      JSON.stringify({ path: 'src/Doomed.tsx', content: 'export const Doomed = () => null\n' }))]), '')))
})
await page.waitForTimeout(700)
note(
  'a file exists to delete',
  await page.evaluate(() => (globalThis.__buildProjectFiles ?? []).some(f => f.path === 'src/Doomed.tsx')),
)

await page.evaluate(() => {
  const { A, M, toList } = globalThis.__h
  __go(M.Msg$Agent(A.Msg$AgentStepReturned('del',
    toList([A.ToolCall$ToolCall('d1', 'fs_delete', JSON.stringify({ path: 'src/Doomed.tsx' }))]), '')))
})
await page.waitForTimeout(700)
note(
  'fs_delete removes it from the project',
  !(await page.evaluate(() => (globalThis.__buildProjectFiles ?? []).some(f => f.path === 'src/Doomed.tsx'))),
)

// Files the app needs to run are writable but not removable.
await page.evaluate(() => {
  const { A, M, toList } = globalThis.__h
  __go(M.Msg$Agent(A.Msg$AgentStepReturned('del',
    toList([A.ToolCall$ToolCall('d2', 'fs_delete', JSON.stringify({ path: 'src/main.tsx' }))]), '')))
})
await page.waitForTimeout(700)
note(
  'the entry file cannot be deleted',
  await page.evaluate(() => (globalThis.__buildProjectFiles ?? []).some(f => f.path === 'src/main.tsx')),
)
await page.evaluate(() => {
  const { A, M, toList } = globalThis.__h
  __go(M.Msg$Agent(A.Msg$AgentStepReturned('del', toList([]), 'Cleaned up.')))
})
await page.waitForTimeout(400)
await snap('fs-delete')

await context.close()
const videos = (await readdir(OUT)).filter(f => f.endsWith('.webm'))
for (const file of videos) {
  const target = join(OUT, 'agent-harness.webm')
  await rename(join(OUT, file), target)
  console.log(`  🎥 ${target}`)
}
await browser.close()

const passed = results.filter(r => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
