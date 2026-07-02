import { designGuidancePrompt } from './design-guidance'
import { buildSelectedElementPrompt, type SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }
export type AgentProvider = 'ollama' | 'openrouter'
export type AgentPatch = { path: string; content: string }
export type AgentResult = { reply: string; patches: AgentPatch[]; envVars?: Record<string, string> }

const JSON_SYSTEM_PROMPT = `You are an app-building agent inside a browser-only StackBlitz WebContainer.
Return ONLY valid JSON with this exact shape: {"reply":"short user-facing summary","patches":[{"path":"src/main.tsx","content":"full file content"}]}.
Rules:
- Modify files by returning full replacement contents.
- Prefer Vite + React + TypeScript.
- Use Tailwind CSS for styling and shadcn/ui for components.
- Tailwind, PostCSS, and the cn() helper in src/lib/utils.ts are preconfigured; do not modify tailwind.config.js or postcss.config.js, and only change package.json to add a genuinely new dependency.
- For persistence, use the db client in src/db.ts; it calls the hyper-zepto data port that zepto-bridge.js serves at /api/db (mounted by vite.config.ts in dev and server.js in production). Never import hyper-zepto in browser code.
- Preserve vite.config.ts, zepto-bridge.js, and server.js (they host the database API and the production server) unless the user explicitly asks to change the backend.
- Do not use native Node modules, server-only packages, Docker, or external databases.
- Keep changes small, coherent, and runnable.
- If changing dependencies, replace package.json too.
- Preserve src/build-inspector.ts and the './build-inspector' import unless the user explicitly asks to remove Build preview selection.
- Apply the bundled design guidance unless the user asks for a different brand or visual direction.
- Secrets and API keys are set in the .env file; set them via the envVars field in your response.
- Never include markdown, prose, progress updates, or code fences outside the JSON object.

Design guidance:
${designGuidancePrompt()}
`

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

type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Context selection (mirror of server/src/prompt.ts, which is the source of
 * truth): under the budget the whole project ships; over it, files the
 * request plausibly touches stay full and the rest shrink to stubs.
 */
const FILE_CONTEXT_CHAR_BUDGET = 160_000
const STUB_LINES = 20
const STUB_MAX_CHARS = 1000
const ALWAYS_FULL = new Set(['package.json', 'vite.config.ts', 'zepto-bridge.js', 'server.js', 'index.html', 'src/db.ts'])
const SMALL_FILE_CHARS = 1500
const RECENT_MESSAGES = 6

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
  const total = args.files.reduce((sum, file) => sum + file.content.length, 0)
  if (total <= FILE_CONTEXT_CHAR_BUDGET) return args.files.map(file => ({ ...file, stub: false }))

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

  const ranked = args.files
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
  return args.files.map(file => ({ ...file, stub: stubbed.has(file.path) }))
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

function extractJson(text: string): AgentResult {
  const raw = findJsonObject(text)
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.patches) || typeof parsed.reply !== 'string') throw new Error('Agent response did not match expected JSON shape')
  return parsed
}

function findJsonObject(text: string) {
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
    : trimmed

  if (unfenced.startsWith('{')) return unfenced

  const start = unfenced.indexOf('{')
  if (start === -1) throw new Error(`Agent response was not JSON. It began with: ${unfenced.slice(0, 80)}`)

  let depth = 0

  for (let i = start; i < unfenced.length; i++) {
    const char = unfenced[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return unfenced.slice(start, i + 1)
    }
  }

  throw new Error('Agent response contained an unclosed JSON object.')
}

export async function call_agent(args: AgentArgs): Promise<AgentResult> {
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

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model: args.model }),
    signal: args.signal,
  }

  if (args.provider === 'ollama') {
    if (!args.ollamaUrl) throw new Error('Ollama URL is required for Ollama provider')
    fetchOptions.body = JSON.stringify({
      model: args.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      format: 'json',
    })
    const baseUrl = args.ollamaUrl.replace(/\/$/, '')
    let response = await fetch(`${baseUrl}/api/chat`, fetchOptions)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Ollama error ${response.status}: ${text || response.statusText}`)
    }
    let data = await response.json() as { message?: { content: string } }
    if (!data.message?.content) throw new Error('Ollama response missing message content')
    
    try {
      return extractJson(data.message.content)
    } catch (parseError) {
      // Retry with repair prompt
      fetchOptions.body = JSON.stringify({
        model: args.model,
        messages: [
          ...messages.map(m => ({ role: m.role, content: m.content })),
          { role: 'assistant', content: data.message.content },
          { role: 'user', content: 'Invalid response to repair. Return ONLY valid JSON with shape: {"reply":"summary","patches":[{"path":"file","content":"code"}]}' },
        ],
        stream: false,
        format: 'json',
      })
      response = await fetch(`${baseUrl}/api/chat`, fetchOptions)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Ollama error ${response.status}: ${text || response.statusText}`)
      }
      data = await response.json() as { message?: { content: string } }
      if (!data.message?.content) throw new Error('Ollama response missing message content')
      return extractJson(data.message.content)
    }
  }

  if (!args.apiKey) throw new Error('OpenRouter API key is required')
  const openRouterHeaders = {
    ...fetchOptions.headers,
    Authorization: `Bearer ${args.apiKey}`,
  }
  const openRouterBody1 = JSON.stringify({ messages, model: args.model, response_format: { type: 'json_object' } })
  let response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    ...fetchOptions,
    headers: openRouterHeaders,
    body: openRouterBody1,
  })
  
  // Retry without response_format if provider rejects it
  if (!response.ok && response.status === 400) {
    const errorText = await response.text().catch(() => '')
    if (errorText.includes('response_format')) {
      const openRouterBody2 = JSON.stringify({ messages, model: args.model })
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        ...fetchOptions,
        headers: openRouterHeaders,
        body: openRouterBody2,
      })
    }
  }
  
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenRouter error ${response.status}: ${text || response.statusText}`)
  }
  const data = await response.json() as { choices: { message: { content: string } }[] }
  if (!data.choices?.[0]?.message?.content) throw new Error('OpenRouter response missing content')
  return extractJson(data.choices[0].message.content)
}

// Backward compatibility alias
export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  return call_agent(args)
}
