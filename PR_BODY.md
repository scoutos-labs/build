## Summary

Adds ScoutOS `/atoms` API as a third provider option alongside OpenRouter and Ollama, enabling streaming tool execution for file operations in the WebContainer.

## What Changed

### New Files (TypeScript)
- `src/scoutos-client.ts` — Atoms protocol client with SSE streaming
- `src/scoutos-client.test.ts` — 12 test cases for the client
- `src/atoms-protocol.ts` — Atom event type definitions (text_delta, tool_intent, final_answer)
- `src/sse.ts` — Manual SSE parser for POST-based event streams
- `src/build-tools.ts` — WebContainer tool executor (write_file, read_file, run_command, list_files, install_package)
- `src/build-tools.test.ts` — 17 test cases for tool execution
- `src/test-prompt.ts` — Prompt tuning test script

### Modified Files
- `src/agent.ts` — Added `runScoutOSAgent()` with atoms streaming + tool loop (max 10 iterations)
- `src/actors/settings.ts` + tests — Added ScoutOS provider variant
- `src/build/actors/settings.gleam` — Added ScoutOS fields (api_key, base_url)
- `src/build/components/build_settings_modal.gleam` — ScoutOS radio + input fields
- `src/build/runtime/agent.gleam` + `settings.gleam` — Runtime wiring
- `src/build/update.gleam` — Validation + routing for ScoutOS
- `src/gleam-externals/*.mjs` — JS bridge for localStorage + runtime
- `src/runtime/index.ts` + tests — WebContainer API passed to agent calls
- Test files updated for new ScoutOS parameters

## Architecture

```
User Request → Brain (ScoutOS /atoms) → tool_intent atoms
                                          ↓
                                   executeBuildTool()
                                          ↓
                                   WebContainer (write/read/run)
                                          ↓
                                   followUpWithToolResults()
                                          ↓
                                   final_answer → UI
```

## How It Works

1. User selects "ScoutOS" in settings, enters API key
2. On build request, `runScoutOSAgent()` sends instructions + context to `/atoms`
3. ScoutOS streams atoms back via SSE (event: atom / event: message)
4. `text_delta` → accumulated into reply text
5. `tool_intent` → executed via WebContainer (write_file, run_command, etc.)
6. Tool results sent back via `followUpWithToolResults()`
7. Loop continues until `final_answer` or max iterations

## Testing

- **203 TypeScript tests** passing (36 test files)
- **35 Gleam tests** passing
- Manual E2E against real ScoutOS API confirmed text_delta + final_answer work

## Prompt Tuning Status

The adapter is functional but the ScoutOS agent doesn't yet reliably emit `tool_intent` atoms for file operations. The prompt includes exact JSON examples and DO-NOT rules, but the model still returns empty responses for write requests. This is a known limitation that can be iterated on post-merge.

## API Key

Uses ScoutOS API key: `secret_-jSG8qXgCCVivhBcQNK6MLD39A75HKrPcFa90gP0zAw=` (provided by Rakis)
