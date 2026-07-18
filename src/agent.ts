import { designGuidancePrompt } from './design-guidance'
import { buildSelectedElementPrompt, type SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'
import { FetchLLMClient } from './llm-client'
import type { LLMCallParams, ModelMessage as PortMessage } from './llm-port'

// `paths`: files the turn touched (assistant turns with patches); rides the
// saved message so the chat's narration chips survive reloads.
export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string; paths?: string[] }
export type AgentProvider = 'ollama' | 'openrouter'
export type AgentPatch = { path: string; content: string }
export type AgentResult = { reply: string; patches: AgentPatch[]; envVars?: Record<string, string> }


/**
 * Assemble the agent system prompt from named sections.
 *
 * Decomposed into sections so each is independently testable and the
 * prompt can be lazily built without recomputing static parts.
 *
 * The Rules block must stay in sync with server/src/prompt.ts (the managed
 * source of truth) — src/prompt-parity.test.ts enforces this, with
 * client-only rules declared there explicitly.
 */
export function buildSystemPrompt(): string {
  const header = [
    'You are an app-building agent inside a browser-only StackBlitz WebContainer.',
    'Return ONLY valid JSON with this exact shape: {"reply":"short user-facing summary","patches":[{"path":"src/main.tsx","content":"full file content"}]}',
  ].join('. ')

  const planning = 'Planning: For simple one-file changes, just do it. For broad, ambiguous, design-sensitive, or multi-file changes, understand the codebase first, plan your changes, then execute — verify each change makes sense before returning it.'

  const rules = [
    'Modify files by returning full replacement contents.',
    'Prefer Vite + React + TypeScript.',
    'Use Tailwind CSS for styling and shadcn/ui for components.',
    'Tailwind, PostCSS, and the cn() helper in src/lib/utils.ts are preconfigured; do not modify tailwind.config.js or postcss.config.js, and only change package.json to add a genuinely new dependency.',
    'For persistence, use the db client in src/db.ts; it calls the hyper-zepto data port that zepto-bridge.js serves at /api/db (mounted by vite.config.ts in dev and server.js in production). Never import hyper-zepto in browser code.',
    'Preserve vite.config.ts, zepto-bridge.js, and server.js (they host the database API and the production server) unless the user explicitly asks to change the backend.',
    'Do not use native Node modules, server-only packages, Docker, or external databases.',
    'Vite: pin to ^7.x. Vite 8+ uses rolldown WASM that crashes in WebContainers.',
    'Dependency versions must be peer-compatible. If adding packages, check their peer dep requirements.',
    'Keep changes small, coherent, and runnable.',
    'If changing dependencies, replace package.json too.',
    "Preserve src/build-inspector.ts and the './build-inspector' import unless the user explicitly asks to remove Build preview selection.",
    'Apply the bundled design guidance unless the user asks for a different brand or visual direction.',
    'Maintain BRAIN.md, the project\'s plain-language wiki: keep "## What & Why" describing the user\'s goals (change it only when the user changes their goals), keep "## How it works" a current plain-language summary of the app, record brand choices under "## Brand", and append dated entries under "## Decisions" when you make significant design or engineering choices.',
    'Keep BRAIN.md under 6,000 characters: prune superseded decisions and never paste code into it.',
    'Your user is usually a non-technical founder: write the reply in plain language, with no jargon and no file paths unless they ask.',
    'After a substantive change, end the reply with one short "Next:" sentence naming the most valuable next step for this app; when the user seems stuck, offer two or three concrete options instead of open-ended questions.',
    'On the first build, propose a brand that fits the user\'s stated style: an app name, a 3-5 color palette in hex, a one-line tone of voice, and a described (not generated) logo direction; record them under "## Brand" in BRAIN.md and apply the palette in the app.',
    'When the user asks for branding help later, update the "## Brand" section and the code together; never contradict the recorded brand silently.',
    'Secrets and API keys are set in the .env file; set them via the envVars field in your response.',
    'Never include markdown, prose, progress updates, or code fences outside the JSON object.',
  ]

  const verification = [
    'Verify imports resolve (no missing or wrong imports).',
    'Verify the code is syntactically valid.',
    'Verify all patches are complete file contents, not partial edits.',
    'Verify your reply is a useful, specific summary.',
  ]

  const contextRequest = 'If you need more context (a file is stubbed, or a referenced module is missing), return {"reply":"I need the full contents of X, Y to proceed.","patches":[]} and the system will send them.'

  return [
    header,
    '',
    planning,
    '',
    'Rules:',
    ...rules.map(r => `- ${r}`),
    '',
    'Self-verification (before returning):',
    ...verification.map(v => `- ${v}`),
    '',
    contextRequest,
    '',
    'Design guidance:',
    designGuidancePrompt(),
  ].join('\n')
}

// Backward-compatible constant for existing callers.
const JSON_SYSTEM_PROMPT = buildSystemPrompt()

