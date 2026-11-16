# GitFrame

On-device video frame extractor for a phone browser, served by a Cloudflare
Worker as static assets. Live at <https://gitframe.reloru.workers.dev>.

## Checks

Run all of these before pushing; CI runs the same ones.

```bash
npm run lint
npm run typecheck
npm run coverage   # vitest with thresholds: 90% lines/statements/functions, 85% branches
npm run build
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`: lint, typecheck, tests,
build, then `wrangler deploy`. `GET /healthz` returns `{"ok":true}` on the live
Worker.

## Conventions

- Nothing is uploaded and nothing is stored: no network calls from the page, no
  localStorage / IndexedDB / cookies / service worker, every response
  `Cache-Control: no-store`. The CSP in `worker/index.ts` enforces the first
  part. Do not add persistence or third-party requests.
- Phone-first: every tap target is at least 48px, inputs are 16px or larger,
  nothing scrolls sideways.
- `src/lib/` is pure logic with no DOM. `src/app/extractor.ts` takes every
  browser API through a narrow interface and `src/app/ui.ts` takes its
  capabilities by injection, so both run under test without a real decoder.
- `test/ui.test.ts` mounts the real `src/index.html`; an element id must change
  in the markup and in `ui.ts` together.
- Times handed to the video are frame centres, not frame boundaries (see
  `stepByFrames` and `buildPlan`).
- Behaviour on iOS Safari cannot be tested here. Chromium via Playwright is the
  nearest check; say so when a change depends on Safari specifics.
