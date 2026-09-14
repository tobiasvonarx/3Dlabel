import type { BuildingOutline, RasterImage, SceneModel } from '../types';
import { buildPointCloudSceneModel } from './pointCloud';
import { parsePointFile, isPointFileName } from './pointFiles';
import { loadGeoTiffFromArrayBuffer, rasterToCanvas } from './raster';

export const SCENE_SCHEMA = 'label3d-scene-v1';

/** Manifest of a portable 3Dlabel scene bundle (`scene.json`). */
export interface SceneManifest {
  schema: string;
  name: string;
  /** Grouping key shown in the library (e.g. a patch or campaign id). */
  collection?: string;
  /** EPSG code or proj4 string; omit for purely local coordinates. */
  crs?: string;
  units?: string;
  points: string;
  dem?: string;
  /** [minX, minY, maxX, maxY] override when the DEM has no geo tags. */
  dem_extent?: [number, number, number, number];
  /** Building/site bbox used for framing and exports. */
  focus_extent?: [number, number, number, number];
  /** Floor height in CRS units; defaults to the lowest point. */
  base_height?: number;
  /** Optional building scaffold GeoJSON used for the Ctrl outline overlay. */
  building_outline?: string;
  annotations?: string;
  /** Manually locked Google-tiles shift in meters: east, north, height. */
  earth_alignment?: { de: number; dn: number; dh: number };
}

export interface SceneLibraryEntry {
  id: string;
  name: string;
  collection: string;
  crs: string | null;
  hasAnnotations: boolean;
  earthAlignment: { de: number; dn: number; dh: number } | null;
  baseUrl: string;
}

