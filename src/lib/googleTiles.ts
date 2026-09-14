import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';

const ROOT_TILESET_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const CACHE_NAME = 'google-3d-tiles-v1';
// Google sessions stay valid for at least 3 h after a root tileset request, so a
// cached root.json (whose child URIs embed the session token) is reusable below that.
const ROOT_TILESET_TTL_MS = 2.5 * 60 * 60 * 1000;
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1500;
const EARTH_CAMERA_FAR = 30000;

export interface GoogleTilesLayer {
  group: THREE.Object3D;
  update(): void;
  /** Adds a scene-space translation on top of the georeferenced placement. */
  applyLocalOffset(offset: { x: number; y: number; z: number }): void;
  /** Sets the full scene-space translation on top of the georeferenced placement. */
  setLocalOffset(offset: { x: number; y: number; z: number }): void;
  setOpacity(opacity: number): void;
  getAttributions(): string;
  dispose(): void;
}

interface GoogleTilesOptions {
  apiKey: string;
  /** WGS84 latitude of the scene's local origin, in degrees. */
  lat: number;
  /** WGS84 longitude of the scene's local origin, in degrees. */
  lon: number;
  /** Ellipsoidal height of the scene's local origin, in meters. */
  originHeight: number;
  opacity?: number;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
}

/**
 * Streams Google Photorealistic 3D Tiles into the existing scene, oriented so the
 * given lat/lon/height sits at the local origin with X=east, Y=up, Z=south (the
 * app's local frame). Only the root tileset request is billable; tile payloads
 * are additionally cached persistently to avoid refetching across sessions.
 */
export function createGoogleTilesLayer(options: GoogleTilesOptions): GoogleTilesLayer {
  const { apiKey, lat, lon, camera, renderer } = options;
  let opacity = clampOpacity(options.opacity ?? 1);
  const latRad = lat * THREE.MathUtils.DEG2RAD;
  const lonRad = lon * THREE.MathUtils.DEG2RAD;

  const tiles = new TilesRenderer(ROOT_TILESET_URL);
  tiles.registerPlugin(new CachedGoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }) as unknown as Parameters<typeof tiles.registerPlugin>[0]);

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));

  // azimuth PI turns the plugin's X=west/Z=north frame into the app's X=east/Z=south.
  const reorientation = new ReorientationPlugin({
    lat: latRad,
    lon: lonRad,
    height: options.originHeight,
    azimuth: Math.PI
  });
  tiles.registerPlugin(reorientation);

  // Offsets applied on top of the georeferenced placement. The reorientation
  // plugin rebuilds the group transform when the root tileset loads (async),
  // which would wipe offsets applied before that — so they are tracked here and
  // re-applied after every root-load reorientation.
  const extraOffset = new THREE.Vector3();
  (tiles as unknown as THREE.EventDispatcher<Record<string, object>>).addEventListener('load-root-tileset' as never, () => {
    // Runs after the ReorientationPlugin's own listener (registered earlier).
    tiles.group.position.add(extraOffset);
    tiles.group.updateMatrixWorld();
  });

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  // Coarser error target than the recommended 20: fewer tile fetches, still sharp
  // enough as an annotation backdrop.
  tiles.errorTarget = 28;
  tiles.group.name = 'googleEarthTiles';

  // The photorealistic tiles carry baked imagery; render them unlit and ignore the
  // stylized scene fog and lights.
  const onLoadModel = ({ scene }: { scene: THREE.Object3D }) => {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.material) return;
      mesh.material = normalizeTileMaterial(mesh.material, opacity);
    });
  };
  (tiles as unknown as THREE.EventDispatcher<Record<string, { scene: THREE.Object3D }>>).addEventListener('load-model', onLoadModel as never);

  return {
    group: tiles.group,
    update() {
      if (camera.far < EARTH_CAMERA_FAR) {
        camera.far = EARTH_CAMERA_FAR;
        camera.updateProjectionMatrix();
      }
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
    },
    applyLocalOffset(offset: { x: number; y: number; z: number }) {
      extraOffset.x += offset.x;
      extraOffset.y += offset.y;
      extraOffset.z += offset.z;
      tiles.group.position.x += offset.x;
      tiles.group.position.y += offset.y;
      tiles.group.position.z += offset.z;
      tiles.group.updateMatrixWorld();
    },
    setLocalOffset(offset: { x: number; y: number; z: number }) {
      this.applyLocalOffset({
        x: offset.x - extraOffset.x,
        y: offset.y - extraOffset.y,
        z: offset.z - extraOffset.z
      });
    },
    setOpacity(nextOpacity: number) {
      opacity = clampOpacity(nextOpacity);
      tiles.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.material) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) applyMaterialOpacity(material, opacity);
      });
    },
    getAttributions() {
      const items: Array<{ type: string; value: unknown }> = [];
      tiles.getAttributions(items);
      return items
        .filter((item) => item.type === 'string' && typeof item.value === 'string')
        .map((item) => item.value as string)
        .join(' · ');
    },
    dispose() {
      tiles.dispose();
      dracoLoader.dispose();
    }
  };
}

