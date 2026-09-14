import { ShapeUtils, Vector2 } from 'three';
import type { AnnotationSet } from '../types';
import type { Point2, Point3 } from './geometry';
import { cross, subtract, vectorLength } from './geometry';

const GEOMETRY_EPS = 1e-8;

export type Triangle = [number, number, number];

export interface TriangleMesh {
  vertices: Point3[];
  faces: Triangle[];
}

export interface FaceGeometry {
  normal: Point3;
  projected: Point2[];
  selfIntersects: boolean;
}

interface EdgeUse {
  faceIndex: number;
  direction: 1 | -1;
}

/** Build exactly the explicitly annotated faces. No clipping, welding, or hole repair. */
export function annotationsToTriangleMesh(annotations: AnnotationSet): TriangleMesh {
  const positionsById = new Map(annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
  const orientedFaces = orientFaceLoops(annotations.faces);
  const vertices: Point3[] = [];
  const indexById = new Map<string, number>();
  const trianglesByFace: Triangle[][] = [];

  const vertexIndex = (id: string): number => {
    const existing = indexById.get(id);
    if (existing !== undefined) return existing;
    const position = positionsById.get(id);
    if (!position) throw new Error(`Face references missing vertex ${id}.`);
    const index = vertices.length;
    indexById.set(id, index);
    vertices.push(position);
    return index;
  };

  for (const face of orientedFaces) {
    const points = face.map((id) => positionsById.get(id));
    if (points.some((point) => !point)) throw new Error('A face references a missing vertex.');
    const localTriangles = triangulateFaceIndices(points as Point3[]);
    const meshIndices = face.map(vertexIndex);
    trianglesByFace.push(
      localTriangles.map(([a, b, c]) => [meshIndices[a], meshIndices[b], meshIndices[c]])
    );
  }

  orientClosedComponentsOutward(vertices, orientedFaces, trianglesByFace);
  return { vertices, faces: trianglesByFace.flat() };
}

/** Triangulate a simple 3D loop in its own best-fit orientation. */
export function triangulateFaceIndices(points: Point3[]): Triangle[] {
  if (points.length < 3) throw new Error('A face needs at least three vertices.');
  const geometry = analyzeFaceGeometry(points);
  if (!geometry) throw new Error('Face is degenerate.');
  const triangles = ShapeUtils.triangulateShape(
    geometry.projected.map(([x, y]) => new Vector2(x, y)),
    []
  ) as Triangle[];
  if (!triangles.length) throw new Error('Face could not be triangulated.');
  return triangles.map((triangle) => {
    const [a, b, c] = triangle;
    const triangleNormal = cross(subtract(points[b], points[a]), subtract(points[c], points[a]));
    return dot(triangleNormal, geometry.normal) < 0 ? [a, c, b] : [a, b, c];
  });
}

export function analyzeFaceGeometry(points: Point3[]): FaceGeometry | null {
  if (points.length < 3) return null;
  const normal = newellNormal(points);
  if (!normal) return null;
  const center = averagePoint(points);
  const projected = projectToFacePlane(points, center, normal);
  return {
    normal,
    projected,
    selfIntersects: polygonSelfIntersects(projected)
  };
}

function orientFaceLoops(faces: string[][]): string[][] {
  const usesByEdge = faceEdgeUses(faces);
  const neighbors = new Map<number, { faceIndex: number; flipRelative: boolean }[]>();
  for (const uses of usesByEdge.values()) {
    if (uses.length !== 2) continue;
    const [left, right] = uses;
    const flipRelative = left.direction === right.direction;
    neighbors.set(left.faceIndex, [...(neighbors.get(left.faceIndex) ?? []), { faceIndex: right.faceIndex, flipRelative }]);
    neighbors.set(right.faceIndex, [...(neighbors.get(right.faceIndex) ?? []), { faceIndex: left.faceIndex, flipRelative }]);
  }

  const flips = new Map<number, boolean>();
  for (let start = 0; start < faces.length; start += 1) {
    if (flips.has(start)) continue;
    flips.set(start, false);
    const pending = [start];
    while (pending.length) {
      const current = pending.pop()!;
      const currentFlip = flips.get(current)!;
      for (const neighbor of neighbors.get(current) ?? []) {
        const requiredFlip = currentFlip !== neighbor.flipRelative;
        const existing = flips.get(neighbor.faceIndex);
        if (existing !== undefined && existing !== requiredFlip) {
          throw new Error('Face winding is inconsistent around a cycle.');
        }
        if (existing === undefined) {
          flips.set(neighbor.faceIndex, requiredFlip);
          pending.push(neighbor.faceIndex);
        }
      }
    }
  }
  return faces.map((face, index) => (flips.get(index) ? [...face].reverse() : [...face]));
}

function orientClosedComponentsOutward(
  vertices: Point3[],
  faces: string[][],
  trianglesByFace: Triangle[][]
): void {
  const usesByEdge = faceEdgeUses(faces);
  const neighbors = new Map<number, number[]>();
  for (const uses of usesByEdge.values()) {
    if (uses.length !== 2) continue;
    neighbors.set(uses[0].faceIndex, [...(neighbors.get(uses[0].faceIndex) ?? []), uses[1].faceIndex]);
    neighbors.set(uses[1].faceIndex, [...(neighbors.get(uses[1].faceIndex) ?? []), uses[0].faceIndex]);
  }

  const seen = new Set<number>();
  for (let start = 0; start < faces.length; start += 1) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    const componentFaces = new Set(component);
    const isClosed = [...usesByEdge.values()].every(
      (uses) => !uses.some((use) => componentFaces.has(use.faceIndex)) || uses.length === 2
    );
    if (!isClosed) continue;
    const volume = component.reduce(
      (sum, faceIndex) =>
        sum +
        trianglesByFace[faceIndex].reduce(
          (faceSum, [a, b, c]) => faceSum + dot(vertices[a], cross(vertices[b], vertices[c])) / 6,
          0
        ),
      0
    );
    if (volume < 0) {
      for (const faceIndex of component) {
        trianglesByFace[faceIndex] = trianglesByFace[faceIndex].map(([a, b, c]) => [a, c, b]);
      }
    }
  }
}

