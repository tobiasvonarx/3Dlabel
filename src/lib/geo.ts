import proj4 from 'proj4';
import type { SceneModel } from '../types';

export interface GeolocatedPoint {
  lat: number;
  lon: number;
}

/**
 * Well-known projected CRS definitions bundled so scenes geolocate offline.
 * Anything else can be supplied as a raw proj4 string in place of an EPSG code.
 */
const CRS_DEFINITIONS: Record<string, string> = {
  'EPSG:2056':
    '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  'EPSG:21781':
    '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=600000 +y_0=200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:31370':
    '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs',
  'EPSG:27700':
    '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  'EPSG:2154':
    '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:28992':
    '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs',
  'EPSG:31983': '+proj=utm +zone=23 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:3857': '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs'
};

const BRAZIL_BOUNDS = { minLat: -34, maxLat: 6, minLon: -74, maxLon: -34 };

/**
 * Resolves a CRS identifier to a planar->WGS84 converter, or null when unknown.
 * Accepts EPSG codes from the bundled table, WGS84/UTM (EPSG:326xx/327xx)
 * synthesized on the fly, EPSG:4326 passthrough, and raw proj4 strings.
 */
export function crsToWgs84Converter(crs: string | undefined): ((x: number, y: number) => GeolocatedPoint) | null {
  const raw = (crs ?? '').trim();
  if (!raw) return null;
  const normalized = raw.toUpperCase().replace(/\s+/g, '');
  if (normalized === 'EPSG:4326' || normalized === 'EPSG:4674' || normalized === 'WGS84' || normalized === 'CRS:84') {
    return (x, y) => chooseGeographicCoordinate(x, y, normalized);
  }

  let definition = CRS_DEFINITIONS[normalized];
  if (!definition) {
    const utm = normalized.match(/^EPSG:(326|327)(\d{2})$/);
    if (utm) {
      definition = `+proj=utm +zone=${Number(utm[2])}${utm[1] === '327' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    }
  }
  if (!definition) {
    const sirgasBrazilNorthUtm = normalized.match(/^EPSG:319(7[1-6])$/);
    const sirgasBrazilSouthUtm = normalized.match(/^EPSG:319(7[7-9]|8[0-5])$/);
    if (sirgasBrazilNorthUtm) {
      definition = `+proj=utm +zone=${Number(sirgasBrazilNorthUtm[1]) - 54} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
    } else if (sirgasBrazilSouthUtm) {
      definition = `+proj=utm +zone=${Number(sirgasBrazilSouthUtm[1]) - 60} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
    }
  }
  if (!definition && raw.startsWith('+')) definition = raw;
  if (!definition) return null;

  try {
    const converter = proj4(definition, 'EPSG:4326');
    return (x, y) => {
      const convert = (east: number, north: number): GeolocatedPoint => {
        const [lon, lat] = converter.forward([east, north]);
        return { lat, lon };
      };
      return chooseProjectedCoordinate(convert(x, y), convert(y, x), normalized);
    };
  } catch {
    return null;
  }
}

export function isKnownCrs(crs: string | undefined): boolean {
  return crsToWgs84Converter(crs) !== null;
}

/**
 * Effective CRS of a model: its metadata CRS when present, else an LV95
 * bounds heuristic for legacy Swiss patches without metadata.
 */
function modelCrs(model: SceneModel): string | undefined {
  const crs = model.metadata?.crs;
  if (crs) return crs;
  const { x, y } = model.center;
  if (x > 2_400_000 && x < 2_900_000 && y > 1_000_000 && y < 1_400_000) return 'EPSG:2056';
  return undefined;
}

/** Converts a world-coordinate point of the model to WGS84, or null when not georeferenced. */
export function modelPointToWgs84(model: SceneModel, x: number, y: number): GeolocatedPoint | null {
  const converter = crsToWgs84Converter(modelCrs(model));
  if (!converter) return null;
  const point = converter(x, y);
  return isValidWgs84(point) ? point : null;
}

/**
 * Resolves the WGS84 position of the model's local origin, or null when the
 * model carries no usable georeference.
 */
export function geolocateModel(model: SceneModel): GeolocatedPoint | null {
  return modelPointToWgs84(model, model.center.x, model.center.y);
}

function chooseGeographicCoordinate(x: number, y: number, crs: string): GeolocatedPoint {
  const lonLat = { lon: x, lat: y };
  const latLon = { lon: y, lat: x };
  return chooseCoordinateCandidates(lonLat, latLon, crs);
}

function chooseProjectedCoordinate(primary: GeolocatedPoint, swappedAxes: GeolocatedPoint, crs: string): GeolocatedPoint {
  return chooseCoordinateCandidates(primary, swappedAxes, crs);
}

function chooseCoordinateCandidates(primary: GeolocatedPoint, swappedAxes: GeolocatedPoint, crs: string): GeolocatedPoint {
  const primaryValid = isValidWgs84(primary);
  const swappedValid = isValidWgs84(swappedAxes);
  if (primaryValid && !swappedValid) return primary;
  if (swappedValid && !primaryValid) return swappedAxes;
  if (primaryValid && swappedValid && isBrazilCrs(crs)) {
    const primaryInBrazil = isInBounds(primary, BRAZIL_BOUNDS);
    const swappedInBrazil = isInBounds(swappedAxes, BRAZIL_BOUNDS);
    if (swappedInBrazil && !primaryInBrazil) return swappedAxes;
  }
  return primary;
}

function isValidWgs84(point: GeolocatedPoint): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function isBrazilCrs(crs: string): boolean {
  return crs === 'EPSG:4326' || crs === 'EPSG:4674' || crs === 'WGS84' || /^EPSG:319(7[1-9]|8[0-5])$/.test(crs);
}

function isInBounds(point: GeolocatedPoint, bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number }): boolean {
  return point.lat >= bounds.minLat && point.lat <= bounds.maxLat && point.lon >= bounds.minLon && point.lon <= bounds.maxLon;
}
