import type { FileSystemTree } from '@webcontainer/api'

export type ProjectFile = { path: string; content: string }

export const starterFiles: ProjectFile[] = [
  {
    path: 'package.json',
    content: JSON.stringify(
      {
        scripts: { dev: 'vite --host 0.0.0.0', build: 'vite build', start: 'node server.js' },
        // vite pinned below 8: Vite 8 bundles via rolldown, whose WASM
        // binding (emnapi) crashes inside WebContainers.
        // Tailwind v3 + shadcn helpers are pre-baked so the agent doesn't have
        // to bootstrap styling on the first build (avoids a package.json
        // change → reinstall → dev-server restart / preview flicker).
        dependencies: {
          '@vitejs/plugin-react': '^4.3.4',
          'class-variance-authority': '^0.7.1',
          clsx: '^2.1.1',
          'hyper-zepto': '^0.1.0',
          'lucide-react': '^0.468.0',
          react: '^18.3.1',
          'react-dom': '^18.3.1',
          'tailwind-merge': '^2.6.0',
          // Pinned like everything else here. As `latest` this silently became
          // TypeScript 7 — the native rewrite — changing the compiler under
          // existing projects across a major boundary with no signal.
          typescript: '^5.7.2',
          vite: '^7.3.2',
        },
        devDependencies: {
          // Without these, `npx tsc --noEmit` — the check the agent is told to
          // run — buries any real error under a wall of TS7016/TS7026 noise
          // about React having no declarations.
          '@types/react': '^18.3.12',
          '@types/react-dom': '^18.3.1',
          autoprefixer: '^10.4.20',
          postcss: '^8.4.49',
          tailwindcss: '^3.4.17',
        },
        type: 'module',
      },
      null,
      2,
    ),
  },
  {
    // Load-bearing, not boilerplate. `npx tsc --noEmit` is the verify skill's
    // headline command, and with no tsconfig.json tsc does not typecheck at
    // all — it prints its help text and exits 1. Every turn that tried to
    // verify burned a step on a command that could not succeed.
    path: 'tsconfig.json',
    content: JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          // Declares `*.css` and friends, so a side-effect style import is not
          // reported as a missing module (TS2882).
          types: ['vite/client'],
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowJs: true,
          checkJs: false,
          resolveJsonModule: true,
          isolatedModules: true,
        },
        include: ['src', 'vite.config.ts'],
      },
      null,
      2,
    ),
  },
  { path: 'index.html', content: '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n' },
  {
    path: 'src/main.tsx',
    content: `import React from 'react'
import { createRoot } from 'react-dom/client'
import './build-inspector'
import './style.css'

function App() {
  return <main className="shell">
    <section className="intro">
      <div>
        <p className="eyebrow">Build starter</p>
        <h1>Welcome to Build.</h1>
        <p className="lede">Your app will appear here.</p>
      </div>
      <div className="hint">Answer the interview in the chat — or just describe your idea — and the agent replaces this page with your app.</div>
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
`,
  },
  {
    path: 'tailwind.config.js',
    content: `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
`,
  },
  {
    path: 'postcss.config.js',
    content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`,
  },
  {
    path: 'vite.config.ts',
    content: `import { defineConfig } from 'vite'
import { resolvePorts, zeptoDbHandler } from './zepto-bridge.js'

// Dev-server mount of the shared /api/db bridge (see zepto-bridge.js and
// src/db.ts). server.js mounts the same bridge in production.
export default defineConfig({
  plugins: [{
    name: 'zepto-api',
    configureServer(server) {
      server.middlewares.use('/api/db', zeptoDbHandler(resolvePorts()))
    },
  }],
})
`,
  },
  {
    path: 'zepto-bridge.js',
    content: `// Shared /api/db bridge: hyper-zepto runs in Node, so this code is mounted
// by the Vite dev server (vite.config.ts) in development and by server.js in
// production. The browser reaches it through src/db.ts.
import { createPorts } from 'hyper-zepto'

// On Scout Live the platform injects SCOUT_PORTS_URL pointing at the ports
// sidecar and ending in /_ports. hyper-zepto's remote adapters append
// /_ports themselves, so strip the suffix before using it as baseUrl; the
// sidecar injects auth, so no token is set. Without the env var (the
// WebContainer preview, plain local dev) fall back to local adapters.
export function resolvePorts() {
  let baseUrl = process.env.SCOUTOS_PORTS_URL || process.env.SCOUT_PORTS_URL || ''
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1)
  if (baseUrl.endsWith('/_ports')) baseUrl = baseUrl.slice(0, -'/_ports'.length)
  if (baseUrl) return createPorts({ mode: 'remote', baseUrl })
  return createPorts({ mode: 'local', dir: '.zepto' })
}

