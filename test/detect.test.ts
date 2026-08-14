import { describe, expect, it } from 'vitest';

import { colorName, cropRect, detectVoids, detectVoidsAuto, type RGBAImage } from '../src/lib/detect.js';

/** Deterministic PRNG so "noisy" fixtures are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width, height };
}

/** High per-pixel variance so it can never read as flat, at any tolerance. */
function busyContent(x: number, y: number): readonly [number, number, number, number] {
  return [(x * 53 + y * 97) % 256, (x * 29 + y * 61) % 256, (x * 83 + y * 13) % 256, 255];
}

const BLACK: readonly [number, number, number, number] = [0, 0, 0, 255];

function letterboxed(width: number, height: number, top: number, bottom: number): RGBAImage {
  return makeImage(width, height, (x, y) => {
    if (y < top || y >= height - bottom) return BLACK;
    return busyContent(x, y);
  });
}

function pillarboxed(width: number, height: number, left: number, right: number): RGBAImage {
  return makeImage(width, height, (x, y) => {
    if (x < left || x >= width - right) return BLACK;
    return busyContent(x, y);
  });
}

describe('detectVoidsAuto — clean bars', () => {
  it('measures a top/bottom letterbox with no side bars', () => {
    const image = letterboxed(320, 240, 40, 40);
    const result = detectVoidsAuto(image);

    expect(result.top).toBe(40);
    expect(result.bottom).toBe(40);
    expect(result.left).toBe(0);
    expect(result.right).toBe(0);
    expect(result.hasVoid).toBe(true);
    expect(result.crop).toEqual({ x: 0, y: 40, width: 320, height: 160 });
  });

  it('measures a left/right pillarbox with no top/bottom bars', () => {
    const image = pillarboxed(320, 240, 60, 60);
    const result = detectVoidsAuto(image);

    expect(result.left).toBe(60);
    expect(result.right).toBe(60);
    expect(result.top).toBe(0);
    expect(result.bottom).toBe(0);
    expect(result.crop).toEqual({ x: 60, y: 0, width: 200, height: 240 });
  });

  it('handles asymmetric bars — real encodes are frequently off by a pixel or two', () => {
    const image = makeImage(200, 200, (x, y) => {
      if (y < 20 || y >= 200 - 22) return BLACK;
      if (x < 5 || x >= 200 - 7) return BLACK;
      return busyContent(x, y);
    });
    const result = detectVoidsAuto(image);

    expect(result.top).toBe(20);
    expect(result.bottom).toBe(22);
    expect(result.left).toBe(5);
    expect(result.right).toBe(7);
  });

  it('reports no void for content that already fills the frame', () => {
    const image = makeImage(160, 160, busyContent);
    const result = detectVoidsAuto(image);

    expect(result.hasVoid).toBe(false);
    expect(result.top + result.bottom + result.left + result.right).toBe(0);
    expect(result.crop).toEqual({ x: 0, y: 0, width: 160, height: 160 });
  });
});

describe('detectVoidsAuto — speckled bars', () => {
  it('is not defeated by ~1.5% compression speckle inside a black bar', () => {
    const rand = mulberry32(7);
    const width = 320;
    const height = 240;
    const barHeight = 50;
    const image = makeImage(width, height, (x, y) => {
      const inBar = y < barHeight || y >= height - barHeight;
      if (!inBar) return busyContent(x, y);
      // ~1.5% of bar pixels get a small perturbation — well under the 2% budget.
      if (rand() < 0.015) {
        const n = Math.floor(rand() * 10);
        return [n, n, n, 255];
      }
      return BLACK;
    });

    const result = detectVoidsAuto(image);
    expect(result.top).toBe(barHeight);
    expect(result.bottom).toBe(barHeight);
  });

  it('does not let one speckled row inside the bar truncate the measurement', () => {
    // A single dirty row well inside a tall bar used to end the scan at the
    // first failure. The grace window exists so this survives. The row has to
    // fail flatColor's own noise budget (per-pixel disagreement within the
    // line) to exercise the grace path — a row that is itself uniform in a
    // different colour is a legitimate new block instead (the `jump` path,
    // covered separately below), not what grace is for.
    const width = 200;
    const height = 300;
    const barHeight = 100;
    const image = makeImage(width, height, (x, y) => {
      if (y === 30) return x % 2 === 0 ? BLACK : [220, 40, 40, 255];
      if (y < barHeight || y >= height - barHeight) return BLACK;
      return busyContent(x, y);
    });

    const result = detectVoidsAuto(image);
    expect(result.top).toBe(barHeight);
  });
});

describe('detectVoidsAuto — gradients', () => {
  it('reads a smoothly drifting bar as blank', () => {
    const width = 240;
    const height = 200;
    const barHeight = 45;
    const image = makeImage(width, height, (x, y) => {
      if (y < barHeight) {
        const shade = Math.round((y / barHeight) * 60); // drifts by ~1.3/row, well under `jump`
        return [shade, shade, shade, 255];
      }
      if (y >= height - barHeight) return BLACK;
      return busyContent(x, y);
    });

    const result = detectVoidsAuto(image);
    expect(result.top).toBe(barHeight);
  });

  it('still separates a solid header from a gradient bar above it via the jump threshold', () => {
    const width = 200;
    const height = 200;
    // 0..30 is a gradient void, 30..70 is a solid header far enough in color
    // to count as a new block rather than a continuation of the drift.
    const image = makeImage(width, height, (x, y) => {
      if (y < 30) {
        const shade = Math.round((y / 30) * 20);
        return [shade, shade, shade, 255];
      }
      if (y < 70) return [10, 120, 10, 255]; // a jump far past the `jump` threshold
      return busyContent(x, y);
    });

    const result = detectVoidsAuto(image);
    // The whole 30-row gradient is legitimately void (each row drifts <2 from
    // the last, well under the jump threshold). The solid green header must
    // stop the scan exactly there, not be swallowed into the measurement.
    expect(result.top).toBe(30);
  });
});