function normalizeTileMaterial(material: THREE.Material | THREE.Material[], opacity: number): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) {
    return material.map((item) => normalizeTileMaterial(item, opacity) as THREE.Material);
  }
  if (material instanceof THREE.MeshBasicMaterial) {
    material.fog = false;
    applyMaterialOpacity(material, opacity);
    return material;
  }
  const source = material as THREE.Material & { map?: THREE.Texture | null };
  const basic = new THREE.MeshBasicMaterial({ map: source.map ?? null });
  basic.fog = false;
  applyMaterialOpacity(basic, opacity);
  material.dispose();
  return basic;
}

function applyMaterialOpacity(material: THREE.Material, opacity: number): void {
  material.opacity = opacity;
  material.transparent = opacity < 0.999;
  material.depthWrite = opacity >= 0.999;
  material.needsUpdate = true;
}

function clampOpacity(value: number): number {
  return Math.max(0.05, Math.min(1, Number.isFinite(value) ? value : 1));
}

const baseAuthPrototype = GoogleCloudAuthPlugin.prototype as unknown as {
  fetchData(url: string | URL, options: RequestInit): Promise<Response | object>;
};

/**
 * GoogleCloudAuthPlugin with a persistent Cache API layer. Entries are keyed on the
 * URL with `key`/`session` stripped, so cached tiles stay valid across sessions.
 * Caching root.json avoids the billable root tileset request on reloads within the
 * session-token lifetime.
 */
class CachedGoogleCloudAuthPlugin extends GoogleCloudAuthPlugin {
  private cachePromise: Promise<Cache | null>;

  constructor(options: { apiToken: string; autoRefreshToken?: boolean }) {
    super(options);
    this.cachePromise = openTileCache();
  }

  async fetchData(url: string | URL, options: RequestInit): Promise<Response | object> {
    const urlString = String(url);
    if (!urlString.includes('tile.googleapis.com')) {
      return baseAuthPrototype.fetchData.call(this, url, options);
    }

    const isRoot = urlString.includes('/3dtiles/root.json');
    const cache = await this.cachePromise;
    const cacheKey = normalizedCacheKey(urlString);

    if (cache) {
      const hit = await cache.match(cacheKey).catch(() => undefined);
      if (hit) {
        const age = Date.now() - Number(hit.headers.get('x-cached-at') ?? 0);
        if (age < (isRoot ? ROOT_TILESET_TTL_MS : TILE_TTL_MS)) {
          if (!isRoot) return hit;
          const json = (await hit.json().catch(() => null)) as object | null;
          const session = json ? extractSessionToken(json) : null;
          if (json && session) {
            // The base plugin normally captures the session token while parsing the
            // root response; restore it here so child fetches are not JSON-parsed.
            (this as unknown as { auth: { sessionToken: string | null } }).auth.sessionToken = session;
            return json;
          }
        }
        await cache.delete(cacheKey).catch(() => undefined);
      }
    }

    const result = await baseAuthPrototype.fetchData.call(this, url, options);
    if (!cache) return result;

    if (isRoot) {
      if (result && !(result instanceof Response)) {
        const body = JSON.stringify(result);
        void cache
          .put(cacheKey, new Response(body, { headers: cacheHeaders('application/json') }))
          .catch(() => undefined);
      }
      return result;
    }

    if (result instanceof Response && result.ok) {
      const clone = result.clone();
      void clone
        .arrayBuffer()
        .then((buffer) =>
          cache.put(
            cacheKey,
            new Response(buffer, { headers: cacheHeaders(clone.headers.get('content-type') ?? 'application/octet-stream') })
          )
        )
        .catch(() => undefined);
    } else if (result instanceof Response && result.status >= 400 && result.status < 500) {
      // A stale cached root (expired session) poisons child requests; drop it so the
      // next load fetches a fresh root tileset.
      void cache.delete(normalizedCacheKey(ROOT_TILESET_URL)).catch(() => undefined);
    }
    return result;
  }
}

function cacheHeaders(contentType: string): Record<string, string> {
  return { 'content-type': contentType, 'x-cached-at': String(Date.now()) };
}

function normalizedCacheKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('key');
  parsed.searchParams.delete('session');
  return parsed.toString();
}

function extractSessionToken(json: object): string | null {
  const match = JSON.stringify(json).match(/[?&]session=([^"&\\]+)/);
  return match ? match[1] : null;
}

async function openTileCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(CACHE_NAME);
    void trimTileCache(cache);
    return cache;
  } catch {
    return null;
  }
}

async function trimTileCache(cache: Cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    const stamped = await Promise.all(
      keys.map(async (request) => ({
        request,
        cachedAt: Number((await cache.match(request))?.headers.get('x-cached-at') ?? 0)
      }))
    );
    stamped.sort((a, b) => a.cachedAt - b.cachedAt);
    const removeCount = keys.length - Math.floor(MAX_CACHE_ENTRIES * 0.8);
    for (const { request } of stamped.slice(0, removeCount)) {
      await cache.delete(request);
    }
  } catch {
    // Cache trimming is best-effort.
  }
}
