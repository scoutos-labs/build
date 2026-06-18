# Phase 0: Scout Live ports smoke test

Minimal hyper-zepto app for the Phase 0 checks in `docs/scoutos-live-prd.md`:
it deploys to Scout Live and exercises the data port (create / get / find /
update / count / delete) through the platform's ports sidecar using
hyper-zepto's **remote** adapters — the same code path the production starter
template uses.

The env mapping under test: the platform injects
`SCOUT_PORTS_URL=http://127.0.0.1:3101/_ports`, hyper-zepto appends `/_ports`
itself, so the app strips the trailing `/_ports` before passing the value as
`baseUrl`. No token — the sidecar injects auth.

## Local checks (no key needed)

```bash
npm install
node index.js & curl -X POST localhost:3000/verify   # local adapters
```

Remote-mode wiring was validated against a stub that mirrors the platform's
data router paths/response shapes (see PRD Phase 0 finding).

## Live deploy (needs sk_live_ key, scopes build+read)

```bash
SCOUTOS_API_KEY=sk_live_... ./deploy.sh phase0-ports-smoke
# after "deployed":
curl -X POST https://phase0-ports-smoke.scoutos.live/verify
# republish check — reuse the publishCode from the first deploy's terminal status:
SCOUTOS_API_KEY=sk_live_... ./deploy.sh phase0-ports-smoke <publishCode>
```

`/verify` returns `{ ok: true, mode: "remote", steps: [...] }` on success;
any failing step returns 500 with the step name and the upstream error.
