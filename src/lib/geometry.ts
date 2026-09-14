export type Point2 = [number, number];
export type Point3 = [number, number, number];

export const GEOMETRY_EPS = 1e-5;

export function faceYAtLocalXZ(points: Point3[], x: number, z: number): number | null {
  if (points.length > 3) {
    for (let index = 1; index < points.length - 1; index += 1) {
      const triangle: [Point3, Point3, Point3] = [points[0], points[index], points[index + 1]];
      if (!pointInTriangleXZ([x, z], triangle)) continue;
      const y = planeYAtLocalXZ(triangle, x, z);
      if (y !== null) return y;
    }
  }
  return planeYAtLocalXZ(points, x, z);
}

export function faceNormal(points: Point3[]): Point3 | null {
  if (points.length < 3) return null;
  for (let index = 1; index < points.length - 1; index += 1) {
    const normal = cross(subtract(points[index], points[0]), subtract(points[index + 1], points[0]));
    if (vectorLength(normal) > 1e-6) return normalizeVector(normal);
  }
  return null;
}

export function segmentIntersectionParameter(start: Point2, end: Point2, edgeStart: Point2, edgeEnd: Point2): number | null {
  const r: Point2 = [end[0] - start[0], end[1] - start[1]];
  const s: Point2 = [edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1]];
  const denominator = cross2d(r, s);
  if (Math.abs(denominator) <= 1e-9) return null;
  const delta: Point2 = [edgeStart[0] - start[0], edgeStart[1] - start[1]];
  const t = cross2d(delta, s) / denominator;
  const u = cross2d(delta, r) / denominator;
  if (t <= GEOMETRY_EPS || t >= 1 - GEOMETRY_EPS || u < -GEOMETRY_EPS || u > 1 + GEOMETRY_EPS) return null;
  return t;
}

export function interpolatePoint(a: Point3, b: Point3, t: number): Point3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function subtract(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Point3, b: Point3): Point3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalizeVector(vector: Point3): Point3 {
  const length = vectorLength(vector);
  return length > 1e-8 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 0];
}

export function vectorLength(vector: Point3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function planeYAtLocalXZ(points: Point3[], x: number, z: number): number | null {
  const normal = faceNormal(points);
  if (!normal || Math.abs(normal[1]) <= 1e-9) return null;
  const origin = points[0];
  return origin[1] - (normal[0] * (x - origin[0]) + normal[2] * (z - origin[2])) / normal[1];
}

function pointInTriangleXZ(point: Point2, triangle: [Point3, Point3, Point3]): boolean {
  const a: Point2 = [triangle[0][0], triangle[0][2]];
  const b: Point2 = [triangle[1][0], triangle[1][2]];
  const c: Point2 = [triangle[2][0], triangle[2][2]];
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) <= 1e-12) return false;
  const u = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const v = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const w = 1 - u - v;
  return u >= -1e-7 && v >= -1e-7 && w >= -1e-7;
}

function cross2d(a: Point2, b: Point2): number {
  return a[0] * b[1] - a[1] * b[0];
}
