import { describe, expect, it } from 'vitest';
import type { AnnotationSet } from '../types';
import { mergeCoincidentVertices, normalizeAnnotations, splitEdgeAtVertex } from './topology';

describe('wireframe topology', () => {
  it('welds annotation-noise vertices and removes the collapsed sliver by construction', () => {
    const normalized = normalizeAnnotations({
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'artifact', position: [0.001, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [0, 0, 1] }
      ],
      edges: [['a', 'artifact'], ['artifact', 'b'], ['b', 'c'], ['c', 'a']],
      faces: [['a', 'artifact', 'b', 'c'], ['a', 'artifact', 'c']]
    });

    expect(normalized.vertices.map((vertex) => vertex.id)).toEqual(['a', 'b', 'c']);
    expect(normalized.edges).toEqual([['a', 'b'], ['b', 'c'], ['c', 'a']]);
    expect(normalized.faces).toEqual([['a', 'b', 'c']]);
  });

  it('does not weld distinct corners outside the construction tolerance', () => {
    const normalized = normalizeAnnotations({
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [0.031, 0, 0] }
      ],
      edges: [['a', 'b']],
      faces: []
    });

    expect(normalized.vertices.map((vertex) => vertex.id)).toEqual(['a', 'b']);
    expect(normalized.edges).toEqual([['a', 'b']]);
  });

  it('canonicalizes coincident vertices without inventing face edges', () => {
    const source: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [0, 0, 1] },
        { id: 'copy', position: [0, 0, 0] }
      ],
      edges: [],
      faces: [['a', 'b', 'c']]
    };

    const normalized = normalizeAnnotations(source);

    expect(normalized.vertices.map((vertex) => vertex.id)).toEqual(['a', 'b', 'c']);
    expect(normalized.edges).toEqual([]);
  });

  it('keeps an explicitly preferred ID when a drag merges vertices', () => {
    const source: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'copy', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [0, 0, 1] }
      ],
      edges: [['copy', 'b'], ['b', 'c'], ['c', 'copy']],
      faces: [['copy', 'b', 'c']]
    };

    const result = mergeCoincidentVertices(source, (id) => id === 'a');

    expect(result.mergedCount).toBe(1);
    expect(result.annotations.vertices.map((vertex) => vertex.id)).toEqual(['a', 'b', 'c']);
    expect(result.annotations.faces).toEqual([['a', 'b', 'c']]);
  });

  it('deduplicates geometric edges after canonicalizing their endpoints', () => {
    const normalized = normalizeAnnotations({
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'a-copy', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'b-copy', position: [1, 0, 0] }
      ],
      edges: [['a', 'b'], ['a-copy', 'b-copy']],
      faces: []
    });

    expect(normalized.vertices.map((vertex) => vertex.id)).toEqual(['a', 'b']);
    expect(normalized.edges).toEqual([['a', 'b']]);
  });

  it('propagates an edge split through every incident face', () => {
    const source: AnnotationSet = normalizeAnnotations({
      vertices: [
        { id: 'a', position: [0, 0, 0] },
        { id: 'b', position: [1, 0, 0] },
        { id: 'c', position: [0, 0, 1] },
        { id: 'd', position: [1, 0, 1] },
        { id: 'x', position: [0.5, 0, 0] }
      ],
      edges: [['a', 'b']],
      faces: [['a', 'b', 'c'], ['b', 'a', 'd']]
    });

    const split = splitEdgeAtVertex(source, ['a', 'b'], 'x');

    expect(split.faces).toEqual([['a', 'x', 'b', 'c'], ['b', 'x', 'a', 'd']]);
    expect(split.edges).toContainEqual(['a', 'x']);
    expect(split.edges).toContainEqual(['x', 'b']);
  });

  it('preserves invalid topology for validation instead of silently repairing it', () => {
    const normalized = normalizeAnnotations({
      vertices: [
        { id: 'a', position: [0, 0, 0] }
      ],
      edges: [['a', 'b']],
      faces: [['a', 'b', 'c']]
    });

    expect(normalized.edges).toEqual([['a', 'b']]);
    expect(normalized.faces).toEqual([['a', 'b', 'c']]);
  });
});
