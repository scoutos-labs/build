import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './agent'
import { CLIENT_TOOL_SPECS } from './agent-tools'

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

  it('extracts the JSON-mode Rules block unambiguously', () => {
    // The tool-mode rules live in a TS array (SHARED_RULES), not a second
    // literal "Rules:" block, so the first-match extraction above stays
    // unambiguous. If tool mode ever grows a literal block, this fails and the
    // extraction must become mode-aware rather than order-dependent.
    const literalBlocks = serverSource.match(/^Rules:\n(?:- .*\n)+/gm) ?? []
    expect(literalBlocks).toHaveLength(1)
  })
})

// The tool specs are the second intentionally-duplicated surface: the server
// declares what the model may call (managed mode) and the client executes it
// (src/agent-tools.ts). A disagreement means the model is offered a tool nothing
// will run — which shows up as a stalled turn, not an error. Hence this guard.
const serverToolSource = readFileSync(resolve(__dirname, '../server/src/agent-tools.ts'), 'utf-8')
const agentActorSource = readFileSync(
  resolve(__dirname, 'build/actors/agent.gleam'),
  'utf-8',
)

// Rules that may appear ONLY server-side. Web tools live behind Clerk auth and
// the server's SSRF guard, so BYOK is never offered them — and must never be
// told about them, or the model will call a tool that does not exist.
const SERVER_ONLY_RULE_MARKERS = ['web_search', 'web_fetch', 'web_post']

describe('client/server tool-spec parity', () => {
  it('offers exactly the same tool names on both sides', () => {
    const clientNames = CLIENT_TOOL_SPECS.map(spec => spec.function.name)
    const serverNames = [...serverToolSource.matchAll(/name: '([a-z_]+)'/g)].map(match => match[1])
    expect(serverNames).toEqual(clientNames)
  })

  it('keeps every tool description identical', () => {
    // A description is the model's entire understanding of a tool; drift here is
    // silent and behavioural.
    for (const spec of CLIENT_TOOL_SPECS) {
      const { name, description } = spec.function
      expect(
        serverToolSource.includes(description),
        `description for ${name} differs between src/agent-tools.ts and server/src/agent-tools.ts`,
      ).toBe(true)
    }
  })

  it('keeps MAX_CALLS_PER_STEP in step with the Gleam actor', () => {
    const server = constant(serverToolSource, /MAX_CALLS_PER_STEP = (\d+)/, 'server/src/agent-tools.ts')
    const gleam = constant(agentActorSource, /max_calls_per_step = (\d+)/, 'agent.gleam')
    expect(server).toBe(gleam)
  })

  it('keeps MAX_TOOL_STEPS in step between the server token and the Gleam actor', () => {
    const stepTokenSource = readFileSync(resolve(__dirname, '../server/src/step-token.ts'), 'utf-8')
    const server = constant(stepTokenSource, /MAX_TOOL_STEPS = (\d+)/, 'server/src/step-token.ts')
    const gleam = constant(agentActorSource, /max_tool_steps = (\d+)/, 'agent.gleam')
    expect(server).toBe(gleam)
  })

  it('never names a web tool in the client tool surface', () => {
    const clientToolSource = readFileSync(resolve(__dirname, 'agent-tools.ts'), 'utf-8')
    for (const marker of SERVER_ONLY_RULE_MARKERS) {
      // Allowed in the runTool refusal list (which explains they are
      // unavailable); never as an offered spec.
      const names = CLIENT_TOOL_SPECS.map(spec => spec.function.name)
      expect(names).not.toContain(marker)
      expect(clientToolSource.includes(`name: '${marker}'`)).toBe(false)
    }
  })

  it('marks no client tool as approval-gated', () => {
    // "Trust the sandbox": fs_* and exec run unattended. If a refactor ever
    // inverts that, this is the tripwire.
    for (const spec of CLIENT_TOOL_SPECS) {
      expect(spec.function.description.toLowerCase()).not.toMatch(/requires the user to approve/)
    }
  })
})

// The job picker's model ids are a fourth duplicated surface: Gleam offers them
// to the user, the server validates and uses them. A drift here means the picker
// offers a model the server would reject as non-tool-capable — which surfaces as
// a turn that will not start.
describe('job picker / curated model parity', () => {
  const settingsSource = readFileSync(resolve(__dirname, 'build/actors/settings.gleam'), 'utf-8')
  const modelsSource = readFileSync(resolve(__dirname, '../server/src/models.ts'), 'utf-8')

  /** `Quick -> "id"` pairs from settings.gleam's job_model. */
  function gleamJobModels(): string[] {
    const block = settingsSource.match(/pub fn job_model\(job: Job\) -> String \{[\s\S]*?\n\}/)
    if (!block) throw new Error('job_model not found in settings.gleam')
    return [...block[0].matchAll(/-> "([^"]+)"/g)].map(match => match[1]!)
  }

  /** First entry of each chain in server/src/models.ts CURATED_CHAINS. */
  function serverFirstChoices(): string[] {
    const choices = [...modelsSource.matchAll(/chain: \[\s*'([^']+)'/g)].map(match => match[1]!)
    if (choices.length === 0) throw new Error('No CURATED_CHAINS chains found in server/src/models.ts')
    return choices
  }

  it('offers exactly the server curated chains first choices, in order', () => {
    expect(gleamJobModels()).toEqual(serverFirstChoices())
  })

  it('offers three jobs', () => {
    expect(gleamJobModels()).toHaveLength(3)
  })

  it('never puts a model id in a job label', () => {
    const labels = settingsSource.match(/pub fn job_label\(job: Job\) -> String \{[\s\S]*?\n\}/)![0]
    for (const id of serverFirstChoices()) expect(labels).not.toContain(id)
    expect(labels).not.toContain('/')
  })
})
