export type Point = readonly [number, number];

export type Shape =
  | { readonly type: 'polygon'; readonly points: readonly Point[]; readonly fill: string }
  | { readonly type: 'stroke'; readonly from: Point; readonly to: Point; readonly width: number; readonly fill: string };

export const ICON_DIR: string;
export const BACKGROUND: string;
export const SHAPES: readonly Shape[];
export const MASKABLE_SCALE: number;
export const RASTER_ICONS: ReadonlyArray<{ readonly file: string; readonly size: number; readonly scale: number }>;

export function iconSvg(): string;
export function rasterize(size: number, scale?: number): Uint8Array;
export function crc32(bytes: Uint8Array): number;
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array;