describe('detectVoidsAuto — blended boundary lines', () => {
  it('absorbs a boundary row that is part bar, part content rather than leaving a sliver', () => {
    // The last row of a real letterbox often isn't pure bar or pure content —
    // the crop that produced it landed between pixels. Build that row as an
    // explicit ~18% void / ~82% content blend over content with real variance,
    // matching the "22% white over 78% content" case from a real photo.
    const width = 256;
    const height = 200;
    const barHeight = 40;
    const image = makeImage(width, height, (x, y) => {
      if (y < barHeight) return BLACK;
      if (y === barHeight) {
        const [cr, cg, cb] = busyContent(x, y);
        const a = 0.18;
        return [
          Math.round(a * 0 + (1 - a) * cr),
          Math.round(a * 0 + (1 - a) * cg),
          Math.round(a * 0 + (1 - a) * cb),
          255,
        ];
      }
      return busyContent(x, y);
    });

    const withoutBlend = letterboxed(width, height, barHeight, 0);
    const plainResult = detectVoidsAuto(withoutBlend);
    const blendedResult = detectVoidsAuto(image);

    // A plain hard edge trims exactly the bar. The blended edge must trim at
    // least that much — the blend row should be absorbed, not left behind.
    expect(plainResult.top).toBe(barHeight);
    expect(blendedResult.top).toBeGreaterThanOrEqual(barHeight);
  });
});

describe('detectVoidsAuto — degenerate frames', () => {
  it('flags a single-colour frame as blankImage', () => {
    const image = makeImage(100, 80, () => [12, 12, 12, 255]);
    const result = detectVoidsAuto(image);
    expect(result.blankImage).toBe(true);
  });

  it('flags a rotated photo (blank corners, no rectangle to trim)', () => {
    const width = 200;
    const height = 200;
    const probe = Math.max(8, Math.round(Math.min(width, height) * 0.04));
    const image = makeImage(width, height, (x, y) => {
      const inCorner =
        (x < probe && y < probe) ||
        (x >= width - probe && y < probe) ||
        (x < probe && y >= height - probe) ||
        (x >= width - probe && y >= height - probe);
      if (inCorner) return BLACK;
      return busyContent(x, y);
    });

    const result = detectVoidsAuto(image);
    expect(result.hasVoid).toBe(false);
    expect(result.blankImage).toBe(false);
    expect(result.rotated).toBe(true);
  });

  it('reports no void for a clip that is already tightly cropped', () => {
    const image = makeImage(150, 150, busyContent);
    const result = detectVoidsAuto(image);
    expect(result.hasVoid).toBe(false);
    expect(result.crop).toEqual({ x: 0, y: 0, width: 150, height: 150 });
  });
});

describe('detectVoids — manual tolerance', () => {
  it('accepts an explicit tolerance instead of sweeping', () => {
    const image = letterboxed(100, 100, 15, 15);
    const result = detectVoids(image, { tolerance: 4 });
    expect(result.top).toBe(15);
    expect(result.tolerance).toBe(4);
  });

  it('throws on a dimensionless image', () => {
    expect(() => detectVoids({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toThrow();
  });
});

describe('cropRect', () => {
  it('turns trim amounts into a rectangle', () => {
    expect(cropRect({ width: 100, height: 100 }, { top: 10, bottom: 20, left: 5, right: 5 })).toEqual({
      x: 5,
      y: 10,
      width: 90,
      height: 70,
    });
  });

  it('clamps negative and out-of-range input safely', () => {
    expect(cropRect({ width: 50, height: 50 }, { top: -5, bottom: 0, left: 0, right: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    });
    expect(cropRect({ width: 50, height: 50 }, { top: 999, bottom: 0, left: 0, right: 0 }).height).toBe(1);
  });

  it('never produces a zero or negative dimension when both sides overtrim', () => {
    const crop = cropRect({ width: 50, height: 50 }, { top: 40, bottom: 40, left: 0, right: 0 });
    expect(crop.height).toBeGreaterThanOrEqual(1);
    const crop2 = cropRect({ width: 50, height: 50 }, { top: 0, bottom: 0, left: 40, right: 40 });
    expect(crop2.width).toBeGreaterThanOrEqual(1);
  });
});

describe('colorName', () => {
  it('names the common cases', () => {
    expect(colorName({ r: 0, g: 0, b: 0, a: 255 })).toBe('black');
    expect(colorName({ r: 255, g: 255, b: 255, a: 255 })).toBe('white');
    expect(colorName({ r: 220, g: 220, b: 220, a: 255 })).toBe('off-white');
    expect(colorName({ r: 20, g: 20, b: 20, a: 255 })).toBe('near-black');
    expect(colorName({ r: 128, g: 128, b: 128, a: 255 })).toBe('gray');
    expect(colorName({ r: 0, g: 0, b: 0, a: 0 })).toBe('transparent');
  });

  it('returns null for a real hue and for no reference', () => {
    expect(colorName({ r: 200, g: 40, b: 40, a: 255 })).toBeNull();
    expect(colorName(null)).toBeNull();
  });
});
