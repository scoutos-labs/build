// Visual smoke for the chat interview: the onboarding conversation that
// replaced the iframe wizard. Drives the real dev server.
//
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/smoke-interview.mjs
import { chromium } from 'playwright'
import { mkdir, rm, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const OUT = join(process.cwd(), 'scripts', '.smoke', 'interview')
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
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-3.5-sonnet' })`)
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 5000 })

// 1. Fresh project: the interview opens the conversation, full-screen chat.
await page.waitForSelector('.interviewMsg', { timeout: 5000 })
await snap('q1')
note('interview starts with question one',
  (await page.locator('.interviewMsg').first().textContent())?.includes('What do you want to build?') ?? false)
note('composer placeholder coaches with the example',
  ((await page.locator('.panel.chat textarea').getAttribute('placeholder')) ?? '').includes('booking app'))
note('stays in chat mode', await page.locator('.app.modeChat').count() === 1)
note('opt-out affordance on the first question only',
  await page.getByRole('button', { name: 'Just describe it instead' }).count() === 1)

// 2. Answering echoes the founder's words and advances the conversation.
await page.locator('.panel.chat textarea').fill('A dog-walking scheduler')
await page.locator('.panel.chat .actions button').first().click()
await page.waitForTimeout(300)
await snap('answered-q1')
note('answer echoes as a founder bubble',
  await page.locator('.msg.user.interviewMsg', { hasText: 'A dog-walking scheduler' }).count() === 1)
note('second question arrives',
  (await page.locator('.interviewMsg').last().textContent())?.includes('Who is it for?') ?? false)

// 3. A preview URL arriving mid-interview must not yank the chat away.
await bridge(`bridge.dispatchPreviewUrlChanged('${BASE}/')`)
await page.waitForTimeout(400)
note('mid-interview URL does not reveal the split', await page.locator('.app.modeChat').count() === 1)

// 4. Skip through to the recap.
for (let i = 0; i < 6; i++) {
  await page.getByRole('button', { name: 'Skip' }).click()
  await page.waitForTimeout(120)
}
await snap('recap')
note('recap speaks the plan back',
  (await page.locator('.interviewMsg').last().textContent())?.includes("Here's what I heard") ?? false)
note('recap carries the typed answer',
  (await page.locator('.interviewMsg').last().textContent())?.includes('A dog-walking scheduler') ?? false)

// 5. Build: the plan message persists and the split reveals.
await page.getByRole('button', { name: 'Build my app' }).click()
await page.waitForSelector('.app.modeSplit', { timeout: 5000 })
await page.waitForTimeout(400)
await snap('built-revealed')
note('build appends the persisted plan message',
  ((await page.locator('.msg.user').first().textContent()) ?? '').includes('Build an app for: A dog-walking scheduler'))
note('interview bubbles are gone', await page.locator('.interviewMsg').count() === 0)
note('the reveal lands at build start', await page.locator('.app.modeSplit').count() === 1)

// 6. Eligibility rules at the DOM level: history in, interview out — and back.
await bridge(`bridge.dispatchChatMessagesReplaced([{ role: 'user', content: 'existing history' }])`)
await page.waitForTimeout(300)
note('a project with history shows no interview', await page.locator('.interviewMsg').count() === 0)
await bridge(`bridge.dispatchChatMessagesReplaced([])`)
await page.waitForTimeout(300)
await snap('empty-project-reinterviews')
note('an empty never-built project restarts the interview',
  await page.locator('.interviewMsg').count() >= 1)

await context.close()
await browser.close()
for (const f of await readdir(OUT)) {
  if (f.endsWith('.webm')) {
    await rename(join(OUT, f), join(OUT, 'interview.webm'))
    console.log(`  🎥 ${join(OUT, 'interview.webm')}`)
  }
}
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
