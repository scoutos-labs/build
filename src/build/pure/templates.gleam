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
    ProjectFile("vite.config.ts", vite_config_ts()),
    ProjectFile("src/main.tsx", main_tsx()),
    ProjectFile("src/db.ts", db_ts()),
    ProjectFile("src/build-inspector.ts", build_inspector_ts()),
    ProjectFile("src/style.css", style_css()),
  ]
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
  // (emnapi) crashes inside WebContainers.
  "{\n  \"scripts\": {\n    \"dev\": \"vite --host 0.0.0.0\"\n  },\n  \"dependencies\": {\n    \"@vitejs/plugin-react\": \"^4.3.4\",\n    \"hyper-zepto\": \"^0.1.0\",\n    \"vite\": \"^7.3.2\",\n    \"typescript\": \"latest\",\n    \"react\": \"^18.3.1\",\n    \"react-dom\": \"^18.3.1\"\n  },\n  \"devDependencies\": {},\n  \"type\": \"module\"\n}"
}

fn main_tsx() -> String {
  "import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './build-inspector'
import './style.css'

type Answers = {
  idea: string
  audience: string
  problem: string
  features: string
  data: string
  style: string
  integrations: string
}

const questions: Array<{ key: keyof Answers; label: string; helper: string; placeholder: string }> = [
  {
    key: 'idea',
    label: 'What do you want to build?',
    helper: 'Name the app idea in one or two sentences.',
    placeholder: 'A booking app for local yoga instructors, a client portal for my agency...',
  },
  {
    key: 'audience',
    label: 'Who is it for?',
    helper: 'Describe the people who will use this app.',
    placeholder: 'Busy parents, freelance designers, restaurant managers...',
  },
  {
    key: 'problem',
    label: 'What should it help them do?',
    helper: 'Focus on the main job, frustration, or outcome.',
    placeholder: 'Track leads, schedule appointments, organize tasks, learn a skill...',
  },
  {
    key: 'features',
    label: 'What are the must-have features?',
    helper: 'List the screens, actions, or workflows you know you need.',
    placeholder: 'Dashboard, profiles, search, comments, status filters, admin view...',
  },
  {
    key: 'data',
    label: 'What information should it save?',
    helper: 'Mention important records, fields, or relationships.',
    placeholder: 'Customers with name/email/status, projects with tasks and due dates...',
  },
  {
    key: 'style',
    label: 'How should it look and feel?',
    helper: 'Pick a vibe, brand, or app you want it to resemble.',
    placeholder: 'Clean and modern like Linear, playful and colorful, premium SaaS...',
  },
  {
    key: 'integrations',
    label: 'Any extras or constraints?',
    helper: 'Auth, payments, uploads, charts, mobile-first, or anything to avoid.',
    placeholder: 'Login later, no payments yet, mobile-first, local browser database is fine...',
  },
]

const emptyAnswers: Answers = {
  idea: '',
  audience: '',
  problem: '',
  features: '',
  data: '',
  style: '',
  integrations: '',
}

function compact(value: string, fallback: string) {
  return value.trim() || fallback
}

function buildPlanSummary(answers: Answers) {
  const plan = {
    appIdea: compact(answers.idea, 'A useful web app based on the interview answers'),
    targetUsers: compact(answers.audience, 'People who need a simpler workflow'),
    primaryGoal: compact(answers.problem, 'Help users complete their core task quickly'),
    coreFeatures: compact(answers.features, 'A polished dashboard, clear navigation, create/edit flows, and helpful empty states'),
    dataToStore: compact(answers.data, 'Local app records with sensible fields and sample data'),
    visualDirection: compact(answers.style, 'Modern, friendly, responsive, and production-quality'),
    extrasAndConstraints: compact(answers.integrations, 'Keep it runnable in the browser with React, TypeScript, Vite, and the hyper-zepto db helpers in src/db.ts when persistence is useful'),
  }

  const summary = `Build an app for: ${plan.appIdea}\\n\\nTarget users: ${plan.targetUsers}\\n\\nMain goal: ${plan.primaryGoal}\\n\\nMust-have features: ${plan.coreFeatures}\\n\\nData model / persistence: ${plan.dataToStore}\\n\\nVisual direction: ${plan.visualDirection}\\n\\nExtras / constraints: ${plan.extrasAndConstraints}`

  return { plan, summary }
}

function App() {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Answers>(emptyAnswers)
  const [sent, setSent] = useState(false)
  const current = questions[step]
  const progress = Math.round(((step + 1) / questions.length) * 100)
  const { plan, summary } = useMemo(() => buildPlanSummary(answers), [answers])
  const isReviewing = step >= questions.length

  function updateAnswer(value: string) {
    if (!current) return
    setAnswers(previous => ({ ...previous, [current.key]: value }))
  }

  function next() {
    setStep(value => Math.min(value + 1, questions.length))
  }

  function back() {
    setStep(value => Math.max(value - 1, 0))
  }

  function buildApp() {
    const message = { type: 'BUILD_APP_FROM_PLAN', plan, planSummary: summary }
    window.parent.postMessage(message, '*')
    setSent(true)
  }

  return <main className=\"shell\">
    <section className=\"intro\">
      <div>
        <p className=\"eyebrow\">Build starter</p>
        <h1>Welcome to Build.</h1>
        <p className=\"lede\">Let’s work through your idea and create an app for you today.</p>
      </div>
      <div className=\"hint\">You can also jump into chat anytime and tell the agent exactly what to change.</div>
    </section>

    <section className=\"panel\">
      <div className=\"progress\"><span style={{ width: `${isReviewing ? 100 : progress}%` }} /></div>
      {!isReviewing ? <>
        <p className=\"step\">Question {step + 1} of {questions.length}</p>
        <h2>{current.label}</h2>
        <p className=\"helper\">{current.helper}</p>
        <textarea
          autoFocus
          value={answers[current.key]}
          onChange={event => updateAnswer(event.target.value)}
          placeholder={current.placeholder}
        />
        <div className=\"actions\">
          <button className=\"secondary\" onClick={back} disabled={step === 0}>Back</button>
          <button onClick={next}>{step === questions.length - 1 ? 'Review app plan' : 'Next question'}</button>
        </div>
      </> : <>
        <p className=\"step\">Ready to build</p>
        <h2>Here’s the app plan</h2>
        <div className=\"summary\">
          <p><strong>App:</strong> {plan.appIdea}</p>
          <p><strong>Users:</strong> {plan.targetUsers}</p>
          <p><strong>Goal:</strong> {plan.primaryGoal}</p>
          <p><strong>Features:</strong> {plan.coreFeatures}</p>
          <p><strong>Data:</strong> {plan.dataToStore}</p>
          <p><strong>Style:</strong> {plan.visualDirection}</p>
          <p><strong>Extras:</strong> {plan.extrasAndConstraints}</p>
        </div>
        <div className=\"actions\">
          <button className=\"secondary\" onClick={back}>Edit answers</button>
          <button onClick={buildApp}>{sent ? 'Plan sent to Build' : 'Build this app'}</button>
        </div>
        <p className=\"footnote\">This button sends the summarized plan to the model along with the current code so it can replace this interview with your new app.</p>
      </>}
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
  "import { defineConfig, type Plugin } from 'vite'
import { createPorts } from 'hyper-zepto'

// hyper-zepto uses Node fs, so it runs inside the dev server; the browser
// reaches it through this /api/db bridge (see src/db.ts).
function zeptoApi(): Plugin {
  const ports = createPorts({ mode: 'local', dir: '.zepto' })

  async function run(collection: string, action: string, body: Record<string, any>) {
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

  return {
    name: 'zepto-api',
    configureServer(server) {
      server.middlewares.use('/api/db', (req, res) => {
        const path = (req.url ?? '').split('?')[0]
        const [collection, action] = path.split('/').filter(Boolean)
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', async () => {
          try {
            const result = await run(collection, action, raw ? JSON.parse(raw) : {})
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(result ?? null))
          } catch (error: any) {
            res.statusCode = typeof error?.status === 'number' ? error.status : 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: String(error?.message ?? error), code: error?.code }))
          }
        })
      })
    },
  }
}

export default defineConfig({ plugins: [zeptoApi()] })
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
  ":root {
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
