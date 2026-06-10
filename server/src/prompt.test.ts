import { describe, expect, it } from 'vitest'
import { buildModelMessages, extractJson, JSON_SYSTEM_PROMPT } from './prompt.js'

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
