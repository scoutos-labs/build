/**
 * Tool specifications offered to the model in managed mode.
 *
 * **This file is intentionally duplicated** with `src/agent-tools.ts`
 * (`CLIENT_TOOL_SPECS`) and guarded by `src/prompt-parity.test.ts`, following
 * the pattern already used for the system prompt and the starter template. The
 * client and the server are separate packages with separate builds, so they
 * cannot import from one another; a drift test is how this repo keeps such pairs
 * honest.
 *
 * The server declares what the model may call. The client executes it. If these
 * two lists disagree, the model is offered a tool nothing will run — which
 * surfaces as a mysteriously stalled turn, not an error. Hence the guard.
 */

export type ToolSpec = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Tool calls honored from one step. Mirrors `max_calls_per_step` in
 * `src/build/actors/agent.gleam`. */
export const MAX_CALLS_PER_STEP = 3

/**
 * Injected when a turn has one step left, or when the assembled prompt has
 * outgrown its budget.
 *
 * Paired with offering no tools on that step, which is what makes it binding
 * rather than advisory. Ending a long turn with a usable answer beats ending it
 * with an error that discards everything the agent already did.
 */
export const STEP_BUDGET_NUDGE =
  "This is your last step for this turn — no more tools are available. Write your best answer now from what you have already done, in plain language for a non-technical founder, and say plainly if anything is unfinished or unverified."

export const CLIENT_TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description:
        "List the project's files with their sizes. Start here when you don't know what exists.",
      parameters: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional path prefix, e.g. "src/components/".' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description:
        'Read a project file. Read before you rewrite — never guess at a file you have not seen. Set from_container to read build output instead of source.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root, e.g. "src/App.tsx".' },
          from_container: {
            type: 'boolean',
            description: 'Read from the running app (build artifacts, logs) rather than the project source.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_write',
      description:
        'Write one file, replacing it entirely. Send the complete file, never a fragment or a diff. Use fs_batch_write for a related set.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the project root.' },
          content: { type: 'string', description: 'The complete file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_batch_write',
      description:
        'Write several related files at once. All of them save together or none do, so a refactor never lands half-applied. Prefer this over several fs_write calls.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'The files to write together.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string', description: 'The complete file content.' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description:
        "Run a command in the project's Node environment and read its real output. This is how you check your own work: `npx tsc --noEmit` to typecheck, `npm run build` to build, `npm install <pkg>` to add a dependency. Available commands are npm, npx (tsc or vite), and node. Do not start the dev server — it is already running and reloads your changes. Verify before you hand back.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'npm, npx, or node.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arguments, e.g. ["tsc", "--noEmit"]. Passed directly, not through a shell.',
          },
          timeout_ms: { type: 'number', description: 'Optional, default 120000, max 180000.' },
        },
        required: ['command'],
      },
    },
  },
]

/** Names the client is expected to be able to execute. */
export const CLIENT_TOOL_NAMES = CLIENT_TOOL_SPECS.map(spec => spec.function.name)
