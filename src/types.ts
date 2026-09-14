import type * as THREE from 'three';

export type NumericArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

export type Mode = 'select' | 'vertex' | 'edge' | 'face' | 'square';
export type ViewPreset = 'top' | 'oblique' | 'profile';

export type PointColorMode = 'orthophoto' | 'class';

export interface RasterImage {
  width: number;
  height: number;
  samples: number;
  data: NumericArray;
  min?: number;
  max?: number;
}

export interface OrthoMetadata {
  building_fid?: number;
  crs?: string;
  extent_lv95?: [number, number, number, number];
  width?: number;
  height?: number;
  config?: {
    target_gsd_m?: number;
    height_gsd_m?: number;
  };
  quality?: Record<string, unknown>;
}

export interface SceneModel {
  source: 'point-cloud';
  label: string;
  positions: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  classifications?: Uint8Array;
  classCounts?: Record<string, number>;
  width?: number;
  height?: number;
  indices?: Uint32Array;
  textureCanvas?: HTMLCanvasElement;
  extent?: [number, number, number, number];
  center: { x: number; y: number };
  verticalOffset?: number;
  worldBounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  pointCount: number;
  metadata?: OrthoMetadata;
  colorRaster?: RasterImage;
  buildingOutline?: BuildingOutline;
}

export interface BuildingOutline {
  source: 'building-outline' | 'swissbuildings3d';
  rings: [number, number, number][][];
  heightExtent?: {
    yMin: number;
    yMax: number;
    zMin: number;
    zMax: number;
  };
}

export interface TerrainReference {
  terrain_tif: string;
  metadata_json?: string;
  extent_lv95?: [number, number, number, number] | null;
  gsd_m?: number | null;
}

export interface AnnotationVertex {
  id: string;
  position: [number, number, number];
}

export interface AnnotationSet {
  vertices: AnnotationVertex[];
  edges: [string, string][];
  faces: string[][];
}

export type AnnotationEdge = [string, string];

export interface ViewSettings {
  orthoOpacity: number;
  pointSize: number;
  showTerrain: boolean;
  colorPointsByHeight: boolean;
  showPoints: boolean;
  pointColorMode: PointColorMode;
}

export interface HitResult {
  point: THREE.Vector3;
  vertexId?: string;
}
