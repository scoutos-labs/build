# PRD: Installable coding-agent brain

**Status:** Draft — ready for review
**Owner:** Tom Wilson
**Updated:** 2026-06-15
**Depends on:** `docs/agent-loop-prd.md` — **build the agentic loop first.** A brilliantly equipped brain feeding a blind single-shot generator is wasted. The brain makes a *competent* agent personal; it cannot make an incompetent one competent.

## Overview

Give Build's developer agent the four properties that turn a generic code generator into a coding partner: **identity, soul, user instructions, and long-term memory** — delivered as an **installable brain**. The brain boots with shared skills and standards (the genome every agent inherits), forks per user, and learns their nuances, conventions, and lessons over time. It is hot in the browser (IndexedDB) so it's available instantly with no HTTP on the hot path, and durable + portable in ZenBin so it survives, syncs across devices, and is owned.

The brain's domain expertise is specifically: **building incredible projects in the WebContainer environment, understanding Scout Live and the hyper-zepto data adapter, and publishing to Scout Live.**

> **Terminology note:** this PRD reads the requested "HyperDesk adapter" as **hyper-zepto** — the data/cache/blob adapter Build's generated apps actually use, both locally (WebContainer preview) and deployed (Scout Live managed ports). HyperDesk is a separate clawcloud remote-session client, unrelated to this pipeline; assumed voice-transcription. Confirm if a different system was meant.

## The four principles, made concrete

These are not personality theater. Each maps to a real artifact in the brain:

- **Identity** — the brain's Ed25519 keypair (who this agent is) plus a base *operating-principles* page every fork inherits: a consistent voice, and a point of view about good software. Identity is the named, owned thing the rest accretes onto.
- **Soul** — emergent, not painted on. The soul is the **installed, grown, portable brain itself**: base taste + the user's accumulated conventions, decisions, and hard-won lessons. An agent that boots with standards, forks to you, remembers how *you* build, and carries that across devices and projects *has* a soul — earned, not scripted.
- **User instructions** — an explicit, user-editable custom-instructions page in their fork. Transparent: surfaced in the account panel ("what Build knows about you"), editable and deletable. The user is in control of what's remembered.
- **Long-term memory** — signed private pages (decisions and rationale, project state, conventions, lessons, open loops), discoverable via a metadata-only index, kept healthy by a periodic consolidation pass.

## Decisions already made (do not relitigate)

1. **Local-first.** IndexedDB holds the hot working set; ZenBin is the durable, portable source of truth; a sync protocol moves between them. No HTTP-to-ZenBin on the agent's hot path. Build already uses IndexedDB for projects, so the primitive and the pattern exist.
2. **Three layers, inheritance by reference.** Base brain (shared skills/standards) → user fork (overlay) → learned memory. The user's index *references* base skill pages and *overrides* only where they've learned a nuance. The override-resolution logic lives in Build's prompt assembly (`server/src/prompt.ts`), not in ZenBin — ZenBin provides storage, discovery, and privacy; the inheritance policy is ours.
3. **Content hot in the browser; signing authority stays server-side.** Skills and memory content live in IndexedDB (read freely, co-located with the WebContainer and user). The Ed25519 **private key never enters the browser** — it's held server-side, encrypted with the existing `keyCrypto` path (as with OpenRouter and ScoutOS keys). Writes back to ZenBin are proxied and signed server-side. Browser XSS must not be able to forge the brain's identity.
4. **Progressive disclosure is the retrieval model.** The wiki/`_wiki` index is a cheap metadata scan; pages are fetched lazily. The agent loads only the skills and memories a task needs — keeping prompts lean (we already budget context). This is the same mechanism the Karpathy LLM-wiki pattern uses, realized on ZenBin's signed pages + index.
5. **The pattern is the Karpathy LLM Wiki; the substrate is ZenBin brain.** Not alternatives — the pattern (immutable sources → LLM-maintained wiki → schema doc; ingest/query/lint) is *how the brain stays healthy*; ZenBin brain (signed pages + metadata `_wiki` index + keypair ownership) is the durable, portable, multi-device implementation.
6. **Gated on the agentic loop.** See dependency above.

## The base brain (the genome)

A shared brain authored once, inherited by every fork. Its skill pages — much of which already exists as documentation in the repos and can be distilled, not written from scratch:

