# GitFrame

Pull still frames out of a video, on your phone.

GitFrame is a mobile-first frame extractor that runs **entirely on your device**.
Pick a video, scrub to the moment you want, and save it as an image — or extract
a few hundred frames in one pass and download them as a ZIP.

## On-device by design

The video never leaves the phone. There is no upload, no account, and no
server-side processing — decoding and encoding happen in the browser via
`<video>` and `<canvas>`.

Nothing is stored, either:

- no `localStorage`, `sessionStorage`, `IndexedDB`, or cookies
- no service worker and no offline cache
- every response is served `Cache-Control: no-store`
- settings live in memory for the session and are gone when the tab closes

The Worker that serves the app has no storage bindings at all — it hands back
static files and a health check, and that is the whole of it. A
`connect-src 'self'` Content-Security-Policy means the page cannot phone home
even if it wanted to.

## Built for thumbs

The mobile requirements drove most of the design:

- **No tiny buttons.** Every control is at least 48px; primary actions are 60px.
  The range slider gets a 30px thumb instead of the ~12px native one, and number
  fields are paired with 56px steppers rather than the unusable native spinners.
- **No zoom surprises.** Pinch-zoom stays enabled for accessibility, but the
  layout never needs it: nothing overflows horizontally, and every input is 16px+
  so iOS Safari doesn't zoom the page when a field takes focus. Heights use
  `dvh`, so the browser's collapsing chrome can't clip the controls.
- **No hanging screens.** Extraction yields to the event loop between frames, so
  the UI keeps painting and **Stop** stays live throughout. Every seek has a
  deadline, so one undecodable frame can't wedge a run — it's recorded as skipped
  and the run continues. A frame that's already been captured is never lost to a
  later failure.

## Features

- Frame-accurate stepping (±1 frame, ±1 second) at a configurable frame rate
- Grab the current frame, or batch-extract every N seconds / N frames total
- PNG, JPG, or WebP output with a quality slider and longest-edge downscaling
- Tap to select frames; download one as an image or many as a ZIP
- Runs offline once loaded — there is nothing to talk to

## Development

```bash
npm install
npm run dev        # wrangler dev
npm test           # vitest
npm run coverage   # vitest + coverage report
npm run lint
npm run typecheck
npm run build      # bundles the client into dist/client
```

### Layout

| Path              | What's in it                                             |
| ----------------- | -------------------------------------------------------- |
| `src/lib/`        | Pure logic: timecodes, extraction planning, ZIP, naming   |
| `src/app/`        | Seek-and-capture engine and the DOM controller            |
| `src/index.html`  | The markup the controller binds to                        |
| `worker/`         | Cloudflare Worker that serves the built client            |
| `test/`           | Unit tests plus jsdom tests that mount the real markup    |

The extraction engine takes every browser API through a narrow interface, so the
whole pipeline is tested against a fake decoder rather than a real one. The jsdom
tests mount `src/index.html` itself, so the tests fail if the markup and the
controller's element ids ever drift apart.

## Deployment

Deployed to Cloudflare Workers with static assets. To deploy from CI, add two
repository secrets:

- `CLOUDFLARE_API_TOKEN` — needs the **Workers Scripts: Edit** permission
- `CLOUDFLARE_ACCOUNT_ID`

Until those exist, the deploy workflow skips with a notice rather than failing.
To deploy by hand:

```bash
npm run deploy
```

## Licence

MIT — see [LICENSE](LICENSE).
