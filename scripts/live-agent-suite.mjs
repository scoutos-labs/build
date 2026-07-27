// Live-model suite: several harder turns in ONE session, so chat history,
// project state, and the container accumulate the way they do for a real user.
//
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/live-agent-suite.mjs
//   LIVE_MODEL=qwen/qwen3.6-35b-a3b node scripts/live-agent-suite.mjs
//
// Spends real money. Each turn is capped by the actor's step budget; the suite
// reports per-turn steps, provider calls, wall time, files touched, and whether
// the agent verified — the numbers S1 and S4 need.
//
// The key comes from gitignored .env (un-prefixed, so vite never bundles it),
// is injected at runtime as a BYOK user would, and is redacted from all output.
import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const OUT = join(process.cwd(), 'scripts', '.smoke', 'live')
await mkdir(OUT, { recursive: true })
const MODEL = process.env.LIVE_MODEL ?? 'anthropic/claude-sonnet-4.6'

/**
 * Ordered to escalate, and to strain a different part of the harness each time.
 * Turn 3 is the one that matters most: a dependency the project does not have,
 * which exercises package.json -> pkg_dirty -> exactly one npm install.
 */
const ALL_TURNS = [
  {
    label: 'multi-file feature',
    prompt:
      'Replace the starter page with a simple task list: a Header component, a TaskList component, and an App that puts them together. Keep it in separate files.',
    watch: 'fs_batch_write across several files',
  },
  {
    label: 'edit existing code',
    prompt:
      'Make the task list actually work: typing in an input and pressing enter should add a task, and clicking a task should cross it out.',
    watch: 'reads its own earlier work before changing it',
  },
  {
    label: 'new dependency',
    prompt: 'Use the date-fns library to show the time each task was added, like "2 minutes ago".',
    watch: 'package.json -> exactly one npm install',
  },
]
// LIVE_TURNS=3 runs just the last one, etc.
const TURNS = process.env.LIVE_TURNS
  ? ALL_TURNS.slice(0, Number(process.env.LIVE_TURNS))
  : ALL_TURNS

async function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  const env = await readFile('.env', 'utf-8')
  const match = env.match(/^OPENROUTER_API_KEY=(.+)$/m)
  if (!match) throw new Error('OPENROUTER_API_KEY not found in .env')
  return match[1].trim()
}
const KEY = await readKey()
const redact = text => String(text).split(KEY).join('sk-or-<redacted>')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()

let providerCalls = 0
const previewErrors = []
page.on('request', r => {
  if (r.url().includes('openrouter.ai')) providerCalls++
})
page.on('pageerror', e => console.log('  [pageerror]', redact(e).slice(0, 200)))
page.on('console', m => {
  const text = redact(m.text())
  // The dev server restarting mid-turn is advisory A6; count it rather than
  // assuming it never happens.
  if (text.includes('[preview error]')) previewErrors.push(text.slice(0, 120))
})

const bridge = fn => page.evaluate(`(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  ${fn}
})()`)

console.log(`\n▸ model ${MODEL}   ▸ ${TURNS.length} turns in one session\n`)

