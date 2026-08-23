# SiteCare review-source relay

Standalone relay for review sources that block requests from outside Russia
at the network level (confirmed so far: Флап, Авито). SiteCare runs on
Cloudflare Workers' global edge, which those sources don't treat as
Russian, so this small server exists to make the request from a Russian IP
instead and hand the raw HTML back untouched. It is not a scraping trick or
a CAPTCHA-solver — it's the exact same request a Worker would make
directly, sent from infrastructure the target already treats as domestic.

This directory is **not** part of the Cloudflare Worker (`gateway/`) and is
never deployed with `wrangler deploy` — it's a separate process meant to
run on its own VPS.

## Prerequisites

- A VPS from a Russian hosting provider (Timeweb Cloud, Selectel, REG.RU —
  any of these work; the cheapest tier is plenty, this does almost nothing).
- Node.js 18+ on that VPS.
- A domain or subdomain pointed at the VPS, with TLS in front (see below) —
  the Worker must call this over HTTPS, not plain HTTP, since the bearer
  secret travels in every request.

## Deploy

```bash
# On the VPS, as a dedicated non-root user:
sudo useradd -r -s /usr/sbin/nologin sitecare-relay
sudo mkdir -p /opt/sitecare-review-relay
sudo chown sitecare-relay:sitecare-relay /opt/sitecare-review-relay
# Copy this relay/ directory's contents into /opt/sitecare-review-relay

# Generate a long random secret and write the env file:
openssl rand -base64 32   # copy the output
sudo tee /opt/sitecare-review-relay/.env <<'EOF'
PORT=8787
RELAY_SECRET=<paste the generated secret here>
RELAY_ALLOWED_HOSTS=flamp.ru,www.avito.ru,avito.ru
EOF
sudo chown sitecare-relay:sitecare-relay /opt/sitecare-review-relay/.env
sudo chmod 600 /opt/sitecare-review-relay/.env

# Install and start as a systemd service:
sudo cp sitecare-review-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sitecare-review-relay
sudo systemctl status sitecare-review-relay
```

`RELAY_ALLOWED_HOSTS` is a mandatory allowlist (the server refuses to start
without one) — add a host only when a real adapter in
`gateway/src/review-sources/` actually needs it. This keeps the relay from
becoming an open proxy to arbitrary URLs if the secret ever leaks.

**Put a real TLS reverse proxy in front** (Caddy is the simplest — one line
`your-relay-domain.ru { reverse_proxy 127.0.0.1:8787 }` in a Caddyfile gets
you automatic HTTPS). Never expose port 8787 directly to the internet.

## Wire it up to the Worker

From `gateway/` (where `wrangler.jsonc` lives):

```bash
npx wrangler secret put REVIEW_RELAY_URL
# → https://your-relay-domain.ru
npx wrangler secret put REVIEW_RELAY_SECRET
# → the same value as RELAY_SECRET above
```

For local dev, add both to `gateway/.dev.vars` (create it if it doesn't
exist — it's gitignored, same as any other local secret).

That's the entire integration on the Worker side — `gateway/src/review-sources/relay.js`
already knows how to call this relay, and `gateway/src/platform-reviews.js`
already routes any adapter marked `export const requiresRelay = true;`
through it automatically. Nothing else needs to change when the VPS goes
live.

## Adding a relay-routed review source later

1. Add the source's hostname(s) to `RELAY_ALLOWED_HOSTS` on the VPS and
   restart the service (`sudo systemctl restart sitecare-review-relay`).
2. Write the adapter in `gateway/src/review-sources/<service>.js` exactly
   like the direct ones (`dgis.js`, `profi.js`) — `key`, `label`,
   `identifierHint`, `normalizeIdentifier`, `fetchReviews` — plus one extra
   line: `export const requiresRelay = true;`
3. Register it in `gateway/src/review-sources/index.js`.

No schema, sync-job, dialog, or public-endpoint change needed — the same
guarantee that already holds for every other adapter.

## Health check

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <RELAY_SECRET>" \
  "https://your-relay-domain.ru/fetch?url=https%3A%2F%2Fexample.test%2F"
```

A `403` means the target host isn't in `RELAY_ALLOWED_HOSTS` yet (expected
for a host you haven't added); a `401` means the secret is wrong; anything
else means it reached the target and relayed the response.
