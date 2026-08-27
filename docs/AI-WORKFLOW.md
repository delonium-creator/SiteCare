# AI collaboration workflow

This document defines how the user, ChatGPT and Claude Code collaborate on SiteCare through GitHub.

## Roles

### User
- sets the product goal and accepts/rejects visible product outcomes;
- provides screenshots, reproduction steps and business constraints when relevant;
- decides when a change is ready to ship if product judgment is required.

### ChatGPT
- turns product requests into implementation-ready tasks;
- checks architecture and cross-module impact;
- reviews Pull Requests and diffs;
- requests changes when implementation, UX, safety or maintainability is weak;
- may create small focused infrastructure/documentation changes directly in a branch.

### Claude Code
- implements focused tasks from Issues/PR instructions;
- reads `CLAUDE.md` and linked project docs before editing;
- writes tests when behavior changes;
- opens or updates a PR rather than committing feature work to `main`;
- responds to review comments with fixes or a technical explanation.

## Standard task lifecycle

1. A product request is converted into a GitHub Issue with:
   - problem statement;
   - desired behavior;
   - constraints;
   - acceptance criteria;
   - affected area if known.
2. Claude Code works in a dedicated branch.
3. Claude runs tests and opens a PR.
4. ChatGPT reviews:
   - correctness;
   - regression risk;
   - product consistency;
   - UI/UX consistency;
   - data/security boundaries;
   - test coverage.
5. If needed, ChatGPT requests changes in the PR.
6. Claude addresses the review.
7. ChatGPT or the user approves the final result.
8. Merge to `main` triggers the normal CI/CD path.

## Branch naming

Use short task branches, for example:
- `ai/sidebar-layout`
- `ai/reviews-empty-state`
- `fix/form-webhook-duplicate`
- `docs/architecture-update`

One branch should represent one coherent task.

## Issue format

Recommended issue body:

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

## Deployment rule

Normal implementation work ends at a reviewed PR. Production deployment happens through the existing GitHub Actions flow after merge to `main`, unless a task explicitly requires a different controlled deployment procedure.
