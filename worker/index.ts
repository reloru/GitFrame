/**
 * Cloudflare Worker that serves the GitFrame client.
 *
 * The Worker is deliberately dumb: it has no storage bindings, no KV, no D1,
 * no logging of request bodies. It hands back static files and nothing else —
 * video never reaches it, because the app never uploads any.
 */

export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

/**
 * Content-Security-Policy locking the page to its own origin.
 *
 * `blob:` is required in `media-src` and `img-src`: the whole app works by
 * pointing <video> and <img> at object URLs for locally chosen files.
 * There is no `connect-src` beyond 'self', so the page cannot phone home.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Explicitly turn off everything the app never uses.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  /*
   * Nothing about a session should outlive it — not on the device, not in a
   * proxy. The whole payload is a few tens of kilobytes, so re-fetching it
   * costs far less than leaving copies of the app lying around.
   */
  'Cache-Control': 'no-store, max-age=0',
};

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return withSecurityHeaders(
        new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }),
      );
    }

    if (pathname === '/healthz') {
      return withSecurityHeaders(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  },
};
