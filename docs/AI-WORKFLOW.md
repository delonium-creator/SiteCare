# AI collaboration workflow

This document defines how the user, ChatGPT and Claude Code collaborate on SiteCare through GitHub.

## Roles

### User
- sets the product goal and accepts/rejects visible product outcomes;
- provides screenshots, reproduction steps and business constraints when relevant;
- is the final authority on product and visual decisions;
- approves user-visible changes before they are merged to `main` and shipped.

### ChatGPT / Codex — lead engineer and integration owner
- turns product requests into implementation-ready tasks;
- owns product consistency, UX direction, architecture and cross-module impact;
- chooses task boundaries and assigns one implementation owner;
- reviews Claude's Pull Requests and diffs;
- requests changes when implementation, UX, safety or maintainability is weak;
- performs browser QA for visible changes at relevant desktop and mobile widths;
- verifies CI and the real Cloudflare deployment after an approved merge;
- maintains shared documentation, durable decisions and rollback history;
- may implement small, urgent or integration-heavy changes in its own task branch.

### Claude Code — focused implementation engineer
- implements focused tasks explicitly assigned through Issues/PR instructions;
- reads `CLAUDE.md` and linked project docs before editing;
- investigates the assigned code path deeply and raises conflicts or missing requirements before broadening scope;
- writes tests when behavior changes;
- opens or updates a PR rather than committing feature work to `main`;
- responds to Codex review comments with fixes or a technical explanation;
- does not merge, deploy or redesign outside the accepted task boundaries.

## Exclusive task ownership

Only one agent may own an implementation task at a time.

Before editing, both agents must:
1. fetch the latest GitHub state;
2. inspect the relevant Issue, open PRs and active branches;
3. record `Owner: Codex` or `Owner: Claude` and the affected area in the Issue/PR;
4. stop and report a conflict if another active task touches the same behavior or files.

An agent owns its task branch until it explicitly posts a handoff. The other agent may review and comment, but must not push competing implementation changes to that branch. A task may be reassigned only through a visible Issue/PR comment.

## Standard task lifecycle

1. A product request is converted into a GitHub Issue with:
   - problem statement;
   - desired behavior;
   - constraints;
   - acceptance criteria;
   - affected area if known.
2. Codex records the implementation owner and affected area.
3. The assigned owner works in a dedicated branch.
4. The owner runs tests and opens a PR.
5. Codex reviews correctness, regression risk, product consistency, UX consistency, data/security boundaries and test coverage.
6. If needed, Codex requests changes in the PR and the owner addresses them.
7. For visible product changes, the user accepts the result.
8. After approval, merge to `main` triggers the normal CI/CD path.
9. Codex verifies the deployed production result rather than inferring success from a green workflow alone.

## UI and rollback protocol

- Screenshots and feedback must be converted into element-specific acceptance criteria; global font scaling is prohibited unless explicitly requested.
- UI verification must include layout, typography hierarchy, collapsed/expanded navigation, content wrapping and at least one narrow viewport.
- A code-level test is not sufficient evidence that a visual defect is fixed.
- When the user says to revert or restore, stop the replacement work and restore the last accepted state first. Any new redesign becomes a separate task requiring approval.

## Branch naming

Use short task branches, for example:
- `ai/sidebar-layout`
- `ai/reviews-empty-state`
- `fix/form-webhook-duplicate`
- `docs/architecture-update`

One branch should represent one coherent task.

## Issue format

```md
## Problem
What is wrong today?

## Desired outcome
What should the user experience instead?

## Constraints
What must not change or break?

## Acceptance criteria
- [ ] measurable result 1
- [ ] measurable result 2
- [ ] tests updated/passing

## Verification
How to verify manually, including viewport/device for UI work.
```

## PR format

Every implementation PR should answer:
- What changed?
- Why?
- What files/modules are affected?
- What tests were run?
- What remains unverified?
- For UI changes: what viewports/states were checked?

## Review policy

A PR should be blocked if it:
- bypasses explicit confirmation for site changes;
- weakens auth/security/origin validation;
- mixes the two D1 migration histories;
- includes secrets;
- changes unrelated behavior without justification;
- makes a broad `platform-ui.js` rewrite for a narrow visual task;
- claims production success without actual verification;
- removes tests or safeguards merely to make CI green.

## Conflict resolution

If ChatGPT and Claude propose different implementations:
1. compare them against the product spec and acceptance criteria;
2. prefer the smaller change with clearer verification and lower regression risk;
3. record durable architectural decisions in `docs/DECISIONS.md`;
4. escalate product tradeoffs to the user rather than letting agents silently choose a different product direction.

If both agents accidentally begin overlapping work, both stop editing. Codex compares the branches, selects one owner, and records the handoff before work resumes.

## Deployment rule

Normal implementation work ends at a reviewed PR. Production deployment happens through the existing GitHub Actions flow after merge to `main`, unless a task explicitly requires a different controlled deployment procedure.
