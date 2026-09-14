import { fromArrayBuffer, fromUrl, type GeoTIFFImage } from 'geotiff';
import * as THREE from 'three';
import type { NumericArray, RasterImage } from '../types';

export interface GeoRaster {
  raster: RasterImage;
  /** [minX, minY, maxX, maxY] in the file's CRS, when georeferencing tags exist. */
  extent: [number, number, number, number] | null;
}

export async function loadTiffFromUrl(url: string): Promise<RasterImage> {
  const tiff = await fromUrl(url);
  return readImageRaster(await tiff.getImage());
}

export async function loadGeoTiffFromArrayBuffer(buffer: ArrayBuffer): Promise<GeoRaster> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const raster = await readImageRaster(image);
  let extent: GeoRaster['extent'] = null;
  try {
    const box = image.getBoundingBox();
    if (box.length === 4 && box.every((value: number) => Number.isFinite(value))) {
      extent = [box[0], box[1], box[2], box[3]];
    }
  } catch {
    // No georeferencing tags; caller may supply an extent manually.
  }
  return { raster, extent };
}

async function readImageRaster(image: GeoTIFFImage): Promise<RasterImage> {
  const data = (await image.readRasters({ interleave: true })) as NumericArray;
  return summarizeRaster({
    width: image.getWidth(),
    height: image.getHeight(),
    samples: image.getSamplesPerPixel(),
    data
  });
}

export function rasterToCanvas(raster: RasterImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas context');
  }

  const image = ctx.createImageData(raster.width, raster.height);
  const samples = raster.samples;
  const min = raster.min ?? 0;
  const max = raster.max ?? 1;
  const spread = max - min || 1;

  for (let i = 0; i < raster.width * raster.height; i += 1) {
    const dst = i * 4;
    if (samples >= 3) {
      image.data[dst] = clampByte(Number(raster.data[i * samples]));
      image.data[dst + 1] = clampByte(Number(raster.data[i * samples + 1]));
      image.data[dst + 2] = clampByte(Number(raster.data[i * samples + 2]));
    } else {
      const value = ((Number(raster.data[i]) - min) / spread) * 255;
      image.data[dst] = clampByte(value);
      image.data[dst + 1] = clampByte(value);
      image.data[dst + 2] = clampByte(value);
    }
    image.data[dst + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function createTexture(canvas?: HTMLCanvasElement): THREE.CanvasTexture | undefined {
  if (!canvas) return undefined;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

export function sampleRasterRgb(raster: RasterImage | undefined, x: number, y: number): [number, number, number] {
  if (!raster) return [0.85, 0.85, 0.85];
  const col = clamp(Math.round(x), 0, raster.width - 1);
  const row = clamp(Math.round(y), 0, raster.height - 1);
  const src = (row * raster.width + col) * raster.samples;
  if (raster.samples >= 3) {
    return [
      clamp01(Number(raster.data[src]) / 255),
      clamp01(Number(raster.data[src + 1]) / 255),
      clamp01(Number(raster.data[src + 2]) / 255)
    ];
  }
  const value = Number(raster.data[row * raster.width + col]);
  const min = raster.min ?? 0;
  const max = raster.max ?? 1;
  const gray = clamp01((value - min) / (max - min || 1));
  return [gray, gray, gray];
}

export function sampleRasterValue(raster: RasterImage | undefined, x: number, y: number): number | null {
  if (!raster) return null;
  const col = clamp(Math.round(x), 0, raster.width - 1);
  const row = clamp(Math.round(y), 0, raster.height - 1);
  const value = Number(raster.data[(row * raster.width + col) * raster.samples]);
  return Number.isFinite(value) ? value : null;
}

export function colorFromHeight(z: number, minZ: number, maxZ: number): [number, number, number] {
  const t = clamp01((z - minZ) / (maxZ - minZ || 1));
  const low = new THREE.Color('#1d4d58');
  const mid = new THREE.Color('#c7b26b');
  const high = new THREE.Color('#ece6d7');
  const color = t < 0.5 ? low.lerp(mid, t * 2) : mid.lerp(high, (t - 0.5) * 2);
  return [color.r, color.g, color.b];
}

function summarizeRaster(raster: RasterImage): RasterImage {
  if (raster.samples > 1) return raster;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < raster.data.length; i += 1) {
    const value = Number(raster.data[i]);
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { ...raster, min, max };
}

function clampByte(value: number): number {
  return clamp(Math.round(value), 0, 255);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
