# SiteCare architecture

## System overview

SiteCare currently consists of three runtime boundaries plus GitHub CI/CD.

```text
Client / operator browser
        |
        v
Central platform / gateway Worker
(gateway/, Cloudflare Worker)
        |
        +--> Gateway D1
        +--> OpenAI / Cloudflare AI integrations
        +--> Telegram / email / reviews / monitoring
        +--> Main SiteCare Worker where required
        +--> Review relay for selected sources

Connected Tilda site
        |
        v
Main SiteCare Worker
(src/, Cloudflare Worker)
        |
        +--> Main D1
        +--> site diagnostics / forms / notifications

Review relay
(relay/, standalone Node service on separate VPS)
        |
        +--> selected review sources requiring a Russian network origin
```

## 1. Main SiteCare Worker

Entry point: `src/index.js` via root `wrangler.jsonc`.

Responsibilities include site-specific SiteCare behavior, diagnostics, forms and notifications. Automatic editing routes are retired with HTTP 410; public configuration is inert. Legacy helper modules remain for historical compatibility and are not exposed as editing capabilities. It uses the root D1 database (`DB`) and its own migration history in `migrations/`.

Important rule: this Worker and its database are a separate deployment boundary from the gateway.

## 2. Gateway / central platform Worker

Entry point: `gateway/src/index.js` via `gateway/wrangler.jsonc`.

This is the central product surface and contains the modern platform modules:
- `platform-core.js` — shared platform primitives and core behavior;
- `platform-assistant.js` — legacy proposal helpers; editing routes are retired;
- `platform-monitor.js` — monitoring and diagnostics;
- `platform-openai.js` — OpenAI integration;
- `platform-leads.js` — leads/forms-facing platform logic;
- `platform-care.js` — versioned requests, encrypted messages, quotes, acceptance and work outcomes;
- `platform-findings.js` — allowlisted factual findings, evidence and freshness;
- `platform-support.js` — legacy history and notification primitives;
- `platform-email.js` — email behavior;
- `platform-reviews.js` and `review-sources/` — review aggregation;
- `service-ui.js`, `service-ui-client.js`, `service-ui-styles.js` — common care workspace shell, browser interactions and styles;
- `platform-ui.js` — invitation/password pages, legacy event helper and workspace re-export;
- other `platform-*.js` modules — domain-specific features.

It uses `GATEWAY_DB` and migrations under `gateway/migrations/`.

### Care requests (migration 0029)

`platform_care_requests` holds the current state and immutable-after-acceptance proposal. `platform_care_messages` encrypts conversation bodies with the existing protected-data key. Each update requires the latest revision. Guarded message insertion and request update run in one D1 batch, so a losing concurrent update cannot leave an orphan message or double-accept.

The client accepts scope/price/deadline; the specialist records actual external payment manually, then starts paid work. This is not acquiring or a wallet. Included work still requires agreement. A consultation can close with an answer before a quote exists. Completion of work records the result and how the specialist checked it; it does not change diagnostic evidence automatically.

Migration 0029 copies old support requests/messages, bounding each historical thread by closure and the next request. Legacy support writes return 410 after migration; notifications link directly to the new request. Notification email identifiers include request revision. Existing overrides are retained read-only but never returned as active public instructions.

`npm run preview:care` is a disposable development fixture using real local D1 migrations and gateway request handlers. It seeds fictitious data and auto-authenticates fake users; it must never be deployed or exposed as a production service. `/__qa/client` and `/__qa/specialist` select a role for local QA. Normal `npm run dev` remains the root Worker flow; supervised preview host flags select this fixture. Neither production entrypoint imports it.

Release prerequisites and the uncompleted visual gate are recorded in `docs/CARE-REVIEW.md`.

### Monitoring and review data

`platform-reporting.js` supplies both availability reports and weekly digest counts. Periods use UTC calendar days, including the current partial day; API responses expose their exact boundaries. Completed daily aggregates take precedence over retained raw checks, with raw checks filling days not yet aggregated. A period with no observations returns `null` for uptime and latency. Request failures leave DNS/TLS status unknown because those layers were not independently measured.

Review widgets distinguish the latest sync attempt from `last_success_at`. A failed refresh keeps the last successful reviews available and exposes `stale` in the public response. Changing the organization atomically clears its reviews and sync metadata and increments `source_revision`; every sync write checks that revision so an earlier request cannot restore the old organization's reviews. An unrecognized source payload is a refresh failure, while an explicitly empty review collection is valid.

These contracts require gateway migration `0028_reliable_observations.sql` before deploying the updated gateway. The migration preserves monitor history and backfills successful review timestamps from existing records. It does not belong in the root Worker's database.

## 3. Review relay

`relay/` is a standalone Node.js service, intentionally outside both Cloudflare Worker deployments. It exists for review sources that reject Cloudflare/global network origins and require requests from an allowed Russian network origin.

It must remain:
- authenticated by a bearer secret;
- protected by an explicit host allowlist;
- exposed only through HTTPS;
- incapable of becoming a general-purpose open proxy.

It is deployed separately to a VPS and is not included in the Wrangler CI/CD deployment.

## 4. Data boundaries

There are two independent D1 databases:
- main Worker DB (`DB`), migrations in `migrations/`;
- gateway DB (`GATEWAY_DB`), migrations in `gateway/migrations/`.

Do not mix migration histories. Any schema change must be represented by a migration in the matching directory.

## 5. AI boundary

AI is an interpretation/explanation layer, not an unrestricted execution layer.

Safe site changes must remain governed by deterministic code and explicit preview/confirmation. Model output may help identify intent, explain diagnostics and prepare a proposed action, but it must not directly inject arbitrary code or bypass confirmation and verification gates.

## 6. CI/CD boundary

`.github/workflows/ci-cd.yml` currently:
- runs tests on pull requests;
- runs tests on pushes to `main`;
- deploys both Cloudflare Workers only on successful non-PR pushes to `main`.

This makes pull requests the safe collaboration boundary for AI-generated changes. A development branch can be tested without deploying to production.

## 7. Development flow

Preferred path:

```text
Issue / task
   -> dedicated branch
   -> implementation
   -> tests
   -> Pull Request
   -> ChatGPT / human review
   -> fixes if needed
   -> merge to main
   -> CI tests
   -> production deployment
```

Direct feature commits to `main` should be avoided.
