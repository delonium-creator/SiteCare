# SiteCare — Claude working agreement

This repository is developed collaboratively by the user, ChatGPT and Claude Code through GitHub Issues and Pull Requests.

## Source of truth

Read these before changing product behavior:
1. `PRODUCT-SPEC-RU.md` — agreed product requirements.
2. `README-RU.md` — current implemented behavior and release notes.
3. `PROJECT-NOTES.md` — historical decisions, deployment caveats and known constraints.
4. `docs/ARCHITECTURE.md` — current system boundaries.
5. `docs/AI-WORKFLOW.md` — collaboration protocol.
6. `docs/DECISIONS.md` — durable decisions made during development.

If documents conflict, prefer the most specific and most recently accepted decision. Do not silently reinterpret product requirements.

## Repository architecture

- `src/` — main SiteCare Cloudflare Worker for site-level functionality and legacy/site-specific flows.
- `gateway/` — central platform / Telegram gateway Cloudflare Worker and the main modern product surface.
- `gateway/src/platform-ui.js` — central UI implementation; large and high-risk. Avoid broad refactors unless the task explicitly requires them.
- `gateway/src/platform-*.js` — platform domain modules.
- `gateway/src/review-sources/` — review-source adapters.
- `migrations/` and `gateway/migrations/` — independent D1 migration histories for the two Workers.
- `relay/` — separate Node.js service for review sources that require a Russian network origin. It is not deployed by Wrangler.
- `test/` — automated Node test suite.

## Required workflow

1. Never make feature work directly on `main`.
2. Work from a dedicated branch for one task.
3. Keep each PR focused on one problem.
4. Before editing, inspect the relevant code and tests rather than guessing from file names.
5. Preserve unrelated behavior.
6. For behavior changes, add or update tests when practical.
7. Run `npm test` at minimum. Prefer `npm run check` when the environment supports it.
8. Do not deploy production resources from a development task unless the issue explicitly asks for deployment.
9. Do not merge your own PR. Leave it for review.

## Safety rules

- Never commit secrets, tokens, API keys or `.dev.vars` contents.
- Do not weaken authentication, authorization, encryption, origin checks or confirmation gates to make a task easier.
- AI-generated suggestions must never bypass SiteCare's deterministic preview/confirmation model for site changes.
- Do not mutate D1 production data manually unless explicitly requested and reviewed.
- Database schema changes require a migration; never rely on ad-hoc production schema edits.
- Keep the main Worker and gateway D1 migrations separate.

## Product rules that must remain true

- SiteCare is a managed service: support connects and maintains sites; clients get a simple interface without technical infrastructure details.
- Client-visible changes must not be presented as successfully applied until SiteCare has confirmation.
- Ambiguous site changes require clarification; the system must not guess which target to edit.
- AI may interpret intent and explain diagnostics, but it must not independently apply arbitrary code or bypass user confirmation.
- Client UI should hide implementation details such as internal IDs, selectors, webhook plumbing and Cloudflare/Tilda internals unless the task is specifically for operator/developer tooling.

## Pull request handoff

When opening or updating a PR, include:
- what changed;
- why it changed;
- affected files/modules;
- tests run and results;
- known limitations or anything not verified;
- screenshots or reproduction notes for UI work when available.

When responding to review comments, address each requested change explicitly. If you disagree with a requested change, explain why instead of silently ignoring it.