/** Abstract file access so bundles load from the server library or picked files. */
export interface SceneBundleSource {
  label: string;
  /** Library identifier when the bundle lives under a server-managed root. */
  libraryId?: string;
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export interface LoadedSceneBundle {
  manifest: SceneManifest;
  model: SceneModel;
  terrainRaster: RasterImage | null;
  terrainExtent: [number, number, number, number] | null;
  annotationJson: string | null;
  libraryId?: string;
}

export async function loadSceneBundle(source: SceneBundleSource): Promise<LoadedSceneBundle> {
  const manifestText = await source.readText('scene.json');
  if (!manifestText) throw new Error(`${source.label}: scene.json not found.`);
  let manifest: SceneManifest;
  try {
    manifest = JSON.parse(manifestText) as SceneManifest;
  } catch {
    throw new Error(`${source.label}: scene.json is not valid JSON.`);
  }
  if (manifest.schema !== SCENE_SCHEMA) {
    throw new Error(`${source.label}: unsupported schema "${manifest.schema}" (expected ${SCENE_SCHEMA}).`);
  }
  if (!manifest.points) throw new Error(`${source.label}: scene.json has no "points" entry.`);
  return loadSceneFromParts(source, manifest);
}

/** Loads loose files (point cloud + optional DEM) without a scene.json. */
export async function loadLooseScene(
  source: SceneBundleSource,
  options: { pointsPath: string; demPath?: string; crs?: string; name?: string }
): Promise<LoadedSceneBundle> {
  const manifest: SceneManifest = {
    schema: SCENE_SCHEMA,
    name: options.name ?? options.pointsPath.replace(/\.[^.]+$/, ''),
    crs: options.crs,
    points: options.pointsPath,
    dem: options.demPath
  };
  return loadSceneFromParts(source, manifest);
}

async function loadSceneFromParts(source: SceneBundleSource, manifest: SceneManifest): Promise<LoadedSceneBundle> {
  const pointsBuffer = await source.readBinary(manifest.points);
  const parsed = parsePointFile(manifest.points, pointsBuffer);

  let terrainRaster: RasterImage | null = null;
  let terrainExtent: [number, number, number, number] | null = null;
  if (manifest.dem) {
    const demBuffer = await source.readBinary(manifest.dem);
    const geoRaster = await loadGeoTiffFromArrayBuffer(demBuffer);
    terrainRaster = geoRaster.raster;
    terrainExtent = manifest.dem_extent ?? geoRaster.extent;
    if (!terrainExtent) {
      throw new Error(`${source.label}: DEM has no georeferencing tags; add "dem_extent" to scene.json.`);
    }
  }

  const model = buildPointCloudSceneModel({
    label: manifest.name || source.label,
    positions: parsed.positions,
    classifications: parsed.classifications,
    verticalOffset: manifest.base_height,
    metadata: {
      crs: manifest.crs,
      extent_lv95: terrainExtent ?? manifest.focus_extent ?? undefined
    },
    blend: 0
  });
  if (terrainRaster && terrainExtent) {
    model.textureCanvas = rasterToCanvas(terrainRaster);
  }
  if (manifest.building_outline) {
    const outlineText = await source.readText(manifest.building_outline);
    if (!outlineText) {
      throw new Error(`${source.label}: missing building outline "${manifest.building_outline}".`);
    }
    model.buildingOutline = buildingOutlineFromGeoJson(outlineText, model);
  }

  const annotationJson = manifest.annotations ? await source.readText(manifest.annotations) : null;
  return {
    manifest,
    model,
    terrainRaster,
    terrainExtent,
    annotationJson,
    libraryId: source.libraryId
  };
}

interface GeoJsonGeometry {
  type?: string;
  coordinates?: unknown;
}

interface GeoJsonFeature {
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
}

interface GeoJsonFeatureCollection {
  features?: GeoJsonFeature[];
}

type WorldCoordinate = [number, number, number | null];
type Plane = [number, number, number];

function buildingOutlineFromGeoJson(text: string, model: SceneModel): BuildingOutline | undefined {
  let payload: GeoJsonFeatureCollection;
  try {
    payload = JSON.parse(text) as GeoJsonFeatureCollection;
  } catch {
    throw new Error(`${model.label}: building outline GeoJSON is not valid JSON.`);
  }
  const features = Array.isArray(payload.features) ? payload.features : [];
  if (!features.length) return undefined;

  const worldHeights = featureWorldHeights(features);
  const verticalOffset = model.verticalOffset ?? 0;
  const minWorldZ = worldHeights.length ? Math.min(...worldHeights) : model.worldBounds.minZ;
  const maxWorldZ = worldHeights.length ? Math.max(...worldHeights) : model.worldBounds.maxZ;
  const yMin = minWorldZ - verticalOffset;
  const yMax = maxWorldZ - verticalOffset;
  const envelope = features.find((feature) => featureKind(feature) === 'roof_envelope');
  const roofFaces = features.filter((feature) => featureKind(feature) === 'roof_face');
  const sourceFeatures = envelope ? [envelope] : roofFaces.length ? roofFaces : features;
  const fallbackWorldZ = worldHeights.length ? maxWorldZ : minWorldZ;
  const rings = sourceFeatures
    .flatMap((feature) => localRingsFromFeature(feature, model, fallbackWorldZ))
    .filter((ring) => ring.length >= 3);
  if (!rings.length) return undefined;

  const localZs = rings.flatMap((ring) => ring.map((point) => point[2]));
  return {
    source: 'building-outline',
    rings,
    heightExtent: worldHeights.length
      ? {
          yMin,
          yMax,
          zMin: Math.min(...localZs),
          zMax: Math.max(...localZs)
        }
      : undefined
  };
}

function featureWorldHeights(features: GeoJsonFeature[]): number[] {
  const heights: number[] = [];
  for (const feature of features) {
    const zMin = finiteNumber(feature.properties?.z_min);
    const zMax = finiteNumber(feature.properties?.z_max);
    if (zMin !== null) heights.push(zMin);
    if (zMax !== null) heights.push(zMax);
    const plane = planeCoeffs(feature.properties?.plane_coeffs);
    for (const coord of geometryCoordinates(feature.geometry)) {
      const z = coord[2] ?? (plane ? plane[0] * coord[0] + plane[1] * coord[1] + plane[2] : null);
      if (z !== null && Number.isFinite(z)) heights.push(z);
    }
  }
  return heights;
}

function localRingsFromFeature(feature: GeoJsonFeature, model: SceneModel, fallbackWorldZ: number): [number, number, number][][] {
  const geometry = feature.geometry;
  if (!geometry?.coordinates) return [];
  return geometryRings(geometry)
    .map((ring) => ring.map((coord) => worldToLocal(coord[0], coord[1], coord[2] ?? fallbackWorldZ, model)))
    .filter((ring) => uniquePlanarPointCount(ring) >= 3);
}

function geometryRings(geometry: GeoJsonGeometry): WorldCoordinate[][] {
  return geometryPolygons(geometry).flat();
}

function geometryPolygons(geometry: GeoJsonGeometry): WorldCoordinate[][][] {
  if (geometry.type === 'Polygon') {
    const rings = polygonRings(geometry.coordinates);
    return rings.length ? [rings] : [];
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((polygon) => polygonRings(polygon)).filter((rings) => rings.length);
  }
  return [];
}

function polygonRings(value: unknown): WorldCoordinate[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map((ring) => (Array.isArray(ring) ? ring.map(worldCoordinate).filter((coord): coord is WorldCoordinate => coord !== null) : []))
    .filter((ring) => ring.length >= 3);
}

function geometryCoordinates(geometry: GeoJsonGeometry | null | undefined): WorldCoordinate[] {
  if (!geometry?.coordinates) return [];
  return geometryRings(geometry).flat();
}

function worldCoordinate(value: unknown): WorldCoordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = finiteNumber(value[0]);
  const y = finiteNumber(value[1]);
  const z = value.length >= 3 ? finiteNumber(value[2]) : null;
  if (x === null || y === null) return null;
  return [x, y, z];
}

