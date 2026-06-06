import { scoutosAtomsRequest } from './scoutos-client'
import { BUILD_TOOL_SCHEMAS } from './build-tools'

const API_KEY = 'secret_-jSG8qXgCCVivhBcQNK6MLD39A75HKrPcFa90gP0zAw='
const BASE_URL = 'https://api.scoutos.com'

// Inline copy of SCOUTOS_SYSTEM_PROMPT (must stay in sync with agent.ts)
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
`

async function test() {
  console.log('Testing ScoutOS Atoms API with tuned prompt...')
  console.log('Base URL:', BASE_URL)
  console.log('API Key:', API_KEY.slice(0, 20) + '...')
  console.log('')

  const rawResult = await scoutosAtomsRequest({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    instructions: SCOUTOS_SYSTEM_PROMPT,
    context: { messages: [{ id: '1', role: 'user', content: 'Build a hello world counter app' }] },
    tools: BUILD_TOOL_SCHEMAS.map(s => s.name),
  })

  if (rawResult instanceof Error) {
    console.error('❌ FAIL: Request failed:', rawResult.message)
    throw rawResult
  }

  const result = rawResult

  console.log('=== Reply (text_delta concatenated) ===')
  console.log(result.reply)
  console.log('')

  console.log('=== Tool Intents ===')
  console.log(JSON.stringify(result.toolIntents, null, 2))
  console.log('')

  console.log('=== Final Answer ===')
  console.log(result.finalAnswer ?? '(no final_answer)')
  console.log('')

  // Assert: has write_file intents
  const writeIntents = result.toolIntents.filter((i) => i.tool_name === 'write_file')
  if (writeIntents.length === 0) {
    console.error('❌ FAIL: No write_file intents emitted')
    throw new Error('No write_file intents')
  }
  console.log('✅ PASS: Agent emitted', writeIntents.length, 'write_file intents')

  // Assert: no raw JSON patches in reply text
  const replyHasJsonPatch = result.reply.includes('"patches"') || result.reply.includes('"path"') || result.reply.includes('```json')
  if (replyHasJsonPatch) {
    console.error('❌ FAIL: text_delta contains embedded JSON patches')
    throw new Error('Embedded JSON patches in text_delta')
  }
  console.log('✅ PASS: No embedded JSON patches in text_delta')

  // Assert: final_answer is human-readable (not code)
  if (result.finalAnswer) {
    const finalHasCode = result.finalAnswer.includes('```') || result.finalAnswer.includes('import ') || result.finalAnswer.includes('function ')
    if (finalHasCode) {
      console.error('❌ FAIL: final_answer contains code blocks or imports')
      throw new Error('Code blocks in final_answer')
    }
    console.log('✅ PASS: final_answer is human-readable summary')
  }

  console.log('')
  console.log('=== All checks passed ===')
}

test().catch(err => {
  console.error('Unhandled error:', err)
  throw err
})
