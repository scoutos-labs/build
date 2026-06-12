import { describe, expect, it } from 'vitest'
import {
  buildModelMessages,
  extractJson,
  FILE_CONTEXT_CHAR_BUDGET,
  JSON_SYSTEM_PROMPT,
  selectContextFiles,
} from './prompt.js'

describe('extractJson', () => {
  it('parses a clean JSON object', () => {
    const result = extractJson('{"reply":"done","patches":[{"path":"a.ts","content":"x"}]}')
    expect(result.reply).toBe('done')
    expect(result.patches).toHaveLength(1)
  })

  it('strips markdown fences', () => {
    const result = extractJson('```json\n{"reply":"ok","patches":[]}\n```')
    expect(result.reply).toBe('ok')
  })

  it('extracts an embedded object from surrounding prose', () => {
    const result = extractJson('Sure! Here you go: {"reply":"ok","patches":[]} hope that helps')
    expect(result.reply).toBe('ok')
  })

  it('rejects output with no JSON', () => {
    expect(() => extractJson('I cannot help with that')).toThrow()
  })

  it('rejects JSON missing the expected shape', () => {
    expect(() => extractJson('{"message":"hi"}')).toThrow()
  })
})

describe('buildModelMessages', () => {
  it('assembles system prompt, files, element context, history, and user prompt in order', () => {
    const messages = buildModelMessages({
      userPrompt: 'add a button',
      files: [{ path: 'src/main.tsx', content: 'console.log(1)' }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      selectedElement: {
        tagName: 'BUTTON',
        id: 'cta',
        classes: ['primary'],
        textContent: 'Go',
        outerHTML: '<button id="cta">Go</button>',
        boundingRect: { x: 0, y: 0, width: 10, height: 10 },
        computedStyles: { color: 'red' },
      },
      elementComment: 'make it calmer',
    })

    expect(messages[0]).toEqual({ role: 'system', content: JSON_SYSTEM_PROMPT })
    expect(messages[1]?.content).toContain('--- src/main.tsx')
    expect(messages[2]?.content).toContain('make it calmer')
    expect(messages[2]?.content).toContain('button#cta.primary')
    expect(messages[3]).toEqual({ role: 'user', content: 'hi' })
    expect(messages[4]).toEqual({ role: 'assistant', content: 'hello' })
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'add a button' })
  })

  it('omits files and element sections when absent', () => {
    const messages = buildModelMessages({ userPrompt: 'hi', files: [], messages: [] })
    expect(messages).toHaveLength(2)
  })
})

describe('context selection', () => {
  const bigFile = (path: string) => ({ path, content: 'x'.repeat(60_000) + '\nlast line' })

  it('sends every file in full when the project fits the budget', () => {
    const files = [
      { path: 'package.json', content: '{}' },
      { path: 'src/main.tsx', content: 'render()' },
    ]
    const selected = selectContextFiles({ userPrompt: 'hi', files, messages: [] })
    expect(selected.every(file => !file.stub)).toBe(true)
  })

  it('keeps skeleton and mentioned files full, stubs unreferenced bulk', () => {
    const files = [
      { path: 'package.json', content: '{"name":"app"}' },
      bigFile('src/main.tsx'),
      bigFile('src/big-a.ts'),
      bigFile('src/big-b.ts'),
      bigFile('src/big-c.ts'),
    ]
    const messages = buildModelMessages({ userPrompt: 'change the header in main.tsx', files, messages: [] })
    const filesMessage = messages[1]!.content
    expect(filesMessage).toContain('--- package.json\n')
    expect(filesMessage).toContain('--- src/main.tsx\n')
    expect(filesMessage).toMatch(/--- src\/big-c\.ts \[stub: first \d+ of \d+ lines\]/)
    expect(filesMessage).toContain('Never write a patch for a stubbed file')
    expect(filesMessage.length).toBeLessThan(FILE_CONTEXT_CHAR_BUDGET + 20_000)
  })

  it('promotes a file named in recent chat history to full', () => {
    const files = [bigFile('src/big-a.ts'), bigFile('src/big-b.ts'), bigFile('src/big-c.ts')]
    const selected = selectContextFiles({
      userPrompt: 'yes, go ahead',
      files,
      messages: [{ role: 'assistant', content: 'I need src/big-c.ts in full to make that change.' }],
    })
    expect(selected.find(file => file.path === 'src/big-c.ts')?.stub).toBe(false)
  })

  it('keeps files matching the selected element full', () => {
    const files = [
      { path: 'src/hero.tsx', content: 'x'.repeat(60_000) + ' className="hero-banner"' },
      bigFile('src/big-a.ts'),
      bigFile('src/big-b.ts'),
      bigFile('src/big-c.ts'),
    ]
    const selected = selectContextFiles({
      userPrompt: 'make this calmer',
      files,
      messages: [],
      elementComment: 'too loud',
      selectedElement: {
        tagName: 'DIV',
        id: '',
        classes: ['hero-banner'],
        textContent: '',
        outerHTML: '<div class="hero-banner"></div>',
        boundingRect: { x: 0, y: 0, width: 1, height: 1 },
        computedStyles: {},
      },
    })
    expect(selected.find(file => file.path === 'src/hero.tsx')?.stub).toBe(false)
  })
})
