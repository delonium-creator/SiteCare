// SiteCare review-source relay.
//
// Standalone, dependency-free Node.js server meant to run on real Russian
// hosting (a small VPS). SiteCare itself runs entirely on Cloudflare
// Workers' global edge, which is not Russian-hosted -- some review sources
// (confirmed: Флап, Авито) block or restrict requests from non-Russian IPs
// at the network level, independent of how the request looks. This relay
// exists only to fetch those specific pages from a Russian IP on the
// Worker's behalf and hand the raw response back untouched; it does not
// solve CAPTCHAs, spoof fingerprints, or evade any behavior-based check --
// it is the same request a Worker would make directly, just sent from
// network infrastructure the target treats as domestic.
//
// Deployment: see README.md in this directory.
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.RELAY_SECRET || "";
const ALLOWED_HOSTS = new Set(
  (process.env.RELAY_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

if (!SECRET || SECRET.length < 20) {
  console.error("RELAY_SECRET must be set to a long random value -- refusing to start an unauthenticated relay.");
  process.exit(1);
}
if (!ALLOWED_HOSTS.size) {
  console.error("RELAY_ALLOWED_HOSTS must list at least one hostname -- refusing to start an open relay with no allowlist.");
  process.exit(1);
}

function send(res, status, contentType, body) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

async function boundedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("upstream response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");

    const authorization = req.headers.authorization || "";
    // Constant-time-ish compare isn't critical here: this sits behind TLS
    // and a long random secret, and a timing side-channel over a relay's
    // own auth check is a marginal concern compared to the alternative of
    // no relay existing at all.
    if (authorization !== `Bearer ${SECRET}`) return send(res, 401, "text/plain", "unauthorized");

    const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (requestUrl.pathname !== "/fetch") return send(res, 404, "text/plain", "not found");

    const target = requestUrl.searchParams.get("url") || "";
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return send(res, 400, "text/plain", "invalid url");
    }
    if (targetUrl.protocol !== "https:") return send(res, 400, "text/plain", "https only");
    if (!ALLOWED_HOSTS.has(targetUrl.hostname.toLowerCase())) return send(res, 403, "text/plain", "host not allowed");

    const upstream = await fetch(targetUrl.href, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = await boundedText(upstream);
    send(res, upstream.status, upstream.headers.get("content-type") || "text/html; charset=utf-8", body);
  } catch (error) {
    console.error("relay error:", error?.message || error);
    send(res, 502, "text/plain", "relay error");
  }
});

server.listen(PORT, () => {
  console.log(`SiteCare review relay listening on :${PORT}, allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}`);
});
