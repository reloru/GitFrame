import { describe, expect, it, vi } from 'vitest';

import worker, { withSecurityHeaders, type Env } from '../worker/index.js';

function makeEnv(response?: Response): { env: Env; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(
    async () =>
      response ??
      new Response('<!doctype html>', {
        headers: { 'Content-Type': 'text/html', ETag: '"abc"', 'Last-Modified': 'yesterday' },
      }),
  );
  return { env: { ASSETS: { fetch } }, fetch };
}

const get = (path: string, method = 'GET'): Request =>
  new Request(`https://gitframe.example${path}`, { method });

describe('withSecurityHeaders', () => {
  it('locks the page to its own origin', () => {
    const csp = withSecurityHeaders(new Response('x')).headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No unsafe escape hatches anywhere in the policy.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('*');
  });

  it('allows blob: only where local media playback needs it', () => {
    const csp = withSecurityHeaders(new Response('x')).headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("img-src 'self' blob: data:");
    // The page must not be able to send anything anywhere.
    expect(csp).toContain("connect-src 'self'");
  });

  it('stores nothing on the device or in proxies', () => {
    const headers = withSecurityHeaders(new Response('x')).headers;
    expect(headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(headers.get('ETag')).toBeNull();
    expect(headers.get('Last-Modified')).toBeNull();
  });

  it('sets the remaining hardening headers', () => {
    const headers = withSecurityHeaders(new Response('x')).headers;
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
  });

  it('preserves status and body', async () => {
    const wrapped = withSecurityHeaders(new Response('hello', { status: 404 }));
    expect(wrapped.status).toBe(404);
    await expect(wrapped.text()).resolves.toBe('hello');
  });

  it('keeps the upstream content type', () => {
    const wrapped = withSecurityHeaders(
      new Response('x', { headers: { 'Content-Type': 'text/css' } }),
    );
    expect(wrapped.headers.get('Content-Type')).toBe('text/css');
  });
});

describe('worker fetch', () => {
  it('serves assets and hardens them', async () => {
    const { env, fetch } = makeEnv();
    const response = await worker.fetch(get('/'), env);

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('answers the health check without touching assets', async () => {
    const { env, fetch } = makeEnv();
    const response = await worker.fetch(get('/healthz'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows HEAD', async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(get('/', 'HEAD'), env)).status).toBe(200);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('rejects %s', async (method) => {
    const { env, fetch } = makeEnv();
    const response = await worker.fetch(get('/', method), env);

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    // A write attempt must never reach the asset layer.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes through an asset 404', async () => {
    const { env } = makeEnv(new Response('nope', { status: 404 }));
    const response = await worker.fetch(get('/missing.png'), env);
    expect(response.status).toBe(404);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
