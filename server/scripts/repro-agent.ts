// Reproduce a real browser agent call against the local server.
// Usage: CLERK_SESSION_ID=sess_... npx tsx --env-file=.env scripts/repro-agent.ts
// (find the session id via GET https://api.clerk.com/v1/sessions?user_id=...)
import { starterFiles } from '../../src/templates'

const SESSION_ID = process.env.CLERK_SESSION_ID ?? ''
if (!SESSION_ID) throw new Error('Set CLERK_SESSION_ID')

async function mintJwt(): Promise<string> {
  const response = await fetch(`https://api.clerk.com/v1/sessions/${SESSION_ID}/tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const data = (await response.json()) as { jwt?: string }
  if (!data.jwt) throw new Error(`No jwt: ${JSON.stringify(data).slice(0, 200)}`)
  return data.jwt
}

const jwt = await mintJwt()
const started = Date.now()
const response = await fetch('http://localhost:3000/api/agent', {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userPrompt: 'build a simple hello world app with a counter',
    files: starterFiles,
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content:
          "Welcome to Build! I'm ready to help you create a web app. Let's start by answering some questions about your project idea.",
      },
    ],
  }),
})
const body = await response.text()
console.log(`status=${response.status} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s len=${body.length}`)
const parsed = JSON.parse(body)
if (parsed.patches) {
  console.log('reply:', parsed.reply)
  console.log('patches:', parsed.patches.map((p: { path: string; content: string }) => `${p.path} (${p.content.length} chars)`))
} else {
  console.log(body.slice(0, 300))
}
