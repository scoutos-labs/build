import { designGuidancePrompt } from './design-guidance'
import { buildSelectedElementPrompt, type SelectedPreviewElement } from './preview-inspector'
import type { ProjectFile } from './templates'
import { scoutosAtomsRequest, followUpWithToolResults } from './scoutos-client'
import { executeBuildTool, BUILD_TOOL_SCHEMAS } from './build-tools'

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }
export type AgentProvider = 'ollama' | 'openrouter' | 'scoutos'
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

const SCOUTOS_SYSTEM_PROMPT = `You are an app-building agent inside a browser-only StackBlitz WebContainer.
Your ONLY output mechanism is atoms. You MUST NOT embed file contents, JSON patches, or code blocks inside text_delta or final_answer text.

## CRITICAL RULES — FOLLOW EXACTLY

1. You MUST use write_file tool_intent to create or modify files. Emit one tool_intent per file.
2. You MUST use read_file tool_intent to inspect existing files before modifying them.
3. You MUST use run_command tool_intent to execute shell commands (e.g. npm install).
4. You MUST use install_package tool_intent to add npm dependencies.
5. You MUST use list_files tool_intent to explore the project structure.
6. You MUST use text_delta for brief user-facing explanations ONLY — never put code, file paths, or JSON inside text_delta.
7. You MUST emit final_answer when you are done with all file operations. The final_answer must be a short human-readable summary, NOT code, NOT JSON, NOT file contents.
8. You MUST NOT embed file contents in text_delta or final_answer.
9. You MUST NOT return JSON patches or markdown code fences as text.
10. You MUST NOT describe what you would do — actually emit the tool_intent atoms.

## AVAILABLE TOOLS

${BUILD_TOOL_SCHEMAS.map(s => `- ${s.name}: ${s.description}\n  Parameters: ${JSON.stringify(s.parameters.properties)}`).join('\n')}

## EXAMPLE — What a good response looks like

When the user asks "Build a hello world counter app", you emit atoms in this order:

1. text_delta: "Building a Vite + React counter app..."
2. tool_intent (write_file): path="src/App.tsx", content="import { useState } from 'react'\nexport default function App() {\n  const [count, setCount] = useState(0)\n  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>\n}"
3. tool_intent (write_file): path="src/main.tsx", content="import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nReactDOM.createRoot(document.getElementById('root')!).render(<App />)"
4. text_delta: "Done! The counter app is ready."
5. final_answer: "I've built a simple React counter app with Vite. Click the button to increment the count."

## DO NOT

- DO NOT put code inside triple backticks in text_delta or final_answer.
- DO NOT say "Here's the code:" followed by a code block.
- DO NOT return a JSON object with { reply, patches } in text.
- DO NOT describe the file contents in prose instead of emitting write_file.
- DO NOT emit markdown. Only atoms.

## TECHNOLOGY PREFERENCES

- Prefer Vite + React + TypeScript.
- Use @electric-sql/pglite for local browser databases.
- Do not use native Node modules, server-only packages, Docker, or external databases.
- Keep changes small, coherent, and runnable.
- If changing dependencies, replace package.json too.
- Preserve src/build-inspector.ts and the './build-inspector' import unless the user explicitly asks to remove Build preview selection.
- Apply the bundled design guidance unless the user asks for a different brand or visual direction.

Design guidance:
${designGuidancePrompt()}
`

