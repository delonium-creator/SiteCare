# SiteCare durable decisions

Record only decisions that should survive individual chats and implementation tasks.

## D-001 — GitHub is the shared coordination layer

**Status:** accepted

ChatGPT, Claude Code and the user coordinate implementation through GitHub Issues, branches, Pull Requests and reviews. Product/engineering context that both agents need should live in the repository rather than only in chat history.

## D-002 — Feature work does not go directly to main

**Status:** accepted

Normal feature and bug-fix work uses a dedicated branch and Pull Request. `main` is the production integration branch.

## D-003 — AI does not bypass deterministic change safety

**Status:** accepted

Model output may interpret requests and prepare proposals, but SiteCare's deterministic preview, confirmation and verification mechanisms remain authoritative for applying site changes.

## D-004 — Keep runtime/data boundaries explicit

**Status:** accepted

The root Worker, gateway Worker and standalone review relay are separate runtime boundaries. Root and gateway D1 databases have separate migration histories and must not be mixed.

## D-005 — Prefer focused edits over broad UI rewrites

**Status:** accepted

`gateway/src/platform-ui.js` is a large, high-risk file. Narrow UI tasks should use targeted changes with regression checks instead of opportunistic large refactors.

## Template for new decisions

```md
## D-XXX — Short title

**Status:** proposed | accepted | superseded

Decision and rationale.
```
