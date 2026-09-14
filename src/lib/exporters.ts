import type { AnnotationSet, SceneModel, ViewSettings } from '../types';
import { annotationsToTriangleMesh } from './mesh';
import { normalizeAnnotations } from './topology';
import { validateAnnotations } from './validation';

export function annotationsToJson(model: SceneModel | null, annotations: AnnotationSet, settings: ViewSettings): string {
  const payload = {
    schema: 'roof-labeler.annotations.v3',
    meshPolicy: 'wireframe-surfaces-v4',
    model: model
      ? {
          label: model.label,
          source: model.source,
          crs: model.metadata?.crs,
          extent: model.extent,
          center: model.center,
          verticalOffset: model.verticalOffset,
          pointCount: model.pointCount
        }
      : null,
    settings,
    vertices: annotations.vertices.map((vertex) => ({
      id: vertex.id,
      local: vertex.position,
      world: model ? localToWorld(model, vertex.position) : null
    })),
    edges: annotations.edges,
    faces: annotations.faces
  };
  return JSON.stringify(payload, null, 2);
}

export function annotationsFromJson(text: string, model?: SceneModel | null): AnnotationSet {
  const payload = JSON.parse(text) as unknown;
  if (!payload || typeof payload !== 'object') throw new Error('Annotation JSON must be an object.');
  const source = payload as {
    schema?: unknown;
    vertices?: unknown;
    edges?: unknown;
    faces?: unknown;
  };

  const vertices = Array.isArray(source.vertices)
    ? source.vertices
        .map((item, index) => {
          if (!item || typeof item !== 'object') return null;
          const vertex = item as { id?: unknown; local?: unknown; position?: unknown; world?: unknown };
          const world = parsePosition(vertex.world);
          const position = model && world ? worldToLocal(model, world) : parsePosition(vertex.local ?? vertex.position);
          if (!position) return null;
          return { id: typeof vertex.id === 'string' && vertex.id ? vertex.id : `v${index + 1}`, position };
        })
        .filter((vertex): vertex is { id: string; position: [number, number, number] } => Boolean(vertex))
    : [];
  const edges = Array.isArray(source.edges)
    ? source.edges.filter((edge): edge is [string, string] => isIdPair(edge))
    : [];
  const faces = Array.isArray(source.faces)
    ? source.faces
        .map((face) => (Array.isArray(face) ? face.filter((id): id is string => typeof id === 'string') : []))
        .filter((face) => face.length >= 3)
    : [];
  const migratedEdges = source.schema === 'roof-labeler.annotations.v2' || source.schema === 'roof-labeler.annotations.v3'
    ? edges
    : dedupeEdges([...edges, ...faceBoundaryEdges(faces)]);

  // Loading is the one-time v1 migration boundary: old vertex-loop faces are
  // retained and their boundary edges are materialized. V2 data is never
  // repaired implicitly; validation reports a missing wireframe boundary.
  return normalizeAnnotations({
    vertices,
    edges: migratedEdges,
    faces
  });
}

export function annotationsToReferenceMeshPly(model: SceneModel | null, annotations: AnnotationSet): string | null {
  if (!annotations.vertices.length || !annotations.faces.length) return null;
  const validation = validateAnnotations(annotations);
  const firstError = validation.issues.find((issue) => issue.severity === 'error');
  if (firstError) throw new Error(firstError.message);
  const mesh = annotationsToTriangleMesh(annotations);
  if (!mesh.faces.length) return null;

  const lines: string[] = [
    'ply',
    'format ascii 1.0',
    'comment roof-labeler explicit-face triangle mesh',
    `element vertex ${mesh.vertices.length}`,
    'property double x',
    'property double y',
    'property double z',
    `element face ${mesh.faces.length}`,
    'property list uchar int vertex_indices',
    'end_header'
  ];
  mesh.vertices.forEach((vertex) => {
    const world = model ? localToWorld(model, vertex) : vertex;
    lines.push(`${format(world[0])} ${format(world[1])} ${format(world[2])}`);
  });
  for (const face of mesh.faces) lines.push(`3 ${face.join(' ')}`);
  return `${lines.join('\n')}\n`;
}

function localToWorld(model: SceneModel, local: [number, number, number]): [number, number, number] {
  return [model.center.x + local[0], model.center.y - local[2], (model.verticalOffset ?? 0) + local[1]];
}

function worldToLocal(model: SceneModel, world: [number, number, number]): [number, number, number] {
  return [world[0] - model.center.x, world[2] - (model.verticalOffset ?? 0), -(world[1] - model.center.y)];
}

function parsePosition(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const position = value.slice(0, 3).map(Number);
  return position.every(Number.isFinite) ? (position as [number, number, number]) : null;
}

function isIdPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}

function faceBoundaryEdges(faces: string[][]): [string, string][] {
  return faces.flatMap((face) =>
    face.map((id, index) => [id, face[(index + 1) % face.length]] as [string, string])
  );
}

function dedupeEdges(edges: [string, string][]): [string, string][] {
  const seen = new Set<string>();
  return edges.filter(([a, b]) => {
    if (a === b) return false;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function format(value: number): string {
  return Number.isFinite(value) ? Number(value).toFixed(4) : '0.0000';
}
