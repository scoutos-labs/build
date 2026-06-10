// Server-side copy of the agent prompt assembly. Source of truth moves here;
// the client copies in src/agent.ts and src/design-guidance.ts are deleted in
// Phase 3 of docs/managed-openrouter-migration-plan.md.

export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ProjectFile = { path: string; content: string }
export type AgentPatch = { path: string; content: string }
export type AgentResult = { reply: string; patches: AgentPatch[] }

export type SelectedPreviewElement = {
  tagName: string
  id: string
  classes: string[]
  textContent: string
  outerHTML: string
  boundingRect: { x: number; y: number; width: number; height: number }
  computedStyles: Record<string, string>
}

export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }

const anthropicBrandGuidelines = `Anthropic brand guide:
- Main colors: Dark #141413, Light #faf9f5, Mid Gray #b0aea5, Light Gray #e8e6dc.
- Accent colors: Orange #d97757, Blue #6a9bcc, Green #788c5d.
- Typography: headings use Poppins with Arial fallback; body text uses Lora with Georgia fallback.
- Use brand colors with restrained confidence, preserving readability and hierarchy.`

const anthropicFrontendDesignSkill = `Frontend design skill:
- Build distinctive, production-grade interfaces with a clear aesthetic point of view.
- Avoid generic AI aesthetics: predictable SaaS layouts, purple gradients, nested cards, default fonts, and cookie-cutter components.
- Make deliberate choices in typography, color, spacing, layout, motion, and visual details.
- Match implementation complexity to the aesthetic vision: maximal designs need rich details; minimal designs need precision.
- Use accessible, working code and preserve app functionality.`

const scoutBrandStyles = `Scout Studio observed brand styles from https://studio.scoutos.com:
- Overall register: restrained product UI, crisp, quiet, high-trust, monochrome-first.
- Font: GeistSans with GeistSans Fallback; use system sans fallback only after Geist.
- Base background: white / oklch(1 0 0); primary text around oklch(0.3211 0 0) or rgb(33 33 38).
- Secondary text: dark text at roughly 65% opacity.
- Primary controls: near-charcoal rgb(47 48 55) backgrounds with white text.
- Inputs/buttons: compact 13px text, 6px border radius, 6px 12px padding, subtle 1px ring shadows instead of heavy borders.
- Shadows: minimal layered rings and tiny elevation, e.g. 0 0 0 1px low-alpha black plus small 1-3px y shadow.
- App shell: pale gray left sidebar around 314px wide with a fine divider, white main canvas, sparse navigation, muted gray labels, and blue active/action accents.
- Home screen composition: large centered greeting block with dark heading and oversized muted-gray subheading, followed by a wide rounded prompt composer.
- Composer styling: 1px rainbow/blue-pink focus ring or gradient border, large radius around 16px, ample internal whitespace, subdued placeholder text, small icon row, and a quiet send button.
- Chat list: compact rows with 28-32px circular avatars, soft gradient placeholders, 15-16px gray labels, clipped long titles.
- Tool/banner surfaces: very light gray rounded rectangles, small integration icons, low-contrast utility copy.
- Layout: compact controls with generous surrounding whitespace; the interface feels airy without being decorative.
- Avoid decorative gradients except subtle avatar fills and fine focus rings; prefer precise spacing, crisp controls, and quiet contrast.`

function designGuidancePrompt() {
  return `${anthropicFrontendDesignSkill}\n\n${anthropicBrandGuidelines}\n\n${scoutBrandStyles}`
}

export const JSON_SYSTEM_PROMPT = `You are an app-building agent inside a browser-only StackBlitz WebContainer.
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

function summarizeSelectedElement(element: SelectedPreviewElement) {
  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ''
  const className = element.classes[0] ? `.${element.classes[0]}` : ''
  return `${tag}${id}${className}`
}

function buildSelectedElementPrompt(args: { comment: string; element: SelectedPreviewElement }) {
  const { element, comment } = args
  return `Improve the selected preview element based on the user's comment.

User comment:
${comment}

Selected rendered element:
Summary: ${summarizeSelectedElement(element)}
Tag: ${element.tagName}
ID: ${element.id || '(none)'}
Classes: ${element.classes.join(' ') || '(none)'}
Text: ${element.textContent || '(none)'}
Bounds: ${JSON.stringify(element.boundingRect)}
Computed styles: ${JSON.stringify(element.computedStyles, null, 2)}
Outer HTML:
${element.outerHTML}

Update the source files that render and style this selected element. Preserve the Build inspector import and src/build-inspector.ts.`
}

function projectContext(files: ProjectFile[]) {
  return files.map(file => `--- ${file.path}\n${file.content}`).join('\n\n')
}

export type AgentRequestBody = {
  userPrompt: string
  files: ProjectFile[]
  messages: ChatMessage[]
  selectedElement?: SelectedPreviewElement
  elementComment?: string
}

export function buildModelMessages(body: AgentRequestBody): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'system', content: JSON_SYSTEM_PROMPT }]
  if (body.files.length > 0) {
    messages.push({ role: 'system', content: `Current project files:\n\n${projectContext(body.files)}` })
  }
  if (body.selectedElement && body.elementComment) {
    messages.push({
      role: 'system',
      content: buildSelectedElementPrompt({ element: body.selectedElement, comment: body.elementComment }),
    })
  }
  for (const msg of body.messages) {
    messages.push({ role: msg.role, content: msg.content })
  }
  messages.push({ role: 'user', content: body.userPrompt })
  return messages
}

export function extractJson(text: string): AgentResult {
  const raw = findJsonObject(text)
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.patches) || typeof parsed.reply !== 'string') {
    throw new Error('Agent response did not match expected JSON shape')
  }
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
