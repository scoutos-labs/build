// Visual smoke test for the journey layout modes: drives the real dev server,
// records a WebM video, and screenshots each state.
//
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/smoke-layout-modes.mjs
//
// Output: scripts/.smoke/layout-modes/*.png and a .webm video.
import { chromium } from 'playwright'
import { mkdir, rm, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const OUT = join(process.cwd(), 'scripts', '.smoke', 'layout-modes')
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

// Non-managed boots with the model-settings modal open; configure a model so
// it closes and we get a clean view.
await bridge(`bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-3.5-sonnet' })`)
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 5000 })

// 1. Session boot: full-screen chat, workspace hidden, boot status visible.
await snap('boot-chat-mode')
note('starts in chat mode', await page.locator('.app.modeChat').count() === 1)
note('workspace hidden in chat mode', !(await page.locator('.workspace').isVisible()))
note('workspace stays mounted (identical DOM)', await page.locator('.workspace').count() === 1)
note('boot status line visible in chat', await page.locator('.bootStatus').isVisible())
note('segmented control visible in chat', await page.locator('.layoutSwitch').isVisible())
// chat must be usable BEFORE the container is ready: type + send enabled
await page.locator('.panel.chat textarea').fill('make me an app')
note('composer accepts input during boot', await page.locator('.panel.chat textarea').inputValue() === 'make me an app')
note('send button enabled during boot', !(await page.locator('.panel.chat .actions button').first().isDisabled()))
await page.locator('.panel.chat textarea').fill('')

// 2. The reveal: first preview URL auto-switches to split.
await bridge(`bridge.dispatchPreviewUrlChanged('${BASE}/')`)
await page.waitForSelector('.app.modeSplit', { timeout: 5000 })
await page.waitForTimeout(500)
await snap('reveal-split-mode')
note('first URL reveals split mode', await page.locator('.app.modeSplit').count() === 1)
note('code strip still hidden in split', await page.locator('.workspace.codeHidden').count() === 1)
const iframeId = await page.evaluate(() => {
  const el = document.querySelector('iframe[title="preview"]')
  if (!el) return null
  el.dataset.smokeIdentity = 'original'
  return 'original'
})
note('preview iframe mounted after reveal', iframeId === 'original')

// 3. Code mode via the segmented control: strip appears, iframe untouched.
await page.getByRole('button', { name: 'Code' }).click()
await page.waitForSelector('.app.modeBuilder .workspace:not(.codeHidden)', { timeout: 5000 })
await page.waitForTimeout(400)
await snap('builder-mode')
note('Code segment reveals files + editor + terminal',
  await page.locator('.bottom build-code-editor').count() === 1
    && await page.locator('.bottom build-terminal').count() === 1
    && await page.locator('.files').isVisible())

// 4. Back to Chat: everything hides, nothing unmounts, selection disarmed.
await page.getByRole('button', { name: 'Chat', exact: true }).click()
await page.waitForSelector('.app.modeChat', { timeout: 5000 })
await page.waitForTimeout(300)
await snap('back-to-chat')
note('manual chat: workspace hidden but mounted',
  !(await page.locator('.workspace').isVisible())
    && await page.locator('.workspace').count() === 1)

// 5. URL re-fire (crash restart) must NOT yank a manual chat choice.
await bridge(`bridge.dispatchPreviewUrlChanged('${BASE}/?refire')`)
await page.waitForTimeout(500)
note('url re-fire does not yank manual chat', await page.locator('.app.modeChat').count() === 1)

// 6. Preview error while strip hidden -> dot on the Code segment, no yank.
await page.getByRole('button', { name: 'App', exact: true }).click()
await page.waitForSelector('.app.modeSplit', { timeout: 5000 })
await bridge(`bridge.dispatchWebContainerLog('[preview error] ReferenceError: foo is not defined\\n')`)
await page.waitForSelector('.layoutSwitch .unreadDot', { timeout: 5000 })
await page.waitForTimeout(300)
await snap('error-badge-on-code-segment')
note('preview error badges the Code segment', await page.locator('.layoutSwitch .unreadDot').count() === 1)
note('layout not yanked by error', await page.locator('.app.modeSplit').count() === 1)

// 7. Entering Code clears the badge; iframe identity survived every switch.
await page.getByRole('button', { name: 'Code' }).click()
await page.waitForSelector('.app.modeBuilder', { timeout: 5000 })
await page.waitForTimeout(400)
await snap('code-clears-badge')
note('entering Code clears the badge', await page.locator('.layoutSwitch .unreadDot').count() === 0)
note('iframe never remounted across all switches',
  await page.evaluate(() => document.querySelector('iframe[title="preview"]')?.dataset.smokeIdentity) === 'original')

// 8. Small screen: chat mode is a single column.
await page.setViewportSize({ width: 720, height: 900 })
await page.getByRole('button', { name: 'Chat', exact: true }).click()
await page.waitForTimeout(300)
await snap('narrow-chat-mode')
note('narrow chat mode still shows the control', await page.locator('.layoutSwitch').isVisible())
await page.getByRole('button', { name: 'App', exact: true }).click()
await page.waitForTimeout(300)
await snap('narrow-split-mode')

await context.close() // flushes the video
await browser.close()

for (const f of await readdir(OUT)) {
  if (f.endsWith('.webm')) {
    await rename(join(OUT, f), join(OUT, 'layout-modes.webm'))
    console.log(`  🎥 ${join(OUT, 'layout-modes.webm')}`)
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
