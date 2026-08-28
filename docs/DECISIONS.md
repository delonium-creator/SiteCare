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

## D-006 — Codex coordinates; Claude implements focused tasks

**Status:** accepted

The user is the product owner and final authority for visible product outcomes. Codex is the lead engineer and integration owner: it defines task boundaries, owns architecture and UX consistency, reviews changes, performs browser QA and verifies deployment. Claude Code is the focused implementation engineer: it works only on explicitly assigned Issues in a dedicated branch, adds tests and hands a PR back for review.

Only one agent may own an implementation task at a time. Agents must synchronize with GitHub and check for overlapping work before editing. They must not concurrently modify the same task, branch or affected files. User-visible changes require user acceptance before merge to `main`.

If the user requests a rollback, the last accepted state is restored before any alternative redesign is attempted.

## Template for new decisions

```md
## D-XXX — Short title

**Status:** proposed | accepted | superseded

Decision and rationale.
```
