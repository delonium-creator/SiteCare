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
        +--> site diagnostics / forms / changes / notifications

Review relay
(relay/, standalone Node service on separate VPS)
        |
        +--> selected review sources requiring a Russian network origin
```

## 1. Main SiteCare Worker

Entry point: `src/index.js` via root `wrangler.jsonc`.

Responsibilities include site-specific SiteCare behavior, diagnostics, forms, notifications, assistant logic and safe site-change flows. It uses the root D1 database (`DB`) and its own migration history in `migrations/`.

Important rule: this Worker and its database are a separate deployment boundary from the gateway.

## 2. Gateway / central platform Worker

Entry point: `gateway/src/index.js` via `gateway/wrangler.jsonc`.

This is the central product surface and contains the modern platform modules:
- `platform-core.js` — shared platform primitives and core behavior;
- `platform-assistant.js` — assistant flow;
- `platform-monitor.js` — monitoring and diagnostics;
- `platform-openai.js` — OpenAI integration;
- `platform-leads.js` — leads/forms-facing platform logic;
- `platform-support.js` — support workflows;
- `platform-email.js` — email behavior;
- `platform-reviews.js` and `review-sources/` — review aggregation;
- `platform-ui.js` — central UI rendering and browser code;
- other `platform-*.js` modules — domain-specific features.

It uses `GATEWAY_DB` and migrations under `gateway/migrations/`.

`gateway/src/platform-ui.js` is very large and therefore a high-risk integration point. Prefer targeted edits and regression tests over broad rewrites.

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
