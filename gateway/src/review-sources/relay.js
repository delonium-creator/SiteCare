// Fetch path for review sources that block requests from outside Russia at
// the network level (confirmed for Флап and Авито -- both return an
// explicit IP-origin block, not a behavior-based bot check a differently
// shaped request could pass). SiteCare runs entirely on Cloudflare Workers'
// global edge, which is not Russian-hosted, so those sources are only
// reachable through a small relay run on real Russian infrastructure: the
// Worker asks the relay to fetch the page, the relay does it from a
// Russian IP, and returns the raw response back untouched. See relay/ at
// the repo root for the relay's own (separately deployed) server code.
//
// This returns an ordinary fetch-compatible function, so it plugs into the
// exact same adapter code path (`fetchSourcePage` in util.js) that direct
// sources use -- an adapter marks itself `requiresRelay = true` and needs
// no other change; platform-reviews.js picks this implementation instead
// of the global fetch automatically.
export function relayFetchImpl(env) {
  return async function relayFetch(url, options = {}) {
    if (!env.REVIEW_RELAY_URL || !env.REVIEW_RELAY_SECRET) {
      throw new Error("Relay для источников из РФ ещё не настроен.");
    }
    const relayUrl = new URL("/fetch", env.REVIEW_RELAY_URL);
    relayUrl.searchParams.set("url", String(url));
    return fetch(relayUrl.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.REVIEW_RELAY_SECRET}` },
      signal: options.signal
    });
  };
}
