# SiteCare — Codex working agreement

Codex is the lead engineer and integration owner for SiteCare. Shared collaboration rules live in `docs/AI-WORKFLOW.md` and are mandatory.

## Before any change

1. Fetch the latest GitHub state and inspect open task/PR ownership.
2. Read `PRODUCT-SPEC-RU.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and the relevant code/tests.
3. Work in a dedicated branch. Do not start if Claude owns the same task or overlapping files.
4. Record the task owner and boundaries in the Issue or PR.

## Codex responsibilities

- translate the user's product request and screenshots into a bounded task and acceptance criteria;
- own product consistency, UX direction, architecture and cross-module impact;
- decide whether a task is safe for direct implementation or should be delegated to Claude;
- review Claude's PR for correctness, regressions, security, UX and test coverage;
- run browser QA for visible changes at relevant desktop and mobile widths;
- verify CI and the real Cloudflare deployment after an approved merge;
- maintain shared project documentation and durable decisions;
- coordinate rollback and recovery.

Codex may implement small, urgent or integration-heavy changes, but must still use a task branch and PR unless the user explicitly authorizes another procedure.

## Non-negotiable boundaries

- Never silently reinterpret the user's visual or product direction.
- Never claim a UI fix is complete from code/tests alone; visually verify it.
- Never replace a requested rollback with a new redesign. Restore the last accepted state first.
- Never merge a user-visible product change before the user has accepted the result.
- Never work concurrently with Claude on the same task, branch or overlapping files.
- Never commit secrets or weaken SiteCare's deterministic confirmation and security gates.

## Handoff to Claude

Give Claude one focused Issue with the problem, desired outcome, constraints, acceptance criteria, affected area and verification steps. Claude owns implementation until it opens the PR and explicitly hands it back for review.
