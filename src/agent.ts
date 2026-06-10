import { designGuidancePrompt } from './design-guidance'
import { buildSelectedElementPrompt, type SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }
export type AgentProvider = 'ollama' | 'openrouter'
export type AgentPatch = { path: string; content: string }
export type AgentResult = { reply: string; patches: AgentPatch[] }

const JSON_SYSTEM_PROMPT = `You are an app-building agent inside a browser-only StackBlitz WebContainer.
Return ONLY valid JSON with this exact shape: {"reply":"short user-facing summary","patches":[{"path":"src/main.tsx","content":"full file content"}]}.
Rules:
- Modify files by returning full replacement contents.
- Prefer Vite + React + TypeScript.
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
    messages.push({ role: 'system', content: `Current project files:\n\n${projectContext(args.files)}` })
  }
  if (args.selectedElement && args.elementComment) {
    messages.push({ role: 'system', content: buildSelectedElementPrompt({ element: args.selectedElement, comment: args.elementComment }) })
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
