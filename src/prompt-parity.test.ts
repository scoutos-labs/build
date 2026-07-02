import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './agent'

// The agent prompt is assembled in two places until the planned Phase-3
// unification: src/agent.ts (client, non-managed mode) and
// server/src/prompt.ts (managed mode, declared source of truth). These tests
// compare the client's BUILT prompt (its rules live in a TS array now)
// against the server's source literal, so a rule added to one side only
// fails loudly. Client-only additions must be listed in CLIENT_ONLY_RULES.

const clientSource = readFileSync(resolve(__dirname, 'agent.ts'), 'utf-8')
const clientPrompt = buildSystemPrompt()
const serverSource = readFileSync(resolve(__dirname, '../server/src/prompt.ts'), 'utf-8')

// The .env/envVars mechanism only exists in the client protocol today.
const CLIENT_ONLY_RULES = [
  '- Secrets and API keys are set in the .env file; set them via the envVars field in your response.',
]

function rulesBlock(source: string, file: string): string[] {
  const match = source.match(/^Rules:\n((?:- .*\n)+)/m)
  if (!match) throw new Error(`No "Rules:" block found in ${file}`)
  return match[1].trimEnd().split('\n')
}

function constant(source: string, pattern: RegExp, file: string): string {
  const match = source.match(pattern)
  if (!match) throw new Error(`Pattern ${pattern} not found in ${file}`)
  return match[1]
}

describe('client/server prompt parity', () => {
  it('keeps the system prompt rules identical (minus declared client-only rules)', () => {
    const clientRules = rulesBlock(clientPrompt, 'built client prompt (buildSystemPrompt)')
    const serverRules = rulesBlock(serverSource, 'server/src/prompt.ts')

    const clientShared = clientRules.filter(rule => !CLIENT_ONLY_RULES.includes(rule))
    expect(clientShared).toEqual(serverRules)
    // every declared client-only rule must actually exist client-side
    for (const rule of CLIENT_ONLY_RULES) expect(clientRules).toContain(rule)
  })

  it('keeps the planning and self-verification sections identical', () => {
    const section = (text: string, pattern: RegExp, where: string) => {
      const match = text.match(pattern)
      if (!match) throw new Error(`Section ${pattern} not found in ${where}`)
      return match[0]
    }
    const planning = /^Planning: .*$/m
    const verification = /^Self-verification \(before returning\):\n(?:- .*\n)+/m
    expect(section(clientPrompt, planning, 'client prompt'))
      .toBe(section(serverSource, planning, 'server/src/prompt.ts'))
    expect(section(clientPrompt, verification, 'client prompt'))
      .toBe(section(serverSource, verification, 'server/src/prompt.ts'))
  })

  it('keeps the context budget identical', () => {
    const client = constant(clientSource, /FILE_CONTEXT_CHAR_BUDGET = (\d[\d_]*)/, 'src/agent.ts')
    const server = constant(serverSource, /FILE_CONTEXT_CHAR_BUDGET = (\d[\d_]*)/, 'server/src/prompt.ts')
    expect(client).toBe(server)
  })

  it('keeps the ALWAYS_FULL file set identical', () => {
    const setOf = (source: string, file: string) =>
      constant(source, /ALWAYS_FULL = new Set\(\[([^\]]*)\]\)/, file)
        .split(',').map(entry => entry.trim()).filter(Boolean).sort()
    expect(setOf(clientSource, 'src/agent.ts')).toEqual(setOf(serverSource, 'server/src/prompt.ts'))
  })

  it('keeps the BRAIN.md guard identical', () => {
    const maxChars = (source: string, file: string) => constant(source, /BRAIN_MAX_CHARS = (\d[\d_]*)/, file)
    const note = (source: string, file: string) => constant(source, /BRAIN_TRUNCATION_NOTE = '([^']*)'/, file)
    expect(maxChars(clientSource, 'src/agent.ts')).toBe(maxChars(serverSource, 'server/src/prompt.ts'))
    expect(note(clientSource, 'src/agent.ts')).toBe(note(serverSource, 'server/src/prompt.ts'))
  })

  it('keeps the stub note and stub limits identical', () => {
    const stubNote = (source: string, file: string) =>
      constant(source, /const STUB_NOTE = `\n\n([\s\S]*?)`/, file)
    expect(stubNote(clientSource, 'src/agent.ts')).toBe(stubNote(serverSource, 'server/src/prompt.ts'))
    const stubLines = (source: string, file: string) => constant(source, /STUB_LINES = (\d+)/, file)
    const stubChars = (source: string, file: string) => constant(source, /STUB_MAX_CHARS = (\d+)/, file)
    expect(stubLines(clientSource, 'src/agent.ts')).toBe(stubLines(serverSource, 'server/src/prompt.ts'))
    expect(stubChars(clientSource, 'src/agent.ts')).toBe(stubChars(serverSource, 'server/src/prompt.ts'))
  })
})
