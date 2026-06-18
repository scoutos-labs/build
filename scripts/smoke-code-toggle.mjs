// Visual smoke test for the Code toggle: drives the real dev server, records a
// WebM video of the whole run, and captures a screenshot at each state so the
// rendering can be reviewed by eye (not just DOM assertions).
//
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/smoke-code-toggle.mjs
//
// Output: scripts/.smoke/code-toggle/*.png and a .webm video.
import { chromium } from 'playwright'
import { mkdir, rm, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const OUT = join(process.cwd(), 'scripts', '.smoke', 'code-toggle')
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

await page.goto(BASE)
await page.waitForSelector('.workspace', { timeout: 20000 })

// Non-managed boots with the model-settings modal open; configure a model so
// it closes and we get a clean view.
await page.evaluate(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-3.5-sonnet' })
})
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 5000 })

// Seed a project + some terminal logs + a preview so the revealed strip has
// real content to look at.
await page.evaluate(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  bridge.dispatchProjectReady?.()
  for (const line of [
    'WebContainer booted',
    'npm install … done in 4.2s',
    'VITE v7.3.2  ready in 312 ms',
    '➜  Local:   http://localhost:5173/',
  ]) bridge.dispatchWebContainerLog(line + '\n')
})
await page.waitForTimeout(400)

// 1. Default: code hidden, preview full height.
await snap('default-hidden')
const hidden = await page.locator('.workspace.codeHidden').count() === 1
const hiddenPreviewH = await page.locator('.preview').evaluate(el => el.clientHeight)
note('default is codeHidden', hidden)
note('bottom strip hidden by default', !(await page.locator('.bottom').isVisible()))

// 2. Reveal the strip.
await page.getByRole('button', { name: 'Show code and terminal' }).click()
await page.waitForSelector('.workspace:not(.codeHidden)', { timeout: 5000 })
await page.waitForTimeout(400)
await snap('code-shown')
const shownPreviewH = await page.locator('.preview').evaluate(el => el.clientHeight)
note('clicking reveals files + editor + terminal',
  await page.locator('.bottom build-code-editor').count() === 1
    && await page.locator('.bottom build-terminal').count() === 1
    && await page.locator('.files').isVisible())
note('preview taller when hidden than shown', hiddenPreviewH > shownPreviewH,
  `${hiddenPreviewH}px hidden vs ${shownPreviewH}px shown`)

// 3. Click a file in the files pane (editor should show its content).
const firstFile = page.locator('.files button').first()
await firstFile.click()
await page.waitForTimeout(400)
await snap('editor-file-selected')
note('editor renders file content', await page.locator('.bottom .cm-content').count() >= 1)

// 4. Hide again.
await page.getByRole('button', { name: 'Hide code and terminal' }).click()
await page.waitForSelector('.workspace.codeHidden', { timeout: 5000 })
await page.waitForTimeout(300)
await snap('hidden-again')
note('clicking again hides the strip', await page.locator('.workspace.codeHidden').count() === 1)

// 5. Preview error while hidden -> badge, no layout yank.
await page.evaluate(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  bridge.dispatchWebContainerLog('[preview error] ReferenceError: foo is not defined\n')
})
await page.waitForSelector('.codeToggle .unreadDot', { timeout: 5000 })
await page.waitForTimeout(300)
await snap('error-badge-while-hidden')
note('preview error badges the hidden toggle', await page.locator('.codeToggle .unreadDot').count() === 1)
note('layout stays hidden on error (no yank)', await page.locator('.workspace.codeHidden').count() === 1)

// Zoomed snapshot of just the preview bar so the badge is clearly visible.
await page.locator('.bar').screenshot({ path: join(OUT, `${String(++shot).padStart(2, '0')}-badge-closeup.png`) })

// 6. Open clears the badge; terminal shows the error line.
await page.getByRole('button', { name: 'Show code and terminal' }).click()
await page.waitForSelector('.workspace:not(.codeHidden)', { timeout: 5000 })
await page.waitForTimeout(500)
await snap('opened-badge-cleared')
note('opening clears the badge', await page.locator('.codeToggle .unreadDot').count() === 0)

await context.close() // flushes the video
await browser.close()

// Give the video a stable name.
for (const f of await readdir(OUT)) {
  if (f.endsWith('.webm')) {
    await rename(join(OUT, f), join(OUT, 'code-toggle.webm'))
    console.log(`  🎥 ${join(OUT, 'code-toggle.webm')}`)
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
