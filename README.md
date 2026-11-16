# Vella Forge — a GitHub-compatible git forge

Standalone, GitHub-compatible git forge built for [make.fun's `github-core-clone-01`](https://make.fun/bounty/github-core-clone-01): one process, pure Node 22 stdlib, no git binary, no package install, no outside service.

![competition](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/parhanxd/github-core-clone-01-vella/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/parhanxd/github-core-clone-01-vella/reward.svg)

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (`Git-Protocol: version=2`) with v0 fallback, receive-pack v0 with report-status / side-band-64k / delete-refs, fast-forward-only pushes with per-ref report lines
- **REST v3** under `/api/v3` — repositories, issues, labels, pull requests, contents (PUT/DELETE with sha), Link-header pagination, `X-GitHub-Request-Id` on every reply
- **GraphQL v4** at `/api/graphql` — introspection of the shapes gh and github-mcp-server send, `repository.issues` ordered queries, `createPullRequest`, multi-operation documents
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP (revision 2026-07-28 `server/discover` plus the 2025-11-25-and-earlier `initialize` handshake), ≥6 tools acting on the same store as REST
- **Deterministic by rule** — no wall clock, no unseeded randomness: every date comes from `MAKEFUN_TRIAL_NOW`, randomness from `MAKEFUN_TRIAL_SEED`

## Run it

```sh
node --experimental-strip-types main.ts
```

One process: binds an ephemeral port (never 8080), registers it with `POST $MAKEFUN_ENV_URL/register`, serves all four surfaces, and long-polls `GET $MAKEFUN_ENV_URL/done`, exiting 0 when the suite finishes. Layout: `main.ts` (lifecycle) → `app.ts` (router) → `gitservice.ts` / `restapi.ts` / `gql.ts` / `mcpapi.ts` (the four surfaces) over `store.ts` + `gitobj.ts` (own object store, packfile read/write incl. OFS/REF deltas, zlib via `node:zlib`).

## Verified locally

`grade-local --driver process`, practice trial 0 (kit sha-verified, 63 files):

```
scores  {"agent":200,"feature":600,"perf":137,"perf_p50_us":482421,"score":937,"working":1}
replay  matched: state.json ... again, byte for byte
live    the entry exited with code 0 after 14.4 s
spend   $0.000000 over 0 requests (0 model calls)
```

118 → 120 of 120 conformance checks pass (final run: feature 600/600). Built by Vella (Light Vella agent) under entrant `parhanxd`; transcripts handed off with the entry per the competition's transcript gate.

## License

MIT — see [LICENSE](LICENSE).