type AgentArgs = {
  provider: AgentProvider
  apiKey?: string
  ollamaUrl?: string
  scoutosApiKey?: string
  scoutosBaseUrl?: string
  model: string
  userPrompt: string
  files: ProjectFile[]
  messages: ChatMessage[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
  signal?: AbortSignal
  webcontainerApi?: WebContainerApi
}

export type WebContainerApi = {
  writeProjectFile: (path: string, content: string) => Promise<void>
  readProjectFile: (path: string) => Promise<string | undefined>
  runCommand: (command: string, timeout?: number) => Promise<{ exitCode: number; output: string }>
  listFiles: (path?: string) => Promise<string[]>
  installPackage: (pkg: string) => Promise<{ exitCode: number; output: string }>
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

function messagesWithContext(args: AgentArgs, systemPrompt: string): ModelMessage[] {
  const selectedElementContext = args.selectedElement && args.elementComment
    ? `\n\n${buildSelectedElementPrompt({ comment: args.elementComment, element: args.selectedElement })}`
    : ''
  return [
    { role: 'system', content: systemPrompt },
    ...args.messages.slice(-8),
    { role: 'user', content: `Current project files:\n${projectContext(args.files)}\n\nUser request: ${args.userPrompt}${selectedElementContext}` },
  ]
}

function repairMessages(args: AgentArgs, badContent: string, error: unknown, systemPrompt: string): ModelMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Your previous response could not be parsed as the required JSON object.\n\nParse error:\n${error instanceof Error ? error.message : String(error)}\n\nOriginal user request:\n${args.userPrompt}\n\nCurrent project files:\n${projectContext(args.files)}\n\nInvalid response to repair:\n${badContent}\n\nReturn ONLY valid JSON with exactly {"reply": string, "patches": [{"path": string, "content": string}]}.`,
    },
  ]
}

export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  if (args.provider === 'scoutos') {
    return runScoutOSAgent(args)
  }

  const messages = messagesWithContext(args, JSON_SYSTEM_PROMPT)
  const content = await requestModelContent(args, messages)
  try {
    return extractJson(content)
  } catch (error) {
    const repaired = await requestModelContent(args, repairMessages(args, content, error, JSON_SYSTEM_PROMPT))
    return extractJson(repaired)
  }
}

// ── ScoutOS Atoms Streaming + Tool Loop ───────────────────────

async function runScoutOSAgent(args: AgentArgs): Promise<AgentResult> {
  const apiKey = args.scoutosApiKey?.trim()
  if (!apiKey) throw new Error('ScoutOS API key is required for the ScoutOS provider')
  const baseUrl = (args.scoutosBaseUrl || 'https://api.scoutos.com').replace(/\/$/, '')

  const wcApi = args.webcontainerApi
  if (!wcApi) throw new Error('WebContainer API is required for ScoutOS provider')

  const systemPrompt = SCOUTOS_SYSTEM_PROMPT
  const selectedElementContext = args.selectedElement && args.elementComment
    ? `\n\n${buildSelectedElementPrompt({ comment: args.elementComment, element: args.selectedElement })}`
    : ''
  const instructions = `${systemPrompt}\n\nCurrent project files:\n${projectContext(args.files)}\n\nUser request: ${args.userPrompt}${selectedElementContext}`

  let reply = ''
  const patches: AgentPatch[] = []

  const contextMessages = args.messages.slice(-8).map(m => ({
    id: crypto.randomUUID?.() ?? String(Math.random()),
    role: m.role === 'system' ? 'assistant' : m.role,
    content: m.content,
  }))

  // Initial atoms request
  let result = await scoutosAtomsRequest({
    baseUrl,
    apiKey,
    instructions,
    context: { messages: contextMessages },
    model: args.model,
    tools: BUILD_TOOL_SCHEMAS.map(s => s.name),
    signal: args.signal,
  })

  if (result instanceof Error) throw result

  reply = result.finalAnswer ?? result.reply

  // Collect patches from initial write_file intents
  for (const intent of result.toolIntents) {
    if (intent.tool_name === 'write_file') {
      const path = (intent.input_data.path as string) ?? ''
      const content = (intent.input_data.content as string) ?? ''
      if (path) patches.push({ path, content })
    }
  }

  // Tool loop: execute non-write_file tools and follow up (max 10 iterations)
  for (let iteration = 0; iteration < 10; iteration++) {
    const actionableIntents = result.toolIntents.filter(
      intent => intent.tool_name !== 'write_file'
    )
    if (actionableIntents.length === 0) break

    const toolResults: import('./atoms-protocol').ToolResult[] = []
    for (const intent of actionableIntents) {
      const toolResult = await executeBuildTool(
        intent.tool_name as import('./build-tools').BuildToolName,
        intent.input_data as never,
        wcApi,
      )
      toolResults.push({
        id: intent.id,
        tool_name: intent.tool_name,
        input_data: intent.input_data,
        result: toolResult.ok ? toolResult.data : { error: toolResult.error },
      })
    }

    const followUp = await followUpWithToolResults({
      baseUrl,
      apiKey,
      instructions,
      context: { messages: contextMessages },
      toolResults,
      model: args.model,
      tools: BUILD_TOOL_SCHEMAS.map(s => s.name),
      signal: args.signal,
    })

    if (followUp instanceof Error) throw followUp

    result = {
      reply: followUp.reply,
      toolIntents: [], // follow-up doesn't return new tool intents in this protocol
      finalAnswer: followUp.finalAnswer,
    }

    reply = followUp.finalAnswer ?? followUp.reply
  }

  return { reply, patches }
}

async function requestModelContent(args: AgentArgs, messages: ModelMessage[]) {
  if (args.provider === 'ollama') return requestOllamaContent(args, messages)
  return requestOpenRouterContent(args, messages)
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
