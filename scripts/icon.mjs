/**
 * The GitFrame icon, and the rasteriser that turns it into PNG files.
 *
 * Kept out of build.mjs so tests can import it without pulling in esbuild.
 * The SVG below is the source of truth; drawIcon() reproduces exactly that
 * artwork in pixels, because iOS and Android both want raster icons and there
 * is no image tooling in this project to convert one for us.
 */

export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="10" fill="#0b0f14"/>
  <rect x="7" y="13" width="24" height="22" rx="3" fill="none" stroke="#3d8bff" stroke-width="3"/>
  <path d="M33 21l8-5v16l-8-5z" fill="#22c98a"/>
  <circle cx="15" cy="21" r="2.5" fill="#3d8bff"/>
</svg>
`;

const INK = { bg: [11, 15, 20], blue: [61, 139, 255], green: [34, 201, 138] };

/** Signed distance to a rounded rectangle; <= 0 is inside. */
function roundedRectDistance(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - (hx - r);
  const qy = Math.abs(y - cy) - (hy - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Inside test for a convex polygon wound consistently. */
function insideConvex(x, y, points) {
  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
}

/**
 * Colour of the artwork at a point in the SVG's 48-unit coordinate space.
 *
 * This reproduces the ICON markup above rather than introducing new artwork:
 * the same stroked rect, play wedge and lens dot, in the same places.
 */
function sample(x, y) {
  // Lens dot.
  if (Math.hypot(x - 15, y - 21) <= 2.5) return INK.blue;
  // Play wedge — the path's four corners, in path order.
  if (insideConvex(x, y, [[33, 21], [41, 16], [41, 32], [33, 27]])) return INK.green;
  /*
   * Stroked rect: SVG strokes straddle the path, so a 3-wide stroke on a
   * 24x22 rect at rx=3 covers the band between a rect grown by 1.5 (r 4.5)
   * and one shrunk by 1.5 (r 1.5).
   */
  const outer = roundedRectDistance(x, y, 19, 24, 13.5, 12.5, 4.5);
  const inner = roundedRectDistance(x, y, 19, 24, 10.5, 9.5, 1.5);
  if (outer <= 0 && inner > 0) return INK.blue;
  return INK.bg;
}

const SUPERSAMPLE = 4;

/**
 * Draw the icon as opaque 8-bit RGBA.
 *
 * Rendered at SUPERSAMPLE x and box-filtered down, which is what keeps the
 * circle and the wedge's diagonal from looking stepped — there is no renderer
 * here to do antialiasing for us.
 *
 * `glyphScale` is the fraction of the square the 48-unit artwork spans. The
 * background is always full-bleed and the corners are never rounded here:
 * iOS and Android both apply their own mask, so rounding twice shows a dark
 * fringe. Maskable icons pass a smaller scale to stay inside Android's
 * centre-80% safe zone.
 */
export function drawIcon(size, glyphScale = 1) {
  const rgba = new Uint8Array(size * size * 4);
  const span = glyphScale * size;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = ((px + (sx + 0.5) * step - size / 2) / span) * 48 + 24;
          const y = ((py + (sy + 0.5) * step - size / 2) / span) * 48 + 24;
          const [cr, cg, cb] = sample(x, y);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r / samples);
      rgba[at + 1] = Math.round(g / samples);
      rgba[at + 2] = Math.round(b / samples);
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/** Every icon the manifest and the HTML head refer to. */
export const ICON_TARGETS = [
  // iOS masks the corners itself, so the artwork runs to the edges.
  { name: 'apple-touch-icon.png', size: 180, glyphScale: 1 },
  // Android crops to circles and squircles; 0.85 keeps the artwork clear of it.
  { name: 'icon-192.png', size: 192, glyphScale: 0.85 },
  { name: 'icon-512.png', size: 512, glyphScale: 0.85 },
];
