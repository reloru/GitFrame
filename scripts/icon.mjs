/**
 * The GitFrame icon — a play button frozen into facets, with a frost mark —
 * defined once as geometry and drawn from that into the SVG favicon and every
 * PNG the manifest and iOS need. Keeping one definition is what stops the
 * home-screen icon and the tab icon drifting apart.
 *
 * Coordinates are on a 100×100 canvas. Every shape is a polygon or a
 * round-capped stroke, so the rasteriser below needs nothing but point-in-shape
 * tests: no image library, keeping the build free of dependencies.
 */

import { deflateSync } from 'node:zlib';

export const BACKGROUND = '#0b0f14';

const A = [33, 22];
const B = [33, 78];
const C = [81, 50];
/** Where the three facets meet, on the triangle's axis. */
const P = [55, 50];

const FLAKE = { x: 74, y: 24, arm: 8 };

function flakeArm(degrees) {
  const r = (degrees * Math.PI) / 180;
  const dx = Math.cos(r) * FLAKE.arm;
  const dy = Math.sin(r) * FLAKE.arm;
  return {
    type: 'stroke',
    from: [FLAKE.x - dx, FLAKE.y - dy],
    to: [FLAKE.x + dx, FLAKE.y + dy],
    width: 4,
    fill: '#22c98a',
  };
}

/** Painted in order; later shapes cover earlier ones. */
export const SHAPES = [
  { type: 'polygon', points: [A, P, B], fill: '#6aa6ff' },
  { type: 'polygon', points: [A, C, P], fill: '#2f6fd0' },
  { type: 'polygon', points: [P, C, B], fill: '#3d8bff' },
  { type: 'stroke', from: A, to: P, width: 2.5, fill: BACKGROUND },
  { type: 'stroke', from: P, to: C, width: 2.5, fill: BACKGROUND },
  { type: 'stroke', from: P, to: B, width: 2.5, fill: BACKGROUND },
  flakeArm(90),
  flakeArm(30),
  flakeArm(150),
];

/**
 * How far maskable artwork is shrunk. Android may crop a maskable icon to any
 * shape containing the centred circle of radius 40% of the icon, so the art is
 * scaled into that circle and the background alone fills the rest.
 */
export const MASKABLE_SCALE = 0.8;

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

function svgShape(shape) {
  if (shape.type === 'polygon') {
    return `<path d="M${shape.points.map((p) => p.join(' ')).join('L')}Z" fill="${shape.fill}"/>`;
  }
  const [x1, y1] = shape.from;
  const [x2, y2] = shape.to;
  const r = (n) => Math.round(n * 1000) / 1000;
  return (
    `<path d="M${r(x1)} ${r(y1)}L${r(x2)} ${r(y2)}" stroke="${shape.fill}" ` +
    `stroke-width="${shape.width}" stroke-linecap="round"/>`
  );
}

/** The favicon: rounded corners, since a browser tab applies no mask of its own. */
export function iconSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    `<rect width="100" height="100" rx="22" fill="${BACKGROUND}"/>`,
    ...SHAPES.map(svgShape),
    '</svg>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Rasteriser                                                          */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideStroke(x, y, { from, to, width }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const px = x1 + t * dx - x;
  const py = y1 + t * dy - y;
  return px * px + py * py <= (width / 2) ** 2;
}

/** Supersampling grid per pixel edge; 4 gives 16 samples, enough for clean edges. */
const SUPERSAMPLE = 4;

/**
 * Render the icon as `size`×`size` RGB, full-bleed. With `scale` below 1 the
 * artwork is shrunk about the centre while the background still fills the square.
 */
export function rasterize(size, scale = 1) {
  const shapes = SHAPES.map((shape) => ({ ...shape, rgb: hexToRgb(shape.fill) }));
  const background = hexToRgb(BACKGROUND);
  const pixels = new Uint8Array(size * size * 3);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = ((px + (sx + 0.5) / SUPERSAMPLE) / size) * 100;
          const v = ((py + (sy + 0.5) / SUPERSAMPLE) / size) * 100;
          const x = 50 + (u - 50) / scale;
          const y = 50 + (v - 50) / scale;
          let colour = background;
          for (const shape of shapes) {
            const hit = shape.type === 'polygon' ? insidePolygon(x, y, shape.points) : insideStroke(x, y, shape);
            if (hit) colour = shape.rgb;
          }
          r += colour[0];
          g += colour[1];
          b += colour[2];
        }
      }
      const o = (py * size + px) * 3;
      pixels[o] = Math.round(r / samples);
      pixels[o + 1] = Math.round(g / samples);
      pixels[o + 2] = Math.round(b / samples);
    }
  }
  return pixels;
}

/* ------------------------------------------------------------------ */
/* PNG encoding (ISO/IEC 15948 / W3C PNG)                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGB pixels as a PNG with no filtering. */
export function encodePng(pixels, width, height) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // compression, filter and interlace methods all 0

  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: None
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/**
 * Every raster icon the app ships. iOS masks the corners of an
 * apple-touch-icon itself, so that one is full-bleed and square.
 */
export const RASTER_ICONS = [
  { file: 'apple-touch-icon.png', size: 180, scale: 1 },
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, scale: MASKABLE_SCALE },
];
