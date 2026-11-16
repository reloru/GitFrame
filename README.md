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

- Frame-accurate stepping (±1 frame, ±1 second or ±6 frames) at the frame rate
  read from the file. Steps land on the centre of a frame, never on the
  boundary between two, so no frame is skipped or shown twice
- Grab the current frame, or batch-extract every N seconds, N frames total, or
  every frame in a range
- Duplicate grabs are flagged before they land: a frame already in the gallery
  warns instead of capturing, and a second tap within the window keeps it anyway
- PNG, JPG, or WebP output with a quality slider and longest-edge downscaling
- One-tap removal of letterbox and pillarbox bars
- A sharpness score on every frame, and a gallery order that puts the sharpest first
- A full-screen viewer: tap the arrows in a tile's corner to see the frame at
  full size, page or swipe through the gallery, pinch to zoom, select, save or
  delete it, or send the video back to the moment it came from
- Tap to select frames; save one as an image or many through the share sheet
  (a ZIP where there is no share sheet)
- Runs offline once loaded — there is nothing to talk to

## Built for long runs on a phone

- The gallery shows small thumbnails and keeps each tile in place between
  updates; the full-size image is only decoded in the viewer.
- Dragging the scrubber keeps one seek in flight and jumps to the latest
  position when it lands, instead of queueing every position the thumb passed.
- A batch run holds a screen wake lock where the browser offers one, and if the
  page is sent to the background it waits there and carries on when it is back,
  rather than writing each stalled frame off as skipped.
- "Clear all" asks for a second tap when more than one frame is at stake —
  frames exist nowhere but in the page.

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

Deployed to Cloudflare Workers with static assets, at
<https://gitframe.reloru.workers.dev>. Every push to `main` runs
`.github/workflows/deploy.yml`: lint, typecheck, tests, build, then
`wrangler deploy`. It needs two repository secrets:

- `CLOUDFLARE_API_TOKEN` — needs the **Workers Scripts: Edit** permission
- `CLOUDFLARE_ACCOUNT_ID`

Without them the workflow skips the deploy step with a notice rather than
failing. To deploy by hand:

```bash
npm run deploy
```

## Licence

MIT — see [LICENSE](LICENSE).
