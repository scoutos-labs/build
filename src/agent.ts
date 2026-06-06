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

${BUILD_TOOL_SCHEMAS.map(s => `- ${s.name}: ${s.description}`).join('\n')}

## EXACT ATOM FORMATS — COPY THESE EXACTLY

### text_delta atom:
{"atom_type":"text_delta","data":{"id":"t1","text":"Building a counter app..."}}

### tool_intent atom (write_file):
{"atom_type":"tool_intent","data":{"id":"w1","tool_name":"write_file","input_data":{"path":"src/App.tsx","content":"import { useState } from 'react'\nexport default function App() {\n  const [count, setCount] = useState(0)\n  return <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>\n}"}}}

### tool_intent atom (read_file):
{"atom_type":"tool_intent","data":{"id":"r1","tool_name":"read_file","input_data":{"path":"src/App.tsx"}}}

### tool_intent atom (run_command):
{"atom_type":"tool_intent","data":{"id":"c1","tool_name":"run_command","input_data":{"command":"npm install","timeout":60000}}}

### tool_intent atom (list_files):
{"atom_type":"tool_intent","data":{"id":"l1","tool_name":"list_files","input_data":{"path":"src"}}}

### tool_intent atom (install_package):
{"atom_type":"tool_intent","data":{"id":"p1","tool_name":"install_package","input_data":{"package":"lodash"}}}

### final_answer atom:
{"atom_type":"final_answer","data":{"id":"f1","text":"I've built a simple React counter app. Click the button to increment the count."}}

## EXAMPLE — Complete response for "Build a hello world counter app"

You emit atoms in this order:

1. text_delta: "Building a Vite + React counter app..."
2. tool_intent (write_file): src/App.tsx
3. tool_intent (write_file): src/main.tsx
4. text_delta: "Done!"
5. final_answer: "I've built a simple React counter app with Vite."

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
  if (args.provider === 'scoutos' && args.scoutosApiKey) {
    return runScoutOSAgent(args)
  }

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

async function runScoutOSAgent(args: AgentArgs): Promise<AgentResult> {
  if (!args.scoutosApiKey) throw new Error('ScoutOS API key is required')
  if (!args.webcontainerApi) throw new Error('WebContainer API is required for ScoutOS agent')

  const baseUrl = args.scoutosBaseUrl || 'https://api.scoutos.com'
  const chatMessages = args.messages.map(msg => ({
    id: crypto.randomUUID(),
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }))

  chatMessages.push({
    id: crypto.randomUUID(),
    role: 'user',
    content: args.userPrompt,
  })

  const MAX_ITERATIONS = 10
  let iteration = 0
  let reply = ''
  const patches: AgentPatch[] = []

  while (iteration < MAX_ITERATIONS) {
    iteration++

    let result: Awaited<ReturnType<typeof scoutosAtomsRequest>>
    if (iteration === 1) {
      result = await scoutosAtomsRequest({
        baseUrl,
        apiKey: args.scoutosApiKey,
        instructions: SCOUTOS_SYSTEM_PROMPT,
        context: { messages: chatMessages },
        model: args.model || undefined,
      })
    } else {
      const toolResults = patches.map((patch, idx) => ({
        id: `patch-${idx}`,
        tool_name: 'write_file',
        input_data: { path: patch.path, content: patch.content },
        result: { success: true },
      }))

      const followUpResult = await followUpWithToolResults({
        baseUrl,
        apiKey: args.scoutosApiKey,
        instructions: SCOUTOS_SYSTEM_PROMPT,
        context: { messages: chatMessages },
        toolResults,
        model: args.model || undefined,
      })
      
      if (followUpResult instanceof Error) throw followUpResult
      result = { ...followUpResult, toolIntents: [] }
    }

    if (result instanceof Error) throw result

    reply = result.reply || result.finalAnswer || ''

    if (result.toolIntents.length === 0) {
      break
    }

    for (const intent of result.toolIntents) {
      if (intent.tool_name === 'write_file' && intent.input_data.path && intent.input_data.content) {
        await args.webcontainerApi!.writeProjectFile(
          String(intent.input_data.path),
          String(intent.input_data.content),
        )
        patches.push({
          path: String(intent.input_data.path),
          content: String(intent.input_data.content),
        })
      } else {
        const intent = result.toolIntents[0]
        await executeBuildTool(
          intent.tool_name as any,
          intent.input_data as any,
          args.webcontainerApi!,
        )
      }
    }

    chatMessages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: result.finalAnswer || result.reply || 'Working...',
    })
  }

  return { reply, patches }
}
