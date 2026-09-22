import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ICON_TARGETS } from '../scripts/icon.mjs';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

const manifest = JSON.parse(read('src/manifest.webmanifest')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
};

const html = read('src/index.html');
const sw = read('src/sw.js');

/** Every path the service worker precaches, read out of its SHELL array. */
const shell: string[] = (() => {
  const match = /const SHELL = \[([^\]]*)\]/.exec(sw);
  if (!match) throw new Error('src/sw.js no longer declares a SHELL array');
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
})();

/** What scripts/build.mjs writes into dist/client, besides sw.js itself. */
const BUILD_OUTPUTS = [
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  ...ICON_TARGETS.map((target: { name: string }) => target.name),
];

describe('web app manifest', () => {
  it('declares what a home-screen launch needs', () => {
    // short_name is what appears under the icon; without it iOS falls back to
    // <title> and truncates it.
    expect(manifest.short_name).toBe('GitFrame');
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('matches the theme colour the page already declares', () => {
    expect(html).toContain('<meta name="theme-color" content="#0b0f14" />');
    expect(manifest.theme_color).toBe('#0b0f14');
    expect(manifest.background_color).toBe('#0b0f14');
  });

  it('only references icons the build actually produces', () => {
    const produced = new Set(['/icon.svg', ...ICON_TARGETS.map((t: { name: string }) => `/${t.name}`)]);
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) expect(produced).toContain(icon.src);
  });

  it('marks its raster icons maskable so Android does not crop the artwork', () => {
    const raster = manifest.icons.filter((icon) => icon.type === 'image/png');
    expect(raster.length).toBeGreaterThan(0);
    for (const icon of raster) expect(icon.purpose).toContain('maskable');
  });
});

describe('index.html', () => {
  it('points at the manifest and the iOS icon', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    // iOS prefers apple-touch-icon over the manifest icons, and screenshots the
    // page when neither is present.
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="GitFrame" />');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
  });
});

describe('service worker', () => {
  it('precaches every file the build ships', () => {
    // The guard against shipping a new asset that offline launch never fetches.
    for (const output of BUILD_OUTPUTS) expect(shell).toContain(`/${output}`);
    // The bare root too, so a launch at "/" resolves offline.
    expect(shell).toContain('/');
  });

  it('precaches nothing the build does not produce', () => {
    const produced = new Set(['/', ...BUILD_OUTPUTS.map((name) => `/${name}`)]);
    for (const path of shell) expect(produced).toContain(path);
  });

  it('keeps the placeholder the build substitutes a content hash into', () => {
    // A fixed cache name would pin every phone to the first version it saw.
    expect(sw).toContain('__CACHE_VERSION__');
  });

  it('never caches the health check', () => {
    expect(shell).not.toContain('/healthz');
    expect(sw).toContain("url.pathname === '/healthz'");
  });
});
