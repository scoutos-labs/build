/**
 * Agent personas — standing instructions the user gives Build itself.
 *
 * One file today: `.build/agents/hyper/user.md`, global scope. It holds the
 * things a user would otherwise retype every turn — "I use Tailwind", "keep
 * copy in lowercase", "prefer server components". Build injects it at the top
 * of every turn so they say it once.
 *
 * ## Why this is trusted and skills are not
 *
 * A persona is injected as **guidance the agent should follow**. The skills
 * manifest, three feet away in the same prompt, is injected as untrusted data.
 * That asymmetry is not a mood — it rests on exactly one property:
 *
 *   **The agent cannot write this file.**
 *
 * `.build/agents/` is refused by `fs_write`, `fs_batch_write` and `fs_delete`
 * (see `AGENT_OWNED_PREFIX` in `agent-tools.ts`). Only the user can author a
 * persona. A skill file, by contrast, *is* agent-writable, which is why a
 * prompt injection reaching one tool call could plant one and have it re-read
 * with authority every turn afterwards.
 *
 * So: if you ever make this path writable by a tool, you must simultaneously
 * demote the persona to untrusted framing. The two facts move together. There
 * is a test that fails if the write ban regresses — leave it that way.
 *
 * The agent may still `fs_read` its persona. Reading is what makes it useful.
 */

import { GLOBAL_SCOPE, readWorkspaceFile } from './workspace-store'

export const AGENTS_PREFIX = '.build/agents/'

/** The single built-in agent. A named folder now so a second one is additive. */
export const PERSONA_PATH = `${AGENTS_PREFIX}hyper/user.md`

/**
 * Cap. A persona rides in *every* turn, so unlike a skill body — pulled only
 * when relevant — its cost is unconditional. Long past this the user is really
 * writing a skill, and the truncation notice says so rather than silently
 * dropping the tail.
 */
export const MAX_PERSONA_CHARS = 4000

export async function readPersona(scope = GLOBAL_SCOPE): Promise<string> {
  try {
    return (await readWorkspaceFile(PERSONA_PATH, scope)) ?? ''
  } catch {
    return '' // a persona that cannot be read is not worth failing a turn over
  }
}

/**
 * The prompt block, or `''` when there is nothing to say.
 *
 * Empty in, empty out: a user who has never opened the persona editor pays no
 * context for the feature existing.
 */
export function buildPersonaPrompt(source: string): string {
  const text = source.trim()
  if (!text) return ''

  const truncated = text.length > MAX_PERSONA_CHARS
  const body = truncated
    ? `${text.slice(0, MAX_PERSONA_CHARS)}\n\n[...truncated — the rest was over the ${MAX_PERSONA_CHARS}-character limit. Move standing detail into a skill instead.]`
    : text

  return [
    'The person you are building for wrote the following standing instructions.',
    'They apply to every turn. Follow them as you would the rules above; where they',
    'conflict with a specific request in this turn, the request wins.',
    '',
    body,
  ].join('\n')
}