function faceEdgeUses(faces: string[][]): Map<string, EdgeUse[]> {
  const uses = new Map<string, EdgeUse[]>();
  for (const [faceIndex, face] of faces.entries()) {
    for (let index = 0; index < face.length; index += 1) {
      const a = face[index];
      const b = face[(index + 1) % face.length];
      const key = edgeKey(a, b);
      uses.set(key, [...(uses.get(key) ?? []), { faceIndex, direction: a < b ? 1 : -1 }]);
    }
  }
  return uses;
}

function projectToFacePlane(points: Point3[], center: Point3, normal: Point3): Point2[] {
  const reference: Point3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const rawU = cross(reference, normal);
  const length = vectorLength(rawU);
  const u: Point3 = [rawU[0] / length, rawU[1] / length, rawU[2] / length];
  const v = cross(normal, u);
  return points.map((point) => {
    const relative = subtract(point, center);
    return [dot(relative, u), dot(relative, v)];
  });
}

function newellNormal(points: Point3[]): Point3 | null {
  const normal: Point3 = [0, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const length = vectorLength(normal);
  return length <= GEOMETRY_EPS ? null : [normal[0] / length, normal[1] / length, normal[2] / length];
}

function polygonSelfIntersects(points: Point2[]): boolean {
  for (let left = 0; left < points.length; left += 1) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsProperlyIntersect(points[left], points[leftNext], points[right], points[rightNext])) return true;
    }
  }
  return false;
}

function segmentsProperlyIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const abC = orient2d(a, b, c);
  const abD = orient2d(a, b, d);
  const cdA = orient2d(c, d, a);
  const cdB = orient2d(c, d, b);
  return abC * abD < -GEOMETRY_EPS && cdA * cdB < -GEOMETRY_EPS;
}

function orient2d(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function averagePoint(points: Point3[]): Point3 {
  const total = points.reduce<Point3>((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0]);
  return [total[0] / points.length, total[1] / points.length, total[2] / points.length];
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
