# SiteCare care workspace — review and release checklist

This branch changes the product from a browser-side site editor into a Tilda
maintenance workspace. It is intentionally not ready for merge or deployment
until the visible interface is accepted by the product owner.

## Product acceptance

- [ ] Client desktop: overview, diagnostics, requests, leads, reviews, settings.
- [ ] Specialist desktop: queue, clients, diagnostics, connections, reviews,
  accompaniment, settings.
- [ ] Mobile: navigation opens and closes without trapping hidden links; pages
  have no horizontal overflow; dialogs and forms remain usable.
- [ ] Collapsed desktop navigation preserves content width and readable labels.
- [ ] Typography hierarchy, wrapping, empty/loading/error states and keyboard
  focus are visually checked.
- [ ] Complete flow is checked: factual finding -> request -> proposal -> client
  acceptance -> external payment confirmation when required -> work -> result
  and verification.

The supervised browser preview did not start after the two permitted attempts.
The second attempt exposed and led to a fix for an invalid monitor column, but
no desktop/mobile screenshot is accepted yet. Automated UI checks do not close
this gate.

## Release safety

- [ ] Merge and deploy PR #8 first; this branch is stacked on its monitoring and
  review reliability commit.
- [ ] Inventory every enabled legacy override/rule and copy the intended values
  into Tilda before disabling the old loader behavior. Otherwise the originally
  published Tilda content will reappear.
- [ ] Apply gateway migration `0029_care_requests.sql` before the new gateway
  code. It preserves old support requests/messages and adds versioned care
  requests.
- [ ] Deploy the root and gateway Workers through the normal CI/CD path only
  after product acceptance. Do not publish the disposable QA fixture.
- [ ] Confirm public configuration returns no phone, schedule, button or content
  rules, and verify a connected Tilda page is not mutated.
- [ ] Verify client and specialist notifications open the exact new request.
- [ ] Verify form webhook rotation and a real Tilda test submission before
  declaring form collection healthy.
- [ ] Verify production at desktop and mobile widths after deployment; prepare a
  rollback to the previous Worker versions if a release check fails.

## Payment boundary

This release has no internal wallet and does not acquire money. A client accepts
scope, price and deadline; a specialist may then record an externally verified
payment reference. Its details stay in the encrypted request history; the
request row stores only a `manual` marker and payment time. A real wallet requires a payment provider, immutable ledger,
idempotent top-ups/refunds and reconciliation, and must be a separate task.
