import { describe, expect, it } from 'vitest';
import { annotationsFromJson, annotationsToJson } from './exporters';
import { validateAnnotations } from './validation';

const vertices = [
  { id: 'a', local: [0, 0, 0] },
  { id: 'b', local: [1, 0, 0] },
  { id: 'c', local: [0, 0, 1] }
];

describe('annotation schema migration', () => {
  it('writes the plain v3 vertices/edges/faces schema', () => {
    const json = JSON.parse(annotationsToJson(null, {
      vertices: vertices.map((vertex) => ({ id: vertex.id, position: vertex.local as [number, number, number] })),
      edges: [['a', 'b'], ['b', 'c'], ['c', 'a']],
      faces: [['a', 'b', 'c']]
    }, {
      orthoOpacity: 0.7,
      pointSize: 0.25,
      showTerrain: true,
      colorPointsByHeight: true,
      showPoints: true,
      pointColorMode: 'orthophoto'
    }));

    expect(json.schema).toBe('roof-labeler.annotations.v3');
    expect(json.settings.colorPointsByHeight).toBe(true);
    expect(json.attachment_edges).toBeUndefined();
  });

  it('materializes face boundaries once when loading a v1 annotation', () => {
    const loaded = annotationsFromJson(JSON.stringify({
      schema: 'roof-labeler.annotations.v1',
      vertices,
      edges: [],
      faces: [['a', 'b', 'c']]
    }));

    expect(loaded.edges).toHaveLength(3);
    expect(validateAnnotations(loaded).issues.some((issue) => issue.message.includes('missing from the wireframe'))).toBe(false);
  });

  it('does not silently repair a malformed v2 wireframe', () => {
    const loaded = annotationsFromJson(JSON.stringify({
      schema: 'roof-labeler.annotations.v2',
      vertices,
      edges: [],
      faces: [['a', 'b', 'c']],
      attachment_edges: []
    }));

    expect(loaded.edges).toEqual([]);
    expect(validateAnnotations(loaded).issues.some((issue) => issue.message.includes('missing from the wireframe'))).toBe(true);
  });

  it('retains references to missing vertices so validation can identify them', () => {
    const loaded = annotationsFromJson(JSON.stringify({
      schema: 'roof-labeler.annotations.v2',
      vertices,
      edges: [['a', 'missing']],
      faces: [['a', 'b', 'missing']],
      attachment_edges: []
    }));

    expect(loaded.edges).toContainEqual(['a', 'missing']);
    expect(loaded.faces).toEqual([['a', 'b', 'missing']]);
    expect(validateAnnotations(loaded).issues.some((issue) => issue.message.includes('missing vertex missing'))).toBe(true);
  });
});