// Connect-style handler; expects req.url to hold the path after the /api/db
// mount, e.g. /todos/create.
export function zeptoDbHandler(ports) {
  async function run(collection, action, body) {
    switch (action) {
      case 'create': return ports.data.create(collection, body.doc)
      case 'get': return ports.data.get(collection, body.id)
      case 'find': return ports.data.find(collection, body.query ?? {})
      case 'update': return ports.data.update(collection, body.id, body.ops)
      case 'delete': return ports.data.delete(collection, body.id)
      case 'count': return ports.data.count(collection, body.filter ?? {})
      default: throw Object.assign(new Error(\`unknown db action: \${action}\`), { status: 404 })
    }
  }

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const [collection, action] = path.split('/').filter(Boolean)
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', async () => {
      try {
        const result = await run(collection, action, raw ? JSON.parse(raw) : {})
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result ?? null))
      } catch (error) {
        res.statusCode = typeof error?.status === 'number' ? error.status : 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: String(error?.message ?? error), code: error?.code }))
      }
    })
  }
}
`,
  },
  {
    path: 'server.js',
    content: `// Production server: serves the built dist/ statically and mounts the same
// /api/db bridge as the Vite dev server (see zepto-bridge.js). Run with
// \`npm run build && npm start\`. On Scout Live the bridge talks to the
// platform's managed ports; locally it falls back to the .zepto directory.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePorts, zeptoDbHandler } from './zepto-bridge.js'

const port = Number(process.env.PORT || 3000)
const distDir = fileURLToPath(new URL('./dist', import.meta.url))
const ports = resolvePorts()
const dbHandler = zeptoDbHandler(ports)

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function serveStatic(res, path) {
  // SPA routing: anything outside dist/ or missing falls back to index.html.
  const target = resolve(join(distDir, path === '/' ? 'index.html' : path))
  const safe = target.startsWith(distDir + '/') ? target : join(distDir, 'index.html')
  try {
    const content = await readFile(safe)
    res.setHeader('Content-Type', contentTypes[extname(safe)] ?? 'application/octet-stream')
    res.end(content)
  } catch {
    try {
      const index = await readFile(join(distDir, 'index.html'))
      res.setHeader('Content-Type', contentTypes['.html'])
      res.end(index)
    } catch {
      res.statusCode = 404
      res.end('Not found')
    }
  }
}

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (path === '/api/db' || path.startsWith('/api/db/')) {
    req.url = path.slice('/api/db'.length) || '/'
    return dbHandler(req, res)
  }
  void serveStatic(res, path)
}).listen(port, () => console.log(\`app listening on \${port} (db mode=\${ports.mode})\`))
`,
  },
  {
    path: 'src/db.ts',
    content: `// Browser client for the hyper-zepto data port served by vite.config.ts.
// Mongo-style documents: await db.create('todos', { title: 'hi' }), then
// await db.find('todos', { filter: { done: false }, sort: { title: 1 } }).
type Json = Record<string, unknown>

async function call(collection: string, action: string, body: Json) {
  const response = await fetch(\`/api/db/\${collection}/\${action}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error ?? \`db \${action} failed (\${response.status})\`)
  return data
}

export const db = {
  create: (collection: string, doc: Json) => call(collection, 'create', { doc }),
  get: (collection: string, id: string) => call(collection, 'get', { id }),
  find: (collection: string, query: Json = {}) => call(collection, 'find', { query }),
  update: (collection: string, id: string, ops: Json) => call(collection, 'update', { id, ops }),
  remove: (collection: string, id: string) => call(collection, 'delete', { id }),
  count: (collection: string, filter: Json = {}) => call(collection, 'count', { filter }),
}
`,
  },
  {
    path: 'src/lib/utils.ts',
    content: `import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

// shadcn/ui style helper: merges class names and resolves Tailwind conflicts.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`,
  },
  {
    path: 'src/build-inspector.ts',
    content: `const STYLE_ID = 'build-inspector-style'
let enabled = false
let hovered: Element | null = null

const style = document.createElement('style')
style.id = STYLE_ID
style.textContent = '[data-build-inspector-hover] { outline: 2px solid #6d8dff !important; outline-offset: 3px !important; cursor: crosshair !important; }'

function ensureStyle() {
  if (!document.getElementById(STYLE_ID)) document.head.appendChild(style)
}

function computedStylesFor(element: Element) {
  const styles = getComputedStyle(element)
  return {
    color: styles.color,
    backgroundColor: styles.backgroundColor,
    fontFamily: styles.fontFamily,
    fontSize: styles.fontSize,
    fontWeight: styles.fontWeight,
    display: styles.display,
    padding: styles.padding,
    margin: styles.margin,
    borderRadius: styles.borderRadius,
  }
}

function clearHover() {
  hovered?.removeAttribute('data-build-inspector-hover')
  hovered = null
}

function emitInspectorStatus(type: string) {
  window.parent.postMessage({ type }, '*')
}

emitInspectorStatus('BUILD_INSPECTOR_READY')

// Surface runtime crashes in the Build terminal; a white preview is
// undebuggable otherwise.
window.addEventListener('error', event => {
  window.parent.postMessage({ type: 'BUILD_PREVIEW_ERROR', message: String(event.message ?? event.error ?? 'Unknown error') }, '*')
})
window.addEventListener('unhandledrejection', event => {
  window.parent.postMessage({ type: 'BUILD_PREVIEW_ERROR', message: 'Unhandled rejection: ' + String(event.reason) }, '*')
})

function enable() {
  enabled = true
  ensureStyle()
  emitInspectorStatus('BUILD_INSPECTOR_ENABLED')
}

function disable() {
  enabled = false
  clearHover()
  emitInspectorStatus('BUILD_INSPECTOR_DISABLED')
}

window.addEventListener('message', event => {
  if (event.data?.type === 'BUILD_INSPECTOR_ENABLE') enable()
  if (event.data?.type === 'BUILD_INSPECTOR_DISABLE') disable()
})

document.addEventListener('mouseover', event => {
  if (!enabled || !(event.target instanceof Element)) return
  clearHover()
  hovered = event.target
  hovered.setAttribute('data-build-inspector-hover', 'true')
}, true)

document.addEventListener('click', event => {
  if (!enabled || !(event.target instanceof Element)) return
  event.preventDefault()
  event.stopPropagation()
  const element = event.target
  emitInspectorStatus('BUILD_INSPECTOR_CLICK_SEEN')
  const rect = element.getBoundingClientRect()
  window.parent.postMessage({
    type: 'BUILD_ELEMENT_SELECTED',
    element: {
      tagName: element.tagName,
      id: element.id,
      classes: Array.from(element.classList),
      textContent: (element.textContent || '').trim().slice(0, 1000),
      outerHTML: element.outerHTML.slice(0, 4000),
      boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      computedStyles: computedStylesFor(element),
    },
  }, '*')
  disable()
}, true)
`,
  },
  {
    path: 'src/style.css',
    content: `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color: #172033;
  background: radial-gradient(circle at top left, #eaf0ff 0, transparent 34rem), #f6f8fc;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body { margin: 0; }
button, textarea { font: inherit; }
.shell { max-width: 1040px; margin: 0 auto; padding: 56px 24px; }
.intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 24px;
  align-items: end;
  margin-bottom: 24px;
}
.eyebrow { color: #4169ff; font-size: .78rem; font-weight: 800; letter-spacing: .12em; margin: 0 0 12px; text-transform: uppercase; }
h1 { font-size: clamp(3rem, 9vw, 6.5rem); line-height: .88; letter-spacing: -.08em; margin: 0; }
.lede { color: #53627c; font-size: clamp(1.1rem, 2vw, 1.45rem); line-height: 1.45; max-width: 680px; margin: 22px 0 0; }
.hint { color: #53627c; background: rgba(255,255,255,.72); border: 1px solid #e0e7f5; border-radius: 22px; padding: 18px; box-shadow: 0 20px 60px rgba(29,53,87,.08); }
.panel { background: rgba(255,255,255,.9); border: 1px solid #dde6f6; border-radius: 32px; padding: 30px; box-shadow: 0 28px 90px rgba(29,53,87,.12); }
.progress { height: 10px; background: #edf2fb; border-radius: 999px; overflow: hidden; margin-bottom: 28px; }
.progress span { display: block; height: 100%; background: linear-gradient(90deg, #4169ff, #8b5cf6); border-radius: inherit; transition: width .25s ease; }
.step { color: #4169ff; font-size: .8rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; margin: 0 0 10px; }
h2 { color: #121a2b; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1; letter-spacing: -.045em; margin: 0; }
.helper { color: #66748e; font-size: 1.05rem; line-height: 1.55; margin: 14px 0 18px; }
textarea { box-sizing: border-box; width: 100%; min-height: 180px; resize: vertical; color: #172033; background: #fbfcff; border: 1px solid #d7e1f0; border-radius: 22px; padding: 18px; outline: none; box-shadow: inset 0 1px 0 rgba(255,255,255,.8); }
textarea:focus { border-color: #7894ff; box-shadow: 0 0 0 4px rgba(65,105,255,.12); }
.actions { display: flex; justify-content: space-between; gap: 12px; margin-top: 22px; }
button { border: 0; border-radius: 16px; background: #305cff; color: white; font-weight: 800; padding: 14px 20px; cursor: pointer; box-shadow: 0 12px 30px rgba(48,92,255,.28); }
button:hover { transform: translateY(-1px); }
button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
button.secondary { color: #30405f; background: #eef3fb; box-shadow: none; }
.summary { display: grid; gap: 12px; margin-top: 22px; }
.summary p { margin: 0; padding: 16px; border: 1px solid #e1e8f4; border-radius: 18px; background: #fbfcff; color: #4c5c78; line-height: 1.45; }
.summary strong { color: #172033; }
.footnote { color: #66748e; font-size: .92rem; line-height: 1.5; margin: 16px 0 0; }
@media (max-width: 760px) {
  .shell { padding: 32px 16px; }
  .intro { grid-template-columns: 1fr; }
  .panel { padding: 22px; border-radius: 24px; }
  .actions { flex-direction: column-reverse; }
  button { width: 100%; }
}
`,
  },
]

export function filesToTree(files: ProjectFile[]): FileSystemTree {
  const root: FileSystemTree = {}
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let node: FileSystemTree = root
    for (const part of parts.slice(0, -1)) {
      const existing = node[part]
      if (!existing || 'file' in existing) node[part] = { directory: {} }
      node = (node[part] as { directory: FileSystemTree }).directory
    }
    node[parts.at(-1)!] = { file: { contents: file.content } }
  }
  return root
}

export function upsertFile(files: ProjectFile[], path: string, content: string): ProjectFile[] {
  const normalized = path.replace(/^\/+/, '')
  const existing = files.find(file => file.path === normalized)
  if (existing) return files.map(file => file.path === normalized ? { path: normalized, content } : file)
  return [...files, { path: normalized, content }].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Backfill the pieces that make `npx tsc --noEmit` mean something.
 *
 * The starter now ships a tsconfig.json and React type declarations, but
 * projects created before that do not — and for them the agent's verify step
 * stays exactly as broken as it was: tsc prints its usage banner, exits 1, and
 * the loop reports that it checked its work. New-projects-only would have left
 * the entire existing user base on the broken path.
 *
 * Strictly additive, and silent when there is nothing to add — an untouched
 * project must come back as the SAME array so callers can use identity to
 * decide whether anything needs saving. `typescript` itself is deliberately not
 * repinned: an existing project already installed whatever it resolved, and
 * changing it would force a reinstall on open.
 */
export const VERIFY_TYPES = ['@types/react', '@types/react-dom'] as const

export function ensureVerifiable(files: ProjectFile[]): ProjectFile[] {
  // An empty project is about to be seeded from starterFiles; nothing to fix.
  if (files.length === 0) return files
  let next = files

  if (!next.some(file => file.path === 'tsconfig.json')) {
    const template = starterFiles.find(file => file.path === 'tsconfig.json')
    if (template) next = upsertFile(next, 'tsconfig.json', template.content)
  }

  const pkg = next.find(file => file.path === 'package.json')
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg.content) as Record<string, unknown>
      const starterPkg = JSON.parse(
        starterFiles.find(file => file.path === 'package.json')!.content,
      ) as { devDependencies: Record<string, string> }
      const dev = { ...((parsed.devDependencies as Record<string, string>) ?? {}) }
      const deps = (parsed.dependencies as Record<string, string>) ?? {}
      const missing = VERIFY_TYPES.filter(name => !dev[name] && !deps[name])
      if (missing.length > 0) {
        for (const name of missing) dev[name] = starterPkg.devDependencies[name]!
        next = upsertFile(
          next,
          'package.json',
          JSON.stringify({ ...parsed, devDependencies: dev }, null, 2),
        )
      }
    } catch {
      // Unparseable package.json is the user's to fix; do not clobber it.
    }
  }

  return next
}
