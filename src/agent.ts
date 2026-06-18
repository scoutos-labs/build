import { designGuidancePrompt } from './design-guidance'
import { buildSelectedElementPrompt, type SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }
export type AgentProvider = 'ollama' | 'openrouter'
export type AgentPatch = { path: string; content: string }
export type AgentResult = { reply: string; patches: AgentPatch[] }

const SYSTEM_PROMPT = `You are an app-building agent inside a browser-only StackBlitz WebContainer.
Return ONLY valid JSON with this exact shape: {"reply":"short user-facing summary","patches":[{"path":"src/main.tsx","content":"full file content"}]}.
Rules:
- Modify files by returning full replacement contents.
- Prefer Next.js + React + TypeScript.
- Use Tailwind CSS for styling and shadcn/ui for components.
- Use @electric-sql/pglite for local browser databases.
- Do not use native Node modules, server-only packages, Docker, or external databases.
- Keep changes small, coherent, and runnable.
- If changing dependencies, replace package.json too.
- Preserve src/build-inspector.ts and the './build-inspector' import unless the user explicitly asks to remove Build preview selection.
- Apply the bundled design guidance unless the user asks for a different brand or visual direction.
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
  signal?: AbortSignal
}

type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }

function projectContext(files: ProjectFile[]) {
  return files.map(file => `--- ${file.path}\n${file.content}`).join('\n\n')
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
  let inString = false
  let escaped = false
  for (let index = start; index < unfenced.length; index += 1) {
    const char = unfenced[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return unfenced.slice(start, index + 1)
    }
  }

  throw new Error('Agent response contained an incomplete JSON object')
}

function messagesWithContext(args: AgentArgs): ModelMessage[] {
  const selectedElementContext = args.selectedElement && args.elementComment
    ? `\n\n${buildSelectedElementPrompt({ comment: args.elementComment, element: args.selectedElement })}`
    : ''
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...args.messages.slice(-8),
    { role: 'user', content: `Current project files:\n${projectContext(args.files)}\n\nUser request: ${args.userPrompt}${selectedElementContext}` },
  ]
}

function repairMessages(args: AgentArgs, badContent: string, error: unknown): ModelMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Your previous response could not be parsed as the required JSON object.\n\nParse error:\n${error instanceof Error ? error.message : String(error)}\n\nOriginal user request:\n${args.userPrompt}\n\nCurrent project files:\n${projectContext(args.files)}\n\nInvalid response to repair:\n${badContent}\n\nReturn ONLY valid JSON with exactly {"reply": string, "patches": [{"path": string, "content": string}]}.`,
    },
  ]
}

export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  const messages = messagesWithContext(args)
  const content = await requestModelContent(args, messages)
  try {
    return extractJson(content)
  } catch (error) {
    const repaired = await requestModelContent(args, repairMessages(args, content, error))
    return extractJson(repaired)
  }
}

async function requestModelContent(args: AgentArgs, messages: ModelMessage[]) {
  return args.provider === 'ollama' ? requestOllamaContent(args, messages) : requestOpenRouterContent(args, messages)
}

async function requestOllamaContent(args: AgentArgs, messages: ModelMessage[]) {
  const baseUrl = (args.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages,
    }),
    signal: args.signal,
  })

  if (!response.ok) throw new Error(`Ollama error ${response.status}: ${await response.text()}`)
  const data = await response.json()
  const content = data.message?.content
  if (!content) throw new Error('Ollama returned no message content')
  return content
}

async function requestOpenRouterContent(args: AgentArgs, messages: ModelMessage[]) {
  if (!args.apiKey?.trim()) throw new Error('OpenRouter API key is required for the OpenRouter provider')

  const request = (body: Record<string, unknown>) => fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
      'HTTP-Referer': globalThis.location?.origin ?? 'http://localhost',
      'X-Title': 'Browser App Builder MVP',
    },
    body: JSON.stringify(body),
    signal: args.signal,
  })
  const baseBody = { model: args.model, temperature: 0.2, messages }
  let response = await request({ ...baseBody, response_format: { type: 'json_object' } })
  let errorText = ''

  if (!response.ok) {
    errorText = await response.text()
    if (shouldRetryOpenRouterWithoutJsonMode(response.status, errorText)) {
      response = await request(baseBody)
      errorText = ''
    }
  }

  if (!response.ok) throw new Error(`OpenRouter error ${response.status}: ${errorText || await response.text()}`)
  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenRouter returned no message content')
  return content
}

function shouldRetryOpenRouterWithoutJsonMode(status: number, errorText: string) {
  return (status === 400 || status === 422) && /response[_ ]format|json[_ ]object|json mode/i.test(errorText)
}
