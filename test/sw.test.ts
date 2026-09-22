/**
 * Service worker tests.
 *
 * src/sw.js runs in ServiceWorkerGlobalScope, which does not exist in Node —
 * but it only ever reaches the outside world through `self`, `caches` and
 * `fetch`. Supplying those three and evaluating the file captures its real
 * event handlers, so the offline behaviour is exercised rather than assumed.
 *
 * It is evaluated rather than imported because a service worker registered the
 * way this one is registered is a *classic* script, not a module: it has no
 * exports, and adding one to satisfy an `import` would be a syntax error in the
 * browser. Evaluating the source is what the browser itself does.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, '../src/sw.js'), 'utf8');

const ORIGIN = 'https://gitframe.example';

class FakeResponse {
  constructor(
    readonly status = 200,
    readonly type = 'basic',
    readonly body = 'x',
  ) {}
  clone(): FakeResponse {
    return new FakeResponse(this.status, this.type, this.body);
  }
}

class FakeCache {
  readonly entries = new Map<string, FakeResponse>();
  readonly added: string[] = [];

  async addAll(paths: string[]): Promise<void> {
    for (const path of paths) {
      this.added.push(path);
      this.entries.set(path, new FakeResponse());
    }
  }
  async match(key: string): Promise<FakeResponse | undefined> {
    return this.entries.get(key);
  }
  async put(key: string, response: FakeResponse): Promise<void> {
    this.entries.set(key, response);
  }
}

interface FakeEvent {
  request: { url: string; method: string; mode?: string };
  waitUntil: (value: Promise<unknown>) => void;
  respondWith: (value: Promise<unknown>) => void;
}

let handlers: Record<string, (event: FakeEvent) => void>;
let caches: Map<string, FakeCache>;
let deleted: string[];
let skipWaiting: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
/** Everything handed to waitUntil, so background work can be awaited. */
let pending: Array<Promise<unknown>>;

beforeEach(() => {
  handlers = {};
  caches = new Map();
  deleted = [];
  pending = [];
  skipWaiting = vi.fn();
  claim = vi.fn();
  fetchMock = vi.fn(async () => new FakeResponse());

  const cacheStorage = {
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new FakeCache());
      return caches.get(name)!;
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => {
      deleted.push(name);
      return caches.delete(name);
    },
  };

  const workerSelf = {
    addEventListener: (type: string, handler: (event: FakeEvent) => void) => {
      handlers[type] = handler;
    },
    location: { origin: ORIGIN },
    skipWaiting,
    clients: { claim },
  };

  new Function('self', 'caches', 'fetch', SOURCE)(workerSelf, cacheStorage, fetchMock);
});

function makeEvent(
  url: string,
  options: { method?: string; mode?: string } = {},
): FakeEvent & { responded: Promise<unknown> | null } {
  const event = {
    request: { url, method: options.method ?? 'GET', mode: options.mode },
    waitUntil: (value: Promise<unknown>) => void pending.push(value),
    respondWith: (value: Promise<unknown>) => {
      event.responded = value;
    },
    responded: null as Promise<unknown> | null,
  };
  return event;
}

/** Run a lifecycle handler and await everything it passed to waitUntil. */
async function run(type: 'install' | 'activate'): Promise<void> {
  handlers[type]!(makeEvent(`${ORIGIN}/`));
  await Promise.all(pending);
  pending = [];
}

const theCache = (): FakeCache => [...caches.values()][0]!;

describe('install', () => {
  it('precaches the shell under a versioned name and takes over immediately', async () => {
    await run('install');

    const [name] = [...caches.keys()];
    expect(name).toMatch(/^gitframe-/);
    expect(theCache().added).toContain('/index.html');
    expect(theCache().added).toContain('/app.js');
    expect(theCache().added).toContain('/apple-touch-icon.png');
    expect(skipWaiting).toHaveBeenCalled();
  });
});

describe('activate', () => {
  it('drops caches from previous versions and keeps the current one', async () => {
    await run('install');
    const current = [...caches.keys()][0]!;
    caches.set('gitframe-stale', new FakeCache());

    await run('activate');

    expect(deleted).toEqual(['gitframe-stale']);
    expect([...caches.keys()]).toEqual([current]);
    expect(claim).toHaveBeenCalled();
  });
});

describe('fetch', () => {
  beforeEach(async () => {
    await run('install');
  });

  it('serves a cached file without waiting for the network', async () => {
    const event = makeEvent(`${ORIGIN}/app.js`);
    handlers.fetch!(event);

    await expect(event.responded).resolves.toBeInstanceOf(FakeResponse);
    // The cached copy answers; the network call is only a background refresh.
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still serves the cached file when the network is gone', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const event = makeEvent(`${ORIGIN}/app.js`);
    handlers.fetch!(event);

    await expect(event.responded).resolves.toBeInstanceOf(FakeResponse);
    // A failed background refresh must not surface as an unhandled rejection.
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  it('resolves any navigation to the app shell', async () => {
    theCache().entries.delete('/deep/link');
    const event = makeEvent(`${ORIGIN}/deep/link`, { mode: 'navigate' });
    handlers.fetch!(event);

    await expect(event.responded).resolves.toBeInstanceOf(FakeResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches and caches a file that is not in the shell', async () => {
    const event = makeEvent(`${ORIGIN}/later.png`);
    handlers.fetch!(event);
    await event.responded;

    expect(fetchMock).toHaveBeenCalled();
    expect(theCache().entries.has('/later.png')).toBe(true);
  });

  it.each([
    ['a redirect', new FakeResponse(302)],
    ['an error', new FakeResponse(500)],
    ['an opaque cross-origin response', new FakeResponse(200, 'opaque')],
  ])('does not cache %s', async (_label, response) => {
    fetchMock.mockResolvedValue(response);
    const event = makeEvent(`${ORIGIN}/later.png`);
    handlers.fetch!(event);
    await event.responded;

    expect(theCache().entries.has('/later.png')).toBe(false);
  });

  it.each([
    ['non-GET requests', `${ORIGIN}/app.js`, { method: 'POST' }],
    ['cross-origin requests', 'https://elsewhere.example/app.js', {}],
    ['the health check', `${ORIGIN}/healthz`, {}],
  ])('leaves %s to the network', (_label, url, options) => {
    const event = makeEvent(url, options);
    handlers.fetch!(event);
    // Never answered from cache — the request goes out as it normally would.
    expect(event.responded).toBeNull();
  });
});
