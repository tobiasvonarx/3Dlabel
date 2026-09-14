import type { OrthoMetadata, RasterImage, SceneModel } from '../types';
import { colorFromHeight, sampleRasterRgb } from './raster';

export function buildPointCloudSceneModel(params: {
  label: string;
  positions: Float64Array;
  classifications?: Uint8Array;
  verticalOffset?: number;
  metadata?: OrthoMetadata;
  correctedRaster?: RasterImage;
  blend: number;
}): SceneModel {
  const raw = params.positions;
  const count = raw.length / 3;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < count; i += 1) {
    const x = raw[i * 3];
    const y = raw[i * 3 + 1];
    const z = raw[i * 3 + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const extent = params.metadata?.extent_lv95;
  const center = extent
    ? { x: (extent[0] + extent[2]) / 2, y: (extent[1] + extent[3]) / 2 }
    : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const verticalOffset = Number.isFinite(params.verticalOffset) ? Number(params.verticalOffset) : minZ;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const classCounts = params.classifications ? pointClassCounts(params.classifications) : undefined;

  for (let i = 0; i < count; i += 1) {
    const worldX = raw[i * 3];
    const worldY = raw[i * 3 + 1];
    const z = raw[i * 3 + 2];
    positions[i * 3] = worldX - center.x;
    positions[i * 3 + 1] = z - verticalOffset;
    positions[i * 3 + 2] = -(worldY - center.y);

    const uv = pointUv(worldX, worldY, extent ?? [minX, minY, maxX, maxY]);
    uvs[i * 2] = uv[0];
    uvs[i * 2 + 1] = uv[1];
  }
  const colors = pointColorsFromRaster(positions, uvs, { minX, maxX, minY, maxY, minZ, maxZ }, verticalOffset, params.correctedRaster, params.blend);

  return {
    source: 'point-cloud',
    label: params.label,
    positions,
    colors,
    uvs,
    classifications: params.classifications,
    classCounts,
    extent,
    center,
    verticalOffset,
    worldBounds: { minX, maxX, minY, maxY, minZ, maxZ },
    pointCount: count,
    metadata: params.metadata,
    colorRaster: params.correctedRaster
  };
}

function pointColorsFromRaster(
  positions: Float32Array,
  uvs: Float32Array,
  bounds: SceneModel['worldBounds'],
  verticalOffset: number,
  raster: RasterImage | undefined,
  blendValue: number
): Float32Array {
  const count = positions.length / 3;
  const colors = new Float32Array(count * 3);
  const blend = clamp01(blendValue);
  for (let i = 0; i < count; i += 1) {
    const z = positions[i * 3 + 1] + verticalOffset;
    const base = colorFromHeight(z, bounds.minZ, bounds.maxZ);
    const draped = sampleRasterByUv(raster, uvs[i * 2], uvs[i * 2 + 1]);
    colors[i * 3] = base[0] * (1 - blend) + draped[0] * blend;
    colors[i * 3 + 1] = base[1] * (1 - blend) + draped[1] * blend;
    colors[i * 3 + 2] = base[2] * (1 - blend) + draped[2] * blend;
  }
  return colors;
}

function pointClassCounts(classifications: Uint8Array): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const classId of classifications) {
    const key = String(classId);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sampleRasterByUv(raster: RasterImage | undefined, u: number, v: number): [number, number, number] {
  if (!raster) return [0.82, 0.82, 0.82];
  return sampleRasterRgb(raster, u * (raster.width - 1), (1 - v) * (raster.height - 1));
}

function pointUv(x: number, y: number, extent: [number, number, number, number]): [number, number] {
  const u = (x - extent[0]) / (extent[2] - extent[0] || 1);
  const v = (y - extent[1]) / (extent[3] - extent[1] || 1);
  return [clamp01(u), clamp01(v)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
