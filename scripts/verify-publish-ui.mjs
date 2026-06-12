// Headless-Chromium verification of the publish flow (PRD Phase 4): drives
// the real dev server with a faked publish backend via request interception
// and a faked managed-auth bridge (no Clerk). Run with the dev server up:
//   npx vite --port 5199 &   then   node scripts/verify-publish-ui.mjs
import { chromium } from 'playwright'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:5199'
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })

// ── Managed mode: full happy path ───────────────────────────────────────────
{
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(() => {
    globalThis.__buildManagedAuth = { getToken: async () => 'fake-token', signOut: async () => {} }
  })

  // Fake publish backend.
  let publishCalls = 0
  let statusPolls = 0
  await page.route('**/api/me', route => route.fulfill({ json: { plan: 'free', limit: 5, usage: 0, limitRemaining: 5 } }))
  await page.route('**/api/credentials', route => route.fulfill({ json: { scoutos: true } }))
  await page.route('**/api/deployments/*', route => {
    // First publish: nothing recorded. After a publish: record exists.
    if (publishCalls === 0) {
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'nope' } } })
    }
    return route.fulfill({ json: { subdomain: 'verify-app', url: 'https://verify-app.scoutos.live' } })
  })
  await page.route('**/api/publish', route => {
    publishCalls += 1
    const body = route.request().postDataJSON()
    if (!body?.projectId || !Array.isArray(body?.files) || body.files.length === 0) {
      return route.fulfill({ status: 400, json: { error: { code: 'bad_request', message: 'bad body' } } })
    }
    return route.fulfill({ json: { buildId: `bld_${publishCalls}`, subdomain: body.subdomain } })
  })
  await page.route('**/api/publish/*', route => {
    statusPolls += 1
    const status = statusPolls < 2 ? 'running' : 'deployed'
    return route.fulfill({
      json: { buildId: 'bld_x', status, url: status === 'deployed' ? 'https://verify-app.scoutos.live' : null, error: null, logs: null },
    })
  })

  await page.goto(BASE)
  await page.waitForSelector('.projectControls', { timeout: 20000 })

  // Give the app a saved project so the publish button enables.
  await page.evaluate(async () => {
    const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
    bridge.dispatchProjectCreated({
      id: 'proj_verify',
      name: 'Verify Project',
      files: [
        { path: 'package.json', content: '{"scripts":{"build":"vite build"}}' },
        { path: 'src/main.tsx', content: 'console.log(1)' },
      ],
      selectedPath: 'src/main.tsx',
    })
  })

  const publishButton = page.getByRole('button', { name: 'Publish to scoutos.live' })
  await publishButton.waitFor({ state: 'visible', timeout: 10000 })
  check('managed mode shows the publish button', true)

  // Invalid subdomain feedback appears before any network call.
  await publishButton.click()
  await page.waitForSelector('.publishPrompt', { timeout: 5000 })
  await page.fill('.publishPrompt input', 'Bad Name!')
  const callsBefore = publishCalls
  await page.click('.publishPrompt .modalActions button')
  await page.waitForSelector('.publishPrompt .status.error', { timeout: 5000 })
  check('invalid subdomain feedback is local', publishCalls === callsBefore,
    await page.textContent('.publishPrompt .status.error'))

  // Happy path: valid name → queued/running → deployed URL.
  await page.fill('.publishPrompt input', 'verify-app')
  await page.click('.publishPrompt .modalActions button')
  await page.waitForSelector('.publishDeployed a.publishedUrl', { timeout: 15000 })
  const url = await page.textContent('.publishDeployed a.publishedUrl')
  check('happy path reaches the deployed URL', url === 'https://verify-app.scoutos.live', url)

  // Republish: stored deployment skips the subdomain prompt.
  await page.click('[aria-label="Close publish dialog"]')
  statusPolls = 0
  await publishButton.click()
  await page.waitForSelector('.publishDeployed a.publishedUrl', { timeout: 15000 })
  const sawPromptAgain = await page.locator('.publishPrompt').count()
  check('republish skips the prompt and redeploys', sawPromptAgain === 0 && publishCalls === 2)

  await context.close()
}

// ── Managed mode: no_scoutos_key routes to settings ─────────────────────────
{
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(() => {
    globalThis.__buildManagedAuth = { getToken: async () => 'fake-token', signOut: async () => {} }
  })
  await page.route('**/api/me', route => route.fulfill({ json: { plan: 'free' } }))
  await page.route('**/api/credentials', route => route.fulfill({ json: { scoutos: false } }))
  await page.goto(BASE)
  await page.waitForSelector('.projectControls', { timeout: 20000 })
  await page.evaluate(async () => {
    const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
    bridge.dispatchProjectCreated({ id: 'proj_2', name: 'P2', files: [{ path: 'a', content: 'b' }], selectedPath: 'a' })
  })
  await page.getByRole('button', { name: 'Publish to scoutos.live' }).click()
  await page.waitForSelector('.publishNeedsKey', { timeout: 5000 })
  check('missing key renders an actionable message', true)
  await page.click('.publishNeedsKey button')
  const settingsVisible = await page.waitForSelector('[aria-labelledby="settings-title"]', { timeout: 5000 })
  check('"Open settings" lands on the account panel', !!settingsVisible)
  const keyField = await page.locator('.scoutosKey input[type="password"]').count()
  check('settings shows the ScoutOS key field', keyField === 1)
  await context.close()
}

// ── Non-managed mode: no publish affordances ────────────────────────────────
{
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(BASE)
  await page.waitForSelector('.projectControls', { timeout: 20000 })
  await page.evaluate(async () => {
    const bridge = await import('/build/dev/javascript/build/gleam-externals/runtime_bridge.mjs')
    bridge.dispatchProjectCreated({ id: 'proj_3', name: 'P3', files: [{ path: 'a', content: 'b' }], selectedPath: 'a' })
  })
  const publishButtons = await page.getByRole('button', { name: /Publish/ }).count()
  const keyFields = await page.locator('.scoutosKey').count()
  check('non-managed mode shows no publish affordances', publishButtons === 0 && keyFields === 0)
  await context.close()
}

await browser.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nAll publish UI checks passed')
