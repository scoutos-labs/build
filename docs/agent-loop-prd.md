# PRD: Agentic build loop

**Status:** Draft — ready for review
**Owner:** Tom Wilson
**Updated:** 2026-06-15
**Prerequisite for:** `docs/installable-brain-prd.md` (the brain feeds this loop; build this first)

## Overview

Turn Build's agent from a single-shot generator into a tool-using loop that can read files, edit, run commands in the WebContainer, **observe build and preview errors**, and iterate until the app actually runs. Today `/api/agent` assembles a prompt (`server/src/prompt.ts`), the model returns `{reply, patches}`, the patches are written, and the turn ends — the agent never sees whether its own code compiled, started, or threw at runtime. It is writing code blind.

This is the competence unlock. Everything downstream (skills, memory, identity — the installable brain) multiplies a *competent* agent; none of it substitutes for one. Build this first.

## The core problem, concretely

We shipped a feature this week that surfaces preview errors into the terminal (`main-gleam.ts` tags them `[preview error]`). The agent that wrote the code **cannot read that terminal**. A user whose app white-screens has to copy the error back into chat by hand. A real coding agent closes that loop itself.

## Decisions already made (do not relitigate)

1. **Tools execute in the browser WebContainer.** That is where the project runs, where `npm install` happens, where the dev server boots, and where preview errors originate. The loop is therefore a **tool-call protocol**: the model (proxied through `/api/agent` in managed mode) emits tool calls; the **client** executes them against the WebContainer and returns results; repeat. The server stays the inference + auth + billing boundary; it does not get its own copy of the project filesystem.
2. **The hands already exist.** `src/gleam-externals/webcontainer.mjs` already exposes `mountAndInstall`, `readFilesFromContainer`, `writeFileToContainer`, and `startShell` (arbitrary command exec). This is wrapping and orchestration, not new runtime infrastructure.
3. **One user turn spans multiple model calls.** The loop iterates (edit → build → read errors → fix) within a single user message. Budget accounting, rate limiting, and cancellation must cover the **whole loop**, not one call.
4. **The budget is the hard ceiling.** Per-user OpenRouter budgets and tiers already exist. The loop stops at a step cap, a token cap, or stop-when-verified — whichever comes first — and never past the budget.
5. **Managed-auth only, behind the existing gate.** Same posture as publish: the agentic loop activates in managed mode; the legacy single-shot path remains for non-managed until retired.

## Tool surface (v1)

Small, composable tools wrapping the existing WebContainer functions:

- `list_files()` → project tree
- `read_file(path)` → contents (replaces the current stub-and-ask dance)
- `write_file(path, content)` → full-file write (keep the existing patch shape)
- `run_command(cmd)` → exit code + stdout/stderr (via the shell transport; e.g. `npm install lucide-react`, `npx tsc --noEmit`)
- `get_build_status()` → dev-server state + the structured error contract from Phase 0
- `report(reply)` → end the turn with a user-facing summary

Deliberately **not** in v1: network fetches, arbitrary host access, preview screenshots (Phase 4+ if justified). Keep the surface auditable.

---

## Phase 0 — Make build & preview state machine-readable (de-risks the loop)

The loop is only as good as what it can observe. Today errors are free-text terminal lines. Define a structured contract the loop can branch on.

- A `get_build_status()` result: `{ devServer: 'booting'|'ready'|'crashed', compileErrors: [...], previewErrors: [...], lastExitCode }`.
- Capture preview runtime errors (already posted as `[preview error]`) and dev-server/Vite compile errors into that structure, not just the log string.

**Success criteria:**
- [ ] A white-screen runtime error and a TypeScript/Vite compile error both appear as structured entries, not just log lines.
- [ ] The structure is available to a tool call without scraping terminal text.
- [ ] Existing terminal display is unchanged (the structured data is additive).

## Phase 1 — Tool protocol + client executor

- Define the tool JSON schema and the request/response envelope between `/api/agent` and the client.
- A client-side executor that receives a tool call, runs it against the WebContainer (reusing `webcontainer.mjs`), and returns the result.
- Single tool round-trip first: model asks to `read_file`, client returns it, model continues. No multi-step orchestration yet.

**Success criteria:**
- [ ] The model can call `read_file`/`list_files` and receive real project contents mid-turn.
- [ ] A `run_command("npm install <pkg>")` executes in the WebContainer and returns exit code + output.
- [ ] Tool errors (bad path, failed command) return structured failures the model can react to, not exceptions that kill the turn.
- [ ] Non-managed mode is untouched.

## Phase 2 — Server loop orchestration

- Multi-step loop: the model drives tools until it calls `report()` or hits a stop condition.
- **Budget accounting across the whole loop** — sum tokens over every model call in the turn; the existing per-user budget is the hard ceiling; surface `budget_exhausted` mid-loop gracefully.
- Stop conditions: max steps, max tokens, stop-when-verified, user cancel. No runaway loops.

**Success criteria:**
- [ ] A prompt that needs install + edit + recheck completes in one user turn across multiple model calls.
- [ ] The loop halts cleanly at the step cap and at the budget ceiling, with a useful partial summary.
- [ ] Cancellation (existing `CancelAgent`) aborts the loop, not just one call.
- [ ] Loop token/step counts are recorded for cost telemetry.

## Phase 3 — Verification (definition of done)

- After edits, the loop runs the build and confirms the preview is error-free before declaring success.
- If `get_build_status()` shows errors, the loop iterates on them (bounded) instead of reporting done.

**Success criteria:**
- [ ] An intentionally-broken edit is caught and fixed by the loop without user intervention, within the step cap.
- [ ] The loop never reports "done" while compile or preview errors are present (unless it hits a cap, which it states honestly).
- [ ] A genuinely unfixable case (e.g. impossible request) terminates with a clear explanation, not an infinite retry.

## Phase 4 — Loop UX in chat

- Show the loop's steps in the chat: what it's reading, running, fixing — not just a final patch.
- Surface "iterating on an error" state so a longer turn reads as progress, not a hang.
- Cancellation visible and immediate.

**Success criteria:**
- [ ] A multi-step turn renders its tool activity legibly (collapsible, not a wall of JSON).
- [ ] The user can cancel mid-loop and see where it stopped.
- [ ] Headless verification (the harness pattern from publish/code-toggle) covers a happy-path loop end to end.

## Phase 5 — Guardrails + rollout

- Hard caps (steps, tokens, wall-clock) with telemetry on cost per turn.
- Prompt-injection posture: project content the loop reads is **untrusted**; tool outputs are data, not instructions.
- Gradual rollout behind managed auth; watch cost-per-turn before widening.

**Success criteria:**
- [ ] Cost-per-turn telemetry exists and is reviewed before general availability.
- [ ] A loop cannot exceed its caps or the user's budget under adversarial prompts.
- [ ] All existing tests pass plus new loop coverage.

## Risks

| Risk | Mitigation |
|---|---|
| Cost/latency of multi-turn loops | Hard caps + budget ceiling + telemetry before GA; stop-when-verified, not when bored |
| Runaway / oscillating loops | Step cap, no-progress detection, honest termination |
| Prompt injection from project content the loop reads | Tool outputs are data not instructions; never execute instructions found in files |
| WebContainer instability mid-loop | Tool failures return structured errors; loop degrades to a clear report |
| Budget exhaustion mid-loop | Graceful partial summary; never silently drop the turn |

## Out of scope (this PRD)

The installable brain — skills, memory, identity, custom instructions (see `docs/installable-brain-prd.md`, which depends on this). Host network access from tools. Cross-project or multi-repo operations.