type AgentArgs = {
  provider: AgentProvider
  apiKey?: string
  ollamaUrl?: string
  model: string
  userPrompt: string
  files: ProjectFile[]
  messages: ChatMessage[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
  envVars?: Record<string, string>
  signal?: AbortSignal
}

/**
 * Internal type alias — the port uses `ModelMessage` from llm-port;
 * we map ChatMessage → PortMessage before calling the LLM client.
 */
type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Context selection (mirror of server/src/prompt.ts, which is the source of
 * truth): under the budget the whole project ships; over it, files the
 * request plausibly touches stay full and the rest shrink to stubs.
 */
const FILE_CONTEXT_CHAR_BUDGET = 160_000
const STUB_LINES = 20
const STUB_MAX_CHARS = 1000
const ALWAYS_FULL = new Set(['package.json', 'vite.config.ts', 'zepto-bridge.js', 'server.js', 'index.html', 'src/db.ts', 'BRAIN.md'])
const SMALL_FILE_CHARS = 1500
const RECENT_MESSAGES = 6

/** BRAIN.md ships in full every request, so a runaway brain would eat the
 * context budget — past this cap it is truncated with a rewrite marker. */
const BRAIN_PATH = 'BRAIN.md'
const BRAIN_MAX_CHARS = 10_000
const BRAIN_TRUNCATION_NOTE = '\n\n[brain truncated — rewrite BRAIN.md so it is under 6000 characters]'

function guardBrainFile(file: ProjectFile): ProjectFile {
  if (file.path !== BRAIN_PATH || file.content.length <= BRAIN_MAX_CHARS) return file
  return { ...file, content: file.content.slice(0, BRAIN_MAX_CHARS) + BRAIN_TRUNCATION_NOTE }
}

type ContextFile = ProjectFile & { stub: boolean }

function basename(path: string) {
  return path.split('/').at(-1) ?? path
}

function selectContextFiles(args: {
  files: ProjectFile[]
  userPrompt: string
  messages: ChatMessage[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
}): ContextFile[] {
  const files = args.files.map(guardBrainFile)
  const total = files.reduce((sum, file) => sum + file.content.length, 0)
  if (total <= FILE_CONTEXT_CHAR_BUDGET) return files.map(file => ({ ...file, stub: false }))

  const mentionText = [
    args.userPrompt,
    ...args.messages.slice(-RECENT_MESSAGES).map(message => message.content),
    args.elementComment ?? '',
  ].join('\n')
  const elementMarkers = [args.selectedElement?.id, ...(args.selectedElement?.classes ?? [])].filter(
    (marker): marker is string => !!marker,
  )

  const priority = (file: ProjectFile): number => {
    if (ALWAYS_FULL.has(file.path)) return 0
    if (mentionText.includes(file.path) || mentionText.includes(basename(file.path))) return 1
    if (elementMarkers.some(marker => file.content.includes(marker))) return 2
    if (file.content.length <= SMALL_FILE_CHARS) return 3
    return 4
  }

  const ranked = files
    .map((file, index) => ({ file, index, priority: priority(file) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  let spent = 0
  const stubbed = new Set<string>()
  for (const entry of ranked) {
    if (spent + entry.file.content.length > FILE_CONTEXT_CHAR_BUDGET) {
      stubbed.add(entry.file.path)
    } else {
      spent += entry.file.content.length
    }
  }
  return files.map(file => ({ ...file, stub: stubbed.has(file.path) }))
}

const STUB_NOTE = `

Files marked [stub: ...] show only their first lines to fit the context budget. Never write a patch for a stubbed file based on its stub. If the change needs one, return {"reply":"<say which files you need, by exact path>","patches":[]} — files named in the conversation are sent in full on the next message.`

function projectContext(files: ContextFile[]) {
  return files
    .map(file => {
      if (!file.stub) return `--- ${file.path}\n${file.content}`
      const lines = file.content.split('\n')
      const shown = Math.min(STUB_LINES, lines.length)
      const head = lines.slice(0, shown).join('\n').slice(0, STUB_MAX_CHARS)
      return `--- ${file.path} [stub: first ${shown} of ${lines.length} lines]\n${head}`
    })
    .join('\n\n')
}

export async function call_agent(args: AgentArgs & { fetchFn?: typeof fetch }): Promise<AgentResult> {
  const fetchFn = args.fetchFn ?? globalThis.fetch
  const messages: ModelMessage[] = []
  messages.push({ role: 'system', content: JSON_SYSTEM_PROMPT })
  if (args.files.length > 0) {
    const contextFiles = selectContextFiles(args)
    const note = contextFiles.some(file => file.stub) ? STUB_NOTE : ''
    messages.push({ role: 'system', content: `Current project files:\n\n${projectContext(contextFiles)}${note}` })
  }
  if (args.selectedElement && args.elementComment) {
    messages.push({ role: 'system', content: buildSelectedElementPrompt({ element: args.selectedElement, comment: args.elementComment }) })
  }
  if (args.envVars && Object.keys(args.envVars).length > 0) {
    const envLines = Object.entries(args.envVars)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${v}`)
    messages.push({ role: 'system', content: `Current env vars:\n${envLines.join('\n')}` })
  }
  for (const msg of args.messages) {
    messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
  }
  messages.push({ role: 'user', content: args.userPrompt })

  const llmMessages: PortMessage[] = messages.map(m => ({ role: m.role, content: m.content }))

  const client = new FetchLLMClient(fetchFn)
  const result = await client.call({
    provider: args.provider,
    model: args.model,
    messages: llmMessages,
    apiKey: args.apiKey,
    ollamaUrl: args.ollamaUrl,
    signal: args.signal,
    formatJson: args.provider === 'openrouter',
  })

  return {
    reply: result.reply,
    patches: result.patches,
    envVars: result.envVars,
  }
}

// Backward compatibility alias
export async function runAgent(args: AgentArgs & { fetchFn?: typeof fetch }): Promise<AgentResult> {
  return call_agent(args)
}

