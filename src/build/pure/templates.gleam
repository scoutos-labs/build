import gleam/list
import gleam/string

pub type ProjectFile {
  ProjectFile(path: String, content: String)
}

pub type FileTree {
  File(contents: String)
  Directory(children: List(#(String, FileTree)))
}

pub fn starter_files() -> List(ProjectFile) {
  [
    ProjectFile("package.json", package_json()),
    ProjectFile(
      "index.html",
      "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script>\n",
    ),
    ProjectFile("tailwind.config.js", tailwind_config_js()),
    ProjectFile("postcss.config.js", postcss_config_js()),
    ProjectFile("vite.config.ts", vite_config_ts()),
    ProjectFile("zepto-bridge.js", zepto_bridge_js()),
    ProjectFile("server.js", server_js()),
    ProjectFile("src/main.tsx", main_tsx()),
    ProjectFile("src/db.ts", db_ts()),
    ProjectFile("src/lib/utils.ts", lib_utils_ts()),
    ProjectFile("src/build-inspector.ts", build_inspector_ts()),
    ProjectFile("src/style.css", style_css()),
  ]
}

/// Remove a file. Counterpart to `upsert_file`; same leading-slash
/// normalization so a path that could be written can also be removed.
pub fn remove_file(
  files: List(ProjectFile),
  path: String,
) -> List(ProjectFile) {
  let normalized = strip_leading_slashes(path)
  list.filter(files, fn(file) { file.path != normalized })
}

pub fn upsert_file(
  files: List(ProjectFile),
  path: String,
  content: String,
) -> List(ProjectFile) {
  let normalized = strip_leading_slashes(path)
  case list.any(files, fn(file) { file.path == normalized }) {
    True ->
      list.map(files, fn(file) {
        case file.path == normalized {
          True -> ProjectFile(normalized, content)
          False -> file
        }
      })
    False ->
      [ProjectFile(normalized, content), ..files]
      |> list.sort(by: fn(a, b) { string.compare(a.path, b.path) })
  }
}

pub fn files_to_tree(files: List(ProjectFile)) -> FileTree {
  Directory(files_to_nodes(files))
}

pub fn tree_get(tree: FileTree, path: String) -> Result(FileTree, Nil) {
  let parts = path |> string.split("/") |> list.filter(fn(part) { part != "" })
  do_tree_get(tree, parts)
}

fn do_tree_get(tree: FileTree, parts: List(String)) -> Result(FileTree, Nil) {
  case tree, parts {
    _, [] -> Ok(tree)
    Directory(children), [part, ..rest] ->
      case list.find(children, fn(child) { child.0 == part }) {
        Ok(child) -> do_tree_get(child.1, rest)
        Error(_) -> Error(Nil)
      }
    File(_), _ -> Error(Nil)
  }
}

fn files_to_nodes(files: List(ProjectFile)) -> List(#(String, FileTree)) {
  case files {
    [] -> []
    [file, ..rest] -> insert_file(files_to_nodes(rest), file)
  }
}

fn insert_file(
  nodes: List(#(String, FileTree)),
  file: ProjectFile,
) -> List(#(String, FileTree)) {
  let parts =
    file.path |> string.split("/") |> list.filter(fn(part) { part != "" })
  insert_parts(nodes, parts, file.content)
}

fn insert_parts(
  nodes: List(#(String, FileTree)),
  parts: List(String),
  content: String,
) -> List(#(String, FileTree)) {
  case parts {
    [] -> nodes
    [name] -> replace_node(nodes, name, File(content))
    [directory, ..rest] -> {
      let existing_children = case
        list.find(nodes, fn(node) { node.0 == directory })
      {
        Ok(#(_, Directory(children))) -> children
        _ -> []
      }
      replace_node(
        nodes,
        directory,
        Directory(insert_parts(existing_children, rest, content)),
      )
    }
  }
}

fn replace_node(
  nodes: List(#(String, FileTree)),
  name: String,
  tree: FileTree,
) -> List(#(String, FileTree)) {
  case list.any(nodes, fn(node) { node.0 == name }) {
    True ->
      list.map(nodes, fn(node) {
        case node.0 == name {
          True -> #(name, tree)
          False -> node
        }
      })
    False -> [#(name, tree), ..nodes]
  }
}

fn strip_leading_slashes(path: String) -> String {
  case string.starts_with(path, "/") {
    True ->
      strip_leading_slashes(string.slice(
        path,
        at_index: 1,
        length: string.length(path),
      ))
    False -> path
  }
}

fn package_json() -> String {
  // vite pinned below 8: Vite 8 bundles via rolldown, whose WASM binding
  // (emnapi) crashes inside WebContainers. Tailwind v3 + shadcn helpers are
  // pre-baked so the agent doesn't have to bootstrap styling on the first
  // build (avoids a package.json change → reinstall → dev-server restart /
  // preview flicker).
  "{\n  \"scripts\": {\n    \"dev\": \"vite --host 0.0.0.0\",\n    \"build\": \"vite build\",\n    \"start\": \"node server.js\"\n  },\n  \"dependencies\": {\n    \"@vitejs/plugin-react\": \"^4.3.4\",\n    \"class-variance-authority\": \"^0.7.1\",\n    \"clsx\": \"^2.1.1\",\n    \"hyper-zepto\": \"^0.1.0\",\n    \"lucide-react\": \"^0.468.0\",\n    \"react\": \"^18.3.1\",\n    \"react-dom\": \"^18.3.1\",\n    \"tailwind-merge\": \"^2.6.0\",\n    \"typescript\": \"latest\",\n    \"vite\": \"^7.3.2\"\n  },\n  \"devDependencies\": {\n    \"autoprefixer\": \"^10.4.20\",\n    \"postcss\": \"^8.4.49\",\n    \"tailwindcss\": \"^3.4.17\"\n  },\n  \"type\": \"module\"\n}"
}

fn tailwind_config_js() -> String {
  "/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],\n  theme: { extend: {} },\n  plugins: [],\n}\n"
}

fn postcss_config_js() -> String {
  "export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n"
}

fn lib_utils_ts() -> String {
  "import { type ClassValue, clsx } from 'clsx'\nimport { twMerge } from 'tailwind-merge'\n\n// shadcn/ui style helper: merges class names and resolves Tailwind conflicts.\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs))\n}\n"
}

fn main_tsx() -> String {
  "import React from 'react'
import { createRoot } from 'react-dom/client'
import './build-inspector'
import './style.css'

function App() {
  return <main className=\"shell\">
    <section className=\"intro\">
      <div>
        <p className=\"eyebrow\">Build starter</p>
        <h1>Welcome to Build.</h1>
        <p className=\"lede\">Your app will appear here.</p>
      </div>
      <div className=\"hint\">Answer the interview in the chat — or just describe your idea — and the agent replaces this page with your app.</div>
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
"
}

fn db_ts() -> String {
  "// Browser client for the hyper-zepto data port served by vite.config.ts.
// Mongo-style documents: await db.create('todos', { title: 'hi' }), then
// await db.find('todos', { filter: { done: false }, sort: { title: 1 } }).
type Json = Record<string, unknown>

async function call(collection: string, action: string, body: Json) {
  const response = await fetch(`/api/db/${collection}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error ?? `db ${action} failed (${response.status})`)
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
"
}

fn vite_config_ts() -> String {
  "import { defineConfig } from 'vite'
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
"
}

fn zepto_bridge_js() -> String {
  "// Shared /api/db bridge: hyper-zepto runs in Node, so this code is mounted
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
      default: throw Object.assign(new Error(`unknown db action: ${action}`), { status: 404 })
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
"
}

fn server_js() -> String {
  "// Production server: serves the built dist/ statically and mounts the same
// /api/db bridge as the Vite dev server (see zepto-bridge.js). Run with
// `npm run build && npm start`. On Scout Live the bridge talks to the
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
}).listen(port, () => console.log(`app listening on ${port} (db mode=${ports.mode})`))
"
}

fn build_inspector_ts() -> String {
  "const STYLE_ID = 'build-inspector-style'
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
"
}

fn style_css() -> String {
  "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {
  color: #172033;
  background: radial-gradient(circle at top left, #eaf0ff 0, transparent 34rem), #f6f8fc;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;
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
"

}