await page.goto(BASE)
await page.waitForSelector('.app', { timeout: 20000 })
await page.evaluate(([key, model]) => {
  globalThis.__liveKey = key
  globalThis.__liveModel = model
}, [KEY, MODEL])
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: globalThis.__liveKey, model: globalThis.__liveModel, job: 'standard' })`)
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 8000 })
const optOut = await page.$('text=Just describe it instead')
if (optOut) {
  await optOut.click()
  await page.waitForSelector('.interviewMsg', { state: 'detached', timeout: 5000 })
}

process.stdout.write('▸ waiting for the WebContainer')
for (let i = 0; i < 90; i++) {
  const ready = await page.evaluate(
    () => !!document.querySelector('iframe[title="preview"]')?.getAttribute('src'),
  )
  if (ready) break
  process.stdout.write('.')
  await page.waitForTimeout(2000)
}
console.log(' ready\n')

const results = []
let shot = 0

for (const turn of TURNS) {
  const callsBefore = providerCalls
  const errorsBefore = previewErrors.length
  console.log(`── ${turn.label} ──`)
  console.log(`   "${turn.prompt.slice(0, 78)}${turn.prompt.length > 78 ? '…' : ''}"`)
  console.log(`   watching: ${turn.watch}`)

  const startedAt = Date.now()
  await page.fill('.chat textarea', turn.prompt)
  // Send becomes "Working..." while a turn runs, so wait for it to come back
  // before starting the next one.
  await page.waitForSelector('button:has-text("Send")', { timeout: 60000 })
  await page.click('button:has-text("Send")')

  // Wait for THIS turn to start before waiting for it to finish — the previous
  // turn's summary is still on screen at this moment, and polling for it
  // immediately would declare the new turn instantly complete.
  await page
    .waitForFunction(() => !document.querySelector('.trailSummary'), { timeout: 20000 })
    .catch(() => {})

  let seen = ''
  let finished = false
  for (let i = 0; i < 180; i++) {
    const state = await page.evaluate(() => ({
      line: document.querySelector('.thinking')?.textContent?.trim() ?? '',
      done: !!document.querySelector('.trailSummary'),
    }))
    if (state.line && state.line !== seen) {
      seen = state.line
      console.log(`     · ${state.line}`)
    }
    if (state.done) {
      finished = true
      break
    }
    await page.waitForTimeout(2000)
  }
  const elapsed = (Date.now() - startedAt) / 1000

  // Expand for the receipts. Re-query rather than reusing a handle: the trail
  // re-renders as the turn settles and a stale handle detaches.
  const expand = async () => {
    try {
      await page.click('.trailSummary', { timeout: 3000 })
      await page.waitForTimeout(400)
    } catch {
      /* no summary (unfinished turn) — receipts stay collapsed */
    }
  }
  await expand()
  const info = await page.evaluate(() => ({
    summary: document.querySelector('.trailCount')?.textContent?.trim() ?? '(unfinished)',
    rows: [...document.querySelectorAll('.trailStep')].map(r => r.textContent.trim()),
    reply: [...document.querySelectorAll('.msg.assistant')].pop()?.textContent?.trim() ?? '',
    files: (globalThis.__buildProjectFiles ?? []).map(f => f.path),
  }))
  shot += 1
  await page.screenshot({ path: join(OUT, `suite-${shot}-${turn.label.replace(/\s+/g, '-')}.png`) })
  await expand() // collapse again so the next turn starts clean

  results.push({
    label: turn.label,
    finished,
    steps: info.rows.length,
    calls: providerCalls - callsBefore,
    elapsed,
    verified: info.rows.some(r => /Checked the code|Built cleanly|Installed/.test(r)),
    // Read from the trail, not the console: the console counter missed real
    // installs the trail recorded, and the trail is what the user sees.
    installs: info.rows.filter(r => /Installed dependencies/.test(r)).length,
    previewErrors: previewErrors.length - errorsBefore,
    batched: info.rows.some(r => /Wrote \d+ files/.test(r)),
    summary: info.summary,
    rows: info.rows,
    reply: info.reply,
    fileCount: info.files.length,
  })
  console.log(`   → ${info.summary}  (${elapsed.toFixed(0)}s, ${providerCalls - callsBefore} calls)\n`)
  await page.waitForTimeout(1500)
}

console.log('═══ suite summary ═══════════════════════════════════')
console.log('turn                    steps  calls   wall  verified  batched  installs  prev-err')
for (const r of results) {
  console.log(
    `${r.label.padEnd(22)} ${String(r.steps).padStart(5)} ${String(r.calls).padStart(6)} ${(r.elapsed.toFixed(0) + 's').padStart(6)} ${(r.verified ? 'yes' : 'no').padStart(9)} ${(r.batched ? 'yes' : 'no').padStart(8)} ${String(r.installs).padStart(9)} ${String(r.previewErrors).padStart(9)}`,
  )
}
const verifiedCount = results.filter(r => r.verified).length
console.log(`\nS1 verification rate: ${verifiedCount}/${results.length} turns ran a check`)
console.log(`final project: ${results.at(-1)?.fileCount} files`)

for (const r of results) {
  console.log(`\n── ${r.label} receipts`)
  for (const row of r.rows) console.log(`   · ${row}`)
  console.log(`   reply: ${redact(r.reply).slice(0, 220).replace(/\n/g, ' ')}`)
}

await context.close()
await browser.close()
process.exit(results.every(r => r.finished) ? 0 : 1)
