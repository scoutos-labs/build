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
- Use Tailwind CSS for styling and shadcn/ui for components.
- Tailwind, PostCSS, and the cn() helper in src/lib/utils.ts are preconfigured; do not modify tailwind.config.js or postcss.config.js, and only change package.json to add a genuinely new dependency.
- For persistence, use the db client in src/db.ts; it calls the hyper-zepto data port that zepto-bridge.js serves at /api/db (mounted by vite.config.ts in dev and server.js in production). Never import hyper-zepto in browser code.
- Preserve vite.config.ts, zepto-bridge.js, and server.js (they host the database API and the production server) unless the user explicitly asks to change the backend.
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

/**
 * Context selection: under the budget the whole project ships — full context
 * can't be beaten when it's affordable. Over it, files the request plausibly
 * touches stay full and the rest shrink to stubs the model can ask about.
 */
export const FILE_CONTEXT_CHAR_BUDGET = 160_000
const STUB_LINES = 20
/** Caps a stub regardless of line count — one minified line can be huge. */
const STUB_MAX_CHARS = 1000
/** Project skeleton, always sent in full so the model can reason about structure. */
const ALWAYS_FULL = new Set(['package.json', 'vite.config.ts', 'zepto-bridge.js', 'server.js', 'index.html', 'src/db.ts'])
const SMALL_FILE_CHARS = 1500
/** Trailing chat messages scanned for file mentions — this is also what makes
 * "ask for a stubbed file" work: the model names the path in its reply, the
 * reply lands in history, and the next request promotes that file to full. */
const RECENT_MESSAGES = 6

export type ContextFile = ProjectFile & { stub: boolean }

function basename(path: string) {
  return path.split('/').at(-1) ?? path
}

export function selectContextFiles(body: AgentRequestBody): ContextFile[] {
  const total = body.files.reduce((sum, file) => sum + file.content.length, 0)
  if (total <= FILE_CONTEXT_CHAR_BUDGET) return body.files.map(file => ({ ...file, stub: false }))

  const mentionText = [
    body.userPrompt,
    ...body.messages.slice(-RECENT_MESSAGES).map(message => message.content),
    body.elementComment ?? '',
  ].join('\n')
  const elementMarkers = [body.selectedElement?.id, ...(body.selectedElement?.classes ?? [])].filter(
    (marker): marker is string => !!marker,
  )

  const priority = (file: ProjectFile): number => {
    if (ALWAYS_FULL.has(file.path)) return 0
    if (mentionText.includes(file.path) || mentionText.includes(basename(file.path))) return 1
    if (elementMarkers.some(marker => file.content.includes(marker))) return 2
    if (file.content.length <= SMALL_FILE_CHARS) return 3
    return 4
  }

  const ranked = body.files
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
  return body.files.map(file => ({ ...file, stub: stubbed.has(file.path) }))
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
    const contextFiles = selectContextFiles(body)
    const note = contextFiles.some(file => file.stub) ? STUB_NOTE : ''
    messages.push({ role: 'system', content: `Current project files:\n\n${projectContext(contextFiles)}${note}` })
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
