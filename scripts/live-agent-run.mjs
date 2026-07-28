// Live-model run for the agent harness.
//
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/live-agent-run.mjs "add a dark mode toggle to the header"
//
// This is the acceptance gate the unit tests and stubbed smokes cannot be: a
// REAL model, over the REAL network, driving the REAL WebContainer. It spends
// money — the model defaults to the cheapest curated tier and the run is capped
// by the actor's step budget.
//
// The key is read from .env (gitignored, un-prefixed so vite never bundles it)
// and injected at runtime, exactly as a BYOK user pasting it would. It is never
// logged, never screenshotted, and never written anywhere.
import { chromium } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const OUT = join(process.cwd(), 'scripts', '.smoke', 'live')
await mkdir(OUT, { recursive: true })

const PROMPT = process.argv[2] ?? 'Add a footer to the page with the text "Built with hyper".'
// Cheapest curated tier ($0.14/$1.00 per 1M as of 2026-07-27) and confirmed
// tool-capable by the live catalog spike.
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3.6-35b-a3b'

async function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  const env = await readFile('.env', 'utf-8')
  const match = env.match(/^OPENROUTER_API_KEY=(.+)$/m)
  if (!match) throw new Error('OPENROUTER_API_KEY not found in .env')
  return match[1].trim()
}
const KEY = await readKey()
// Redact defensively: nothing below should ever echo it, but a stray provider
// error body might.
const redact = text => String(text).split(KEY).join('sk-or-<redacted>')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()

const providerCalls = []
page.on('console', m => {
  const text = redact(m.text())
  if (m.type() === 'error' && !text.includes('favicon')) console.log('  [console]', text.slice(0, 200))
})
page.on('pageerror', e => console.log('  [pageerror]', redact(e).slice(0, 240)))
// Count real provider round trips without touching their contents.
page.on('request', r => {
  if (r.url().includes('openrouter.ai')) providerCalls.push({ at: Date.now() })
})

const bridge = fn => page.evaluate(`(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  ${fn}
})()`)

console.log(`\n▸ model  ${MODEL}`)
console.log(`▸ prompt "${PROMPT}"\n`)

await page.goto(BASE)
await page.waitForSelector('.app', { timeout: 20000 })
await page.evaluate(
  ([key, model]) => {
    // Same path a BYOK user takes; the key stays in this page only.
    globalThis.__liveKey = key
    globalThis.__liveModel = model
  },
  [KEY, MODEL],
)
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: globalThis.__liveKey, model: globalThis.__liveModel, job: 'quick' })`)
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 8000 })

const optOut = await page.$('text=Just describe it instead')
if (optOut) {
  await optOut.click()
  await page.waitForSelector('.interviewMsg', { state: 'detached', timeout: 5000 })
}

// exec only means anything once the container is up. Wait, but do not fail the
// run without it — a loop that cannot verify is still worth observing.
process.stdout.write('▸ waiting for the WebContainer')
let containerReady = false
for (let i = 0; i < 60; i++) {
  containerReady = await page.evaluate(
    () => !!document.querySelector('iframe[title="preview"]')?.getAttribute('src'),
  )
  if (containerReady) break
  process.stdout.write('.')
  await page.waitForTimeout(2000)
}
console.log(containerReady ? ' ready' : ' NOT ready (exec will fail; still running)')

const startedAt = Date.now()
await page.fill('.chat textarea', PROMPT)
await page.click('button:has-text("Send")')

// Poll until the turn ends rather than sleeping a fixed amount.
let lastTrail = ''
for (let i = 0; i < 150; i++) {
  const state = await page.evaluate(() => ({
    line: document.querySelector('.thinking')?.textContent?.trim() ?? '',
    done: !!document.querySelector('.trailSummary'),
    errored: [...document.querySelectorAll('.msg.assistant')]
      .some(b => b.textContent.trim().startsWith('Error:')),
  }))
  if (state.errored) {
    console.log('   · turn ended with an error')
    break
  }
  if (state.line && state.line !== lastTrail) {
    lastTrail = state.line
    console.log(`   · ${state.line}`)
  }
  if (state.done) break
  await page.waitForTimeout(2000)
}
const elapsedMs = Date.now() - startedAt

const result = await page.evaluate(() => {
  const trailRows = [...document.querySelectorAll('.trailStep')].map(r => r.textContent.trim())
  return {
    summary: document.querySelector('.trailCount')?.textContent?.trim() ?? '(no summary — turn did not finish)',
    reply: [...document.querySelectorAll('.msg.assistant')].pop()?.textContent?.trim() ?? '',
    chips: [...document.querySelectorAll('.msgChip')].map(c => c.textContent.trim()),
    trailRows,
    undoOffered: !!document.querySelector('.trailUndo button'),
    fileCount: (globalThis.__buildProjectFiles ?? []).length,
  }
})

// Expand the trail for the screenshot and the receipts.
const toggle = await page.$('.trailSummary')
if (toggle) {
  await toggle.click()
  await page.waitForTimeout(400)
}
const expanded = await page.evaluate(() =>
  [...document.querySelectorAll('.trailStep')].map(r => r.textContent.trim()),
)
await page.screenshot({ path: join(OUT, 'live-turn.png') })

const steps = expanded.length || result.trailRows.length
const verified = expanded.some(row => /Checked the code|Built cleanly|Installed/.test(row))

console.log('\n─── result ───────────────────────────────────────────')
console.log(`summary        ${result.summary}`)
console.log(`wall time      ${(elapsedMs / 1000).toFixed(1)}s`)
console.log(`provider calls ${providerCalls.length}`)
console.log(`trail steps    ${steps}`)
console.log(`files touched  ${result.chips.join(', ') || '(none)'}`)
console.log(`verified (S1)  ${verified ? 'YES — ran a check' : 'no'}`)
console.log(`undo offered   ${result.undoOffered ? 'yes' : 'no'}`)
console.log(`\nreceipts:`)
for (const row of expanded) console.log(`  · ${row}`)
console.log(`\nreply:\n  ${redact(result.reply).replace(/\n/g, '\n  ')}`)
console.log(`\n📸 ${join(OUT, 'live-turn.png')}`)

await context.close()
await browser.close()
