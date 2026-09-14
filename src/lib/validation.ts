import type { AnnotationEdge, AnnotationSet } from '../types';
import type { Point3 } from './geometry';
import {
  analyzeFaceGeometry,
  annotationsToTriangleMesh,
  triangulateFaceIndices
} from './mesh';
import { edgeKey, VERTEX_WELD_DISTANCE_M } from './topology';

export type ValidationSeverity = 'error' | 'warning';
export interface ValidationIssue {
  severity: ValidationSeverity;
  message: string;
  target?: ValidationTarget;
  repair?: 'merge-vertices';
}

export interface ValidationTarget {
  vertexIds: string[];
  edges?: AnnotationEdge[];
  faceIndices?: number[];
}

export interface ValidationTopology {
  boundaryEdges: AnnotationEdge[];
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  topology: ValidationTopology;
}

/** Validate the editable annotation graph and the explicit-face export mesh. */
export function validateAnnotations(annotations: AnnotationSet): ValidationResult {
  const issues: ValidationIssue[] = [];
  const verticesById = new Map(annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
  const attachedVertexIds = new Set<string>();
  const faceUsesByEdge = new Map<string, { edge: AnnotationEdge; faces: number[] }>();
  let facesAreGeometricallyValid = true;

  if (!annotations.vertices.length) add(issues, 'warning', 'The wireframe is empty.');
  if (annotations.vertices.length && !annotations.edges.length && !annotations.faces.length) {
    add(issues, 'warning', 'No wireframe edges or mesh faces annotated.');
  } else if (!annotations.faces.length) {
    add(issues, 'warning', 'Wireframe has no mesh faces. It can be saved, but mesh.ply will not be exported yet.');
  }

  const nearVertexPairs: [string, string, number][] = [];
  for (let left = 0; left < annotations.vertices.length; left += 1) {
    for (let right = left + 1; right < annotations.vertices.length; right += 1) {
      const a = annotations.vertices[left];
      const b = annotations.vertices[right];
      const distance = pointDistance(a.position, b.position);
      if (distance <= VERTEX_WELD_DISTANCE_M) nearVertexPairs.push([a.id, b.id, distance]);
    }
  }
  for (const [a, b, distance] of nearVertexPairs) {
    add(
      issues,
      'warning',
      `Vertices ${a} and ${b} are ${formatDistance(distance)} apart. Merge them only if they represent the same corner.`,
      { vertexIds: [a, b] },
      'merge-vertices'
    );
  }

  const explicitEdges = new Set<string>();
  for (const edge of annotations.edges) {
    if (edge[0] === edge[1]) {
      add(issues, 'error', `Edge ${edge[0]} -> ${edge[1]} has zero length.`, targetForEdges([edge]));
      continue;
    }
    if (!verticesById.has(edge[0]) || !verticesById.has(edge[1])) {
      add(
        issues,
        'error',
        `Edge ${edge[0]} -> ${edge[1]} references a missing vertex.`,
        { vertexIds: edge.filter((id) => verticesById.has(id)), edges: [edge] }
      );
      continue;
    }
    attachedVertexIds.add(edge[0]);
    attachedVertexIds.add(edge[1]);
    const key = edgeKey(edge);
    if (explicitEdges.has(key)) add(issues, 'warning', `Edge ${edge[0]} -> ${edge[1]} is duplicated.`, targetForEdges([edge]));
    explicitEdges.add(key);
  }

  annotations.faces.forEach((face, index) => {
    const label = `Face ${index + 1}`;
    const faceTarget: ValidationTarget = {
      vertexIds: face.filter((id) => verticesById.has(id)),
      faceIndices: [index]
    };
    if (face.length < 3) {
      add(issues, 'error', `${label} has fewer than three vertices.`, faceTarget);
      facesAreGeometricallyValid = false;
      return;
    }
    const unique = new Set(face);
    if (unique.size !== face.length) {
      add(issues, 'error', `${label} repeats a vertex.`, faceTarget);
      facesAreGeometricallyValid = false;
    }
    const missingIds = face.filter((id) => !verticesById.has(id));
    for (const id of missingIds) add(issues, 'error', `${label} references missing vertex ${id}.`, faceTarget);
    if (missingIds.length) facesAreGeometricallyValid = false;

    for (let vertexIndex = 0; vertexIndex < face.length; vertexIndex += 1) {
      const a = face[vertexIndex];
      const b = face[(vertexIndex + 1) % face.length];
      if (a === b || !verticesById.has(a) || !verticesById.has(b)) continue;
      attachedVertexIds.add(a);
      attachedVertexIds.add(b);
      const key = edgeKey([a, b]);
      const use = faceUsesByEdge.get(key) ?? { edge: [a, b], faces: [] };
      use.faces.push(index);
      faceUsesByEdge.set(key, use);
      if (!explicitEdges.has(key)) {
        add(
          issues,
          'error',
          `${label} boundary ${a} -> ${b} is missing from the wireframe.`,
          { ...faceTarget, edges: [[a, b]] }
        );
      }
    }

    if (missingIds.length || unique.size !== face.length) return;
    const positions = face.map((id) => verticesById.get(id)!) as Point3[];
    const geometry = analyzeFaceGeometry(positions);
    if (!geometry) {
      add(issues, 'error', `${label} is degenerate or has near-zero area.`, faceTarget);
      facesAreGeometricallyValid = false;
      return;
    }
    if (geometry.selfIntersects) {
      add(issues, 'error', `${label} crosses itself. Recreate it as a simple boundary loop.`, faceTarget);
      facesAreGeometricallyValid = false;
    }
    try {
      triangulateFaceIndices(positions);
    } catch (error) {
      add(issues, 'error', `${label} cannot be triangulated: ${error instanceof Error ? error.message : String(error)}`, faceTarget);
      facesAreGeometricallyValid = false;
    }
  });

  const boundaryEdges: AnnotationEdge[] = [];
  for (const use of faceUsesByEdge.values()) {
    if (use.faces.length === 1) boundaryEdges.push(use.edge);
  }
  if (annotations.faces.length && boundaryEdges.length) {
    add(
      issues,
      'warning',
      `Mesh has ${boundaryEdges.length} open boundary edge${boundaryEdges.length === 1 ? '' : 's'} (yellow). This is valid; add adjacent faces only if the surface should be closed.`,
      targetForEdges(boundaryEdges)
    );
  }
  const looseVertices = annotations.vertices.filter((vertex) => !attachedVertexIds.has(vertex.id));
  if (looseVertices.length) {
    add(
      issues,
      'warning',
      looseVertices.length === 1
        ? `Vertex ${looseVertices[0].id} has no attached edges. Connect it or delete it before exporting.`
        : `${looseVertices.length} vertices have no attached edges: ${looseVertices.slice(0, 6).map((vertex) => vertex.id).join(', ')}${looseVertices.length > 6 ? ', ...' : ''}. Connect or delete them before exporting.`,
      { vertexIds: looseVertices.map((vertex) => vertex.id) }
    );
  }

  if (facesAreGeometricallyValid && annotations.faces.length) {
    try {
      annotationsToTriangleMesh(annotations);
    } catch (error) {
      add(
        issues,
        'error',
        `Faces cannot be oriented consistently: ${error instanceof Error ? error.message : String(error)}`,
        { vertexIds: annotations.vertices.map((vertex) => vertex.id), faceIndices: annotations.faces.map((_, index) => index) }
      );
    }
  }

  return {
    issues,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    topology: { boundaryEdges }
  };
}

function add(
  issues: ValidationIssue[],
  severity: ValidationSeverity,
  message: string,
  target?: ValidationTarget,
  repair?: ValidationIssue['repair']
): void {
  issues.push({ severity, message, target, repair });
}

function targetForEdges(edges: AnnotationEdge[]): ValidationTarget {
  return { vertexIds: unique(edges.flat()), edges };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pointDistance(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function formatDistance(distance: number): string {
  return distance < 0.01 ? `${(distance * 1000).toFixed(1)} mm` : `${(distance * 100).toFixed(1)} cm`;
}
