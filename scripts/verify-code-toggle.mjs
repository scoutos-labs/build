// Headless check for the code/terminal toggle (default hidden, reveal on
// click, error badge while hidden). Run with the dev server up:
//   VITE_MANAGED_AUTH=false npx vite --port 5199 &
//   node scripts/verify-code-toggle.mjs
import { chromium } from 'playwright'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
await page.goto(BASE)
await page.waitForSelector('.workspace', { timeout: 20000 })

// Non-managed boots with the model-settings modal open (no model configured),
// which would intercept clicks. Configure a model so it closes.
await page.evaluate(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  bridge.dispatchSettingsLoaded({ provider: 'openrouter', apiKey: 'sk-test', model: 'anthropic/claude-3.5-sonnet' })
})
await page.waitForSelector('.modalBackdrop', { state: 'detached', timeout: 5000 })

// Default: code panel hidden, preview owns the workspace.
check('workspace starts in codeHidden', await page.locator('.workspace.codeHidden').count() === 1)
check('bottom strip is not visible by default', !(await page.locator('.bottom').isVisible()))
const toggle = page.getByRole('button', { name: 'Show code and terminal' })
check('Code toggle is present in the preview bar', await toggle.count() === 1)

// Preview gets the full height when code is hidden vs shown.
const hiddenPreviewH = await page.locator('.preview').evaluate(el => el.clientHeight)
await toggle.click()
await page.waitForSelector('.workspace:not(.codeHidden)', { timeout: 5000 })
check('clicking reveals the bottom strip', await page.locator('.bottom').isVisible())
const shownPreviewH = await page.locator('.preview').evaluate(el => el.clientHeight)
check('preview is taller when code is hidden', hiddenPreviewH > shownPreviewH,
  `${hiddenPreviewH}px hidden vs ${shownPreviewH}px shown`)
check('editor and terminal render when shown',
  await page.locator('.bottom build-code-editor').count() === 1
    && await page.locator('.bottom build-terminal').count() === 1)

// Toggle back to hidden.
await page.getByRole('button', { name: 'Hide code and terminal' }).click()
await page.waitForSelector('.workspace.codeHidden', { timeout: 5000 })
check('clicking again hides the strip', await page.locator('.workspace.codeHidden').count() === 1)

// Error while hidden badges the toggle; it stays hidden (no layout yank).
await page.evaluate(async () => {
  const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
  bridge.dispatchWebContainerLog('[preview error] ReferenceError: x is not defined')
})
await page.waitForSelector('.codeToggle .unreadDot', { timeout: 5000 })
check('preview error badges the hidden toggle', await page.locator('.codeToggle .unreadDot').count() === 1)
check('layout stays hidden on error (no yank)', await page.locator('.workspace.codeHidden').count() === 1)

// Opening clears the badge.
await page.getByRole('button', { name: 'Show code and terminal' }).click()
await page.waitForSelector('.workspace:not(.codeHidden)', { timeout: 5000 })
check('opening clears the badge', await page.locator('.codeToggle .unreadDot').count() === 0)

await browser.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nAll code-toggle checks passed')