function worldToLocal(worldX: number, worldY: number, worldZ: number, model: SceneModel): [number, number, number] {
  const verticalOffset = model.verticalOffset ?? 0;
  return [
    worldX - model.center.x,
    worldZ - verticalOffset,
    -(worldY - model.center.y)
  ];
}

function uniquePlanarPointCount(ring: [number, number, number][]): number {
  return new Set(ring.map((point) => `${point[0].toFixed(4)},${point[2].toFixed(4)}`)).size;
}

function featureKind(feature: GeoJsonFeature): string {
  return String(feature.properties?.kind ?? '');
}

function planeCoeffs(value: unknown): Plane | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const a = finiteNumber(value[0]);
  const b = finiteNumber(value[1]);
  const c = finiteNumber(value[2]);
  return a === null || b === null || c === null ? null : [a, b, c];
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

/** Source over picked/dropped files, matched by basename (directory pickers include paths). */
export function sourceFromFiles(files: File[], label: string): SceneBundleSource {
  const byName = new Map<string, File>();
  for (const file of files) {
    byName.set(file.name, file);
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relative) byName.set(relative.split('/').slice(1).join('/'), file);
  }
  const find = (path: string) => byName.get(path) ?? byName.get(path.split('/').pop() ?? path) ?? null;
  return {
    label,
    async readText(path) {
      const file = find(path);
      return file ? file.text() : null;
    },
    async readBinary(path) {
      const file = find(path);
      if (!file) throw new Error(`${label}: missing file "${path}".`);
      return file.arrayBuffer();
    }
  };
}

/** Source over server-managed portable scene bundle URLs. */
export function sourceFromLibrary(entry: Pick<SceneLibraryEntry, 'id' | 'name' | 'baseUrl'>): SceneBundleSource {
  const urlFor = (path: string) => `${entry.baseUrl}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    label: entry.name,
    libraryId: entry.id,
    async readText(path) {
      const response = await fetch(urlFor(path));
      return response.ok ? response.text() : null;
    },
    async readBinary(path) {
      const response = await fetch(urlFor(path));
      if (!response.ok) throw new Error(`${entry.name}: could not load ${path} (${response.status}).`);
      return response.arrayBuffer();
    }
  };
}

export function pickPointFile(files: File[]): File | null {
  return files.find((file) => isPointFileName(file.name)) ?? null;
}

export function pickDemFile(files: File[]): File | null {
  return files.find((file) => /\.(tif|tiff)$/i.test(file.name)) ?? null;
}

export function hasSceneManifest(files: File[]): boolean {
  return files.some((file) => file.name === 'scene.json');
}