- **Scout Live** — ports/adapters (hexagonal) model, the deploy API, subdomain rules, the build→deploy→publishCode lifecycle. (Source: `scout-live` repo + `docs/scoutos-live-prd.md`.)
- **hyper-zepto adapter** — data/cache/blob ports, local vs remote mode, the `SCOUT_PORTS_URL` env mapping, and the `zepto-bridge.js` pattern that serves `/api/db` in both dev and production. (Source: this repo's Phase 0/1 work + hyper-zepto source.)
- **WebContainer build environment** — how projects run in-browser, dev (`vite`) vs production (`node server.js`), and the constraints (no native modules, pinned Vite, etc.).
- **Publishing to Scout Live** — the pipeline we built: Dockerfile/`.dockerignore` injection, the tar packaging, numeric `USER 1000`, republish-with-publishCode. (Source: `docs/scoutos-live-prd.md`, `server/src/publish.ts`.)
- **Engineering skills** — React patterns, app architecture, data modeling with hyper-zepto, design systems (seeded from the existing bundled design guidance), accessibility.
- **Operating principles** — the identity/voice page: opinionated defaults, good clarifying questions, teach-while-building.

---

## Phase 0 — Author the base brain

Distill the genome from existing sources into the LLM-wiki structure: skill pages + an `index.md`/`_wiki` catalog + a schema doc (the `CLAUDE.md`/`AGENTS.md` analog) describing conventions and the ingest/query/lint workflows.

**Success criteria:**
- [ ] Base skill pages exist for Scout Live, hyper-zepto, the WebContainer environment, publishing, and the core engineering skills, each grounded in concrete, checkable practices.
- [ ] A schema doc defines how the wiki is structured and how the agent ingests/queries/maintains it.
- [ ] The base brain answers, from its own pages, "how do I persist data in a Build app?" and "how do I publish this project?" without external lookup.

## Phase 1 — Brain storage + sync service

- ZenBin brain integration server-side: key custody (Clerk user → brain keypair, private key encrypted via `keyCrypto`), signed writes proxied through Build's API.
- The sync protocol: **hydrate** (initial), **refresh** (pull base-skill deltas on session start), **push** (learned notes, signed server-side), **reconcile** (override resolution).

**Success criteria:**
- [ ] A Clerk user maps to a brain identity; the signing key is never exposed to the client or any response.
- [ ] A learned note round-trips: written → signed → stored in ZenBin → discoverable via the index.
- [ ] Pulling a base-skill update does not clobber a legitimate user override (drift handled).
- [ ] No API response or log ever contains the private signing key.

## Phase 2 — Install into IndexedDB

- A client brain store in IndexedDB; the "install" UX — hydrate on account setup / first build, framed as equipping an asset, with progress.
- Working-set / LRU semantics (hold relevant skills + recent memory hot; ZenBin is the archive), version stamping, per-device re-install/rehydrate.

**Success criteria:**
- [ ] First-run installs the base brain + the user's fork into IndexedDB with a visible, honest progress step.
- [ ] The agent reads skills/memory from IndexedDB with no network on the hot path.
- [ ] A new device rehydrates the same brain (via the server-side user→brain mapping).
- [ ] Under storage pressure the working set is preserved correctly; eviction never loses durable memory (it's in ZenBin).
- [ ] The WebContainer preview (sandboxed, COOP/COEP) cannot read the brain store.

## Phase 3 — Wire the brain into the loop

At agent-turn assembly: scan the index (IndexedDB), select the relevant skill + memory pages for the task, and include them in the loop's context — client-side selection bundled into the request, matching the existing project-file-map pattern. Apply inheritance/override resolution (user nuance beats base skill).

**Success criteria:**
- [ ] A task touching persistence pulls the hyper-zepto skill; a styling task pulls design — without loading the whole brain.
- [ ] A user-specific convention overrides the base default in the assembled context.
- [ ] Prompt size with the brain stays within the existing context budget (progressive disclosure works).

## Phase 4 — Learning + consolidation

- The agent **proposes** durable notes conservatively (confirm or high-confidence only — memory pollution is the primary failure mode), writes them back signed, updates the index.
- A periodic lint/consolidation pass: merge duplicates, promote repeated notes, close completed open loops, flag contradictions.

**Success criteria:**
- [ ] The agent does not commit low-confidence or noisy notes to durable memory.
- [ ] A consolidation pass measurably reduces duplication without losing distinct facts.
- [ ] A wrong lesson can be corrected/removed and stops influencing future turns.

## Phase 5 — User instructions + transparency UI

- Account-panel section: "what Build knows about you" — view/edit custom instructions, view and delete memory.
- Custom instructions inject into the brain layer of prompt assembly.

**Success criteria:**
- [ ] Custom instructions are editable and demonstrably change agent behavior.
- [ ] The user can see and delete any learned memory; deletion propagates to ZenBin.
- [ ] Nothing sensitive (keys, tokens) is ever stored or shown as memory.

## Phase 6 — Rollout

- Gating behind managed auth; telemetry on brain hit rate, prompt size, and learning quality.
- Base-drift strategy: version base skills; on update, surface "your override of X is N versions behind — keep or adopt?"

**Success criteria:**
- [ ] End-to-end: new account → brain installs → agent builds with domain knowledge it didn't have to be told → learns a convention → reuses it next session → carries it to a second project.
- [ ] Non-managed mode shows no brain affordances.
- [ ] Base-skill updates propagate without clobbering user overrides.

## Risks

| Risk | Mitigation |
|---|---|
| **Memory pollution** (the hard one) — agent memorizes a wrong lesson and reapplies it | Conservative write policy (propose/confirm/high-confidence); consolidation pass; user can view/delete memory |
| Base drift — improved skills don't reach users who overrode them | Version base skills; surface keep-or-adopt on update |
| Key custody / XSS forging brain identity | Private key server-side encrypted; writes proxied/signed; only content in the browser |
| Latency if sync touches the hot path | IndexedDB hot working set; ZenBin sync off the hot path; brain rides the existing agent request |
| Prompt injection from learned/ingested content | Provenance signing distinguishes the agent's own notes from untrusted content; sanitize before memorizing |
| IndexedDB eviction | Working set is a cache; durable memory lives in ZenBin and rehydrates |
| Cost — skills + memory add tokens | Progressive disclosure keeps prompts lean; telemetry on prompt size before GA |

## Out of scope (this iteration)

Cross-product brain sharing (the same ZenBin substrate could one day back agents beyond Build — future). Multi-user collaborative brains. Handing the user their brain keypair for full self-custody/portability (a deliberate future decision, not v1). Anything in `docs/agent-loop-prd.md`, which this depends on.
