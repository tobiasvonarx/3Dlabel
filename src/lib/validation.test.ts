import { describe, expect, it } from 'vitest';
import type { AnnotationSet } from '../types';
import { annotationsToTriangleMesh } from './mesh';
import { validateAnnotations } from './validation';

describe('surface validation', () => {
  it('accepts a non-planar polygon and exports deterministic triangles', () => {
    const annotations: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [1, 0.2, 1] },
        { id: 'd', position: [0, 0, 1] }
      ],
      edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']],
      faces: [['a', 'b', 'c', 'd']]
    };

    const validation = validateAnnotations(annotations);

    expect(validation.errorCount).toBe(0);
    expect(validation.issues.some((issue) => issue.message.includes('not planar'))).toBe(false);
    expect(annotationsToTriangleMesh(annotations).faces).toHaveLength(2);
  });

  it('allows an open surface and reports its boundary as a warning', () => {
    const openTriangle: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [0, 0, 1] }
      ],
      edges: [['a', 'b'], ['b', 'c'], ['c', 'a']],
      faces: [['a', 'b', 'c']]
    };

    const validation = validateAnnotations(openTriangle);

    expect(validation.errorCount).toBe(0);
    expect(validation.warningCount).toBeGreaterThan(0);
    expect(validation.topology.boundaryEdges).toHaveLength(3);
  });

  it('allows an edge shared by several explicit faces', () => {
    const annotations: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [0, 0, 1] },
        { id: 'd', position: [0, 1, 0] },
        { id: 'e', position: [0, -1, 0] }
      ],
      edges: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd'], ['d', 'b'], ['a', 'e'], ['e', 'b']],
      faces: [['a', 'b', 'c'], ['b', 'a', 'd'], ['a', 'b', 'e']]
    };

    const validation = validateAnnotations(annotations);
    expect(validation.errorCount).toBe(0);
    expect(validation.issues.some((issue) => issue.message.includes('more than two faces'))).toBe(false);
  });

  it('offers an explicit repair for a genuine near-vertex pair', () => {
    const annotations: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [0.01, 0, 0] }
      ],
      edges: [],
      faces: []
    };

    const issue = validateAnnotations(annotations).issues.find((candidate) => candidate.repair === 'merge-vertices');
    expect(issue?.target?.vertexIds).toEqual(['a', 'b']);
    expect(issue?.message).toContain('1.0 cm apart');
  });

  it('does not hide a legacy 2 cm near-vertex pair', () => {
    const annotations: AnnotationSet = {
      vertices: [
        { id: 'host', position: [0, 0.02, 0] },
        { id: 'lower', position: [0, 0, 0] },
        { id: 'x', position: [1, 0, 0] },
        { id: 'z', position: [0, 0, 1] }
      ],
      edges: [['lower', 'x'], ['x', 'z'], ['z', 'lower']],
      faces: [['lower', 'x', 'z']]
    };

    const issues = validateAnnotations(annotations).issues;
    expect(issues.some((issue) => issue.repair === 'merge-vertices' && issue.target?.vertexIds.includes('host'))).toBe(true);
  });
});
