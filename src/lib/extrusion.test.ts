import { describe, expect, it } from 'vitest';
import type { AnnotationEdge, AnnotationSet, AnnotationVertex } from '../types';
import { extrudeComponentDown } from './extrusion';
import { validateAnnotations } from './validation';

function edgeLoop(ids: string[]): AnnotationEdge[] {
  return ids.map((id, index) => [id, ids[(index + 1) % ids.length]]);
}

function hasEdge(edges: AnnotationEdge[], a: string, b: string): boolean {
  return edges.some((edge) => (edge[0] === a && edge[1] === b) || (edge[0] === b && edge[1] === a));
}

function planarFixture(): AnnotationSet {
  const roof = ['r0', 'r1', 'r2', 'r3'];
  const top = ['t0', 't1', 't2', 't3'];
  return {
    vertices: [
      { id: 'r0', position: [-2, 0, -2] },
      { id: 'r1', position: [2, 0, -2] },
      { id: 'r2', position: [2, 0, 2] },
      { id: 'r3', position: [-2, 0, 2] },
      { id: 't0', position: [-0.5, 1, -0.5] },
      { id: 't1', position: [0.5, 1, -0.5] },
      { id: 't2', position: [0.5, 1, 0.5] },
      { id: 't3', position: [-0.5, 1, 0.5] }
    ],
    edges: [...edgeLoop(roof), ...edgeLoop(top)],
    faces: [roof, top]
  };
}

function f66Fixture(): AnnotationSet {
  const vertices: AnnotationVertex[] = [
    { id: 'a', position: [1.3810533523, 7.8810725676, -1.5331300355] },
    { id: 'b', position: [5.6277767611, 4.9054493971, 5.433192953] },
    { id: 'c', position: [7.5300002098, 7.9600000381, 2.3399999142] },
    { id: 'd', position: [2.1074865749, 5.6426147789, 3.2143746752] },
    { id: 't0', position: [4.5714189767, 7.2179707362, 1.8110619409] },
    { id: 't1', position: [3.9226456371, 7.2079360212, 1.3799729921] },
    { id: 't2', position: [3.3366795972, 6.5518632805, 2.2649706978] },
    { id: 't3', position: [3.9827055488, 6.5374253572, 2.688632558] }
  ];
  const left = ['a', 'b', 'c'];
  const right = ['b', 'a', 'd'];
  const top = ['t0', 't1', 't2', 't3'];
  const supportEdges = [...edgeLoop(left), ...edgeLoop(right)];
  return {
    vertices,
    edges: [...supportEdges, ...edgeLoop(top)],
    faces: [left, right, top]
  };
}

function twoLevelFixture(): AnnotationSet {
  const left = ['l0', 'l1', 'l2', 'l3'];
  const right = ['r0', 'r1', 'r2', 'r3'];
  const top = ['t0', 't1', 't2', 't3'];
  return {
    vertices: [
      { id: 'l0', position: [-2, 0, -2] },
      { id: 'l1', position: [0, 0, -2] },
      { id: 'l2', position: [0, 0, 2] },
      { id: 'l3', position: [-2, 0, 2] },
      { id: 'r0', position: [0, -1, -2] },
      { id: 'r1', position: [2, -1, -2] },
      { id: 'r2', position: [2, -1, 2] },
      { id: 'r3', position: [0, -1, 2] },
      { id: 't0', position: [-1, 1, -0.5] },
      { id: 't1', position: [1, 1, -0.5] },
      { id: 't2', position: [1, 1, 0.5] },
      { id: 't3', position: [-1, 1, 0.5] }
    ],
    edges: [...edgeLoop(left), ...edgeLoop(right), ...edgeLoop(top)],
    faces: [left, right, top]
  };
}

function overlappingSlopesFixture(): AnnotationSet {
  const rising = ['a0', 'a1', 'a2', 'a3'];
  const falling = ['b0', 'b1', 'b2', 'b3'];
  const top = ['t0', 't1', 't2', 't3'];
  return {
    vertices: [
      { id: 'a0', position: [-2, -0.5, -2] },
      { id: 'a1', position: [2, 0.5, -2] },
      { id: 'a2', position: [2, 0.5, 2] },
      { id: 'a3', position: [-2, -0.5, 2] },
      { id: 'b0', position: [-2, 0.5, -2] },
      { id: 'b1', position: [2, -0.5, -2] },
      { id: 'b2', position: [2, -0.5, 2] },
      { id: 'b3', position: [-2, 0.5, 2] },
      { id: 't0', position: [-1, 2, -0.5] },
      { id: 't1', position: [1, 2, -0.5] },
      { id: 't2', position: [1, 2, 0.5] },
      { id: 't3', position: [-1, 2, 0.5] }
    ],
    edges: [...edgeLoop(rising), ...edgeLoop(falling), ...edgeLoop(top)],
    faces: [rising, falling, top]
  };
}

function gableRoofFixture(support = false): AnnotationSet {
  const left = ['a', 'b', 'e', 'f'];
  const right = ['b', 'c', 'd', 'e'];
  const roofVertices: AnnotationVertex[] = [
    { id: 'a', position: [-2, 2, -1] },
    { id: 'b', position: [0, 3, -1] },
    { id: 'c', position: [2, 2, -1] },
    { id: 'd', position: [2, 2, 1] },
    { id: 'e', position: [0, 3, 1] },
    { id: 'f', position: [-2, 2, 1] }
  ];
  if (!support) {
    return {
      vertices: roofVertices,
      edges: [...edgeLoop(left), ...edgeLoop(right)],
      faces: [left, right]
    };
  }

  const base = ['p0', 'p1', 'p2', 'p3'];
  return {
    vertices: [
      { id: 'p0', position: [-3, 0, -2] },
      { id: 'p1', position: [3, 0, -2] },
      { id: 'p2', position: [3, 0, 2] },
      { id: 'p3', position: [-3, 0, 2] },
      ...roofVertices
    ],
    edges: [...edgeLoop(base), ...edgeLoop(left), ...edgeLoop(right)],
    faces: [base, left, right]
  };
}

function roofWithHoleFixture(): AnnotationSet {
  const faces = [
    ['a', 'b', 'f', 'e'],
    ['b', 'c', 'g', 'f'],
    ['c', 'd', 'h', 'g'],
    ['d', 'a', 'e', 'h']
  ];
  return {
    vertices: [
      { id: 'a', position: [-2, 1, -2] },
      { id: 'b', position: [2, 1, -2] },
      { id: 'c', position: [2, 1, 2] },
      { id: 'd', position: [-2, 1, 2] },
      { id: 'e', position: [-1, 1, -1] },
      { id: 'f', position: [1, 1, -1] },
      { id: 'g', position: [1, 1, 1] },
      { id: 'h', position: [-1, 1, 1] }
    ],
    edges: faces.flatMap(edgeLoop),
    faces
  };
}

function foldedBoundaryFixture(withSupport = false): AnnotationSet {
  const left = ['a', 'b', 'x', 'p'];
  const right = ['b', 'c', 'd', 'x'];
  const roofVertices: AnnotationVertex[] = [
    { id: 'a', position: [0, 3, 0] },
    { id: 'b', position: [1, 4, 0] },
    { id: 'c', position: [0, 2, 0] },
    { id: 'd', position: [0, 2, 2] },
    { id: 'x', position: [1, 3, 2] },
    { id: 'p', position: [-1, 3, 1] }
  ];
  if (!withSupport) {
    return {
      vertices: roofVertices,
      edges: [...edgeLoop(left), ...edgeLoop(right)],
      faces: [left, right]
    };
  }
  const support = ['s0', 's1', 's2'];
  return {
    vertices: [
      { id: 's0', position: [-1, 1, 1] },
      { id: 's1', position: [0, 1, 0] },
      { id: 's2', position: [-1, 1, -1] },
      ...roofVertices
    ],
    edges: [...edgeLoop(support), ...edgeLoop(left), ...edgeLoop(right)],
    faces: [support, left, right]
  };
}

describe('annotation-mesh extrusion', () => {
  it('welds a noisy component corner before it can become an extrusion sliver', () => {
    const top = ['t0', 't1', 'artifact', 't2', 't3'];
    const source: AnnotationSet = {
      vertices: [
        { id: 't0', position: [-1, 1, -1] },
        { id: 't1', position: [1, 1, -1] },
        { id: 'artifact', position: [1, 1.001, -1] },
        { id: 't2', position: [1, 1, 1] },
        { id: 't3', position: [-1, 1, 1] }
      ],
      edges: edgeLoop(top),
      faces: [top]
    };

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.annotations.vertices.some((vertex) => vertex.id === 'artifact')).toBe(false);
    const positions = new Map(result.annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
    expect(result.annotations.edges.every(([a, b]) => {
      const left = positions.get(a)!;
      const right = positions.get(b)!;
      return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]) >= 0.03;
    })).toBe(true);
    expect(result.annotations.faces).toHaveLength(6);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount).toBe(0);
    expect(validation.warningCount).toBe(0);
  });

  it('stops at a support plane already touching part of the component', () => {
    const support = ['s0', 's1', 's2', 's3'];
    const top = ['t0', 't1', 't2', 't3'];
    const source: AnnotationSet = {
      vertices: [
        { id: 's0', position: [-2, 0, -2] },
        { id: 's1', position: [2, 0, -2] },
        { id: 's2', position: [2, 0, 2] },
        { id: 's3', position: [-2, 0, 2] },
        { id: 't0', position: [-1, 0, -1] },
        { id: 't1', position: [1, 0, -1] },
        { id: 't2', position: [1, 1, 1] },
        { id: 't3', position: [-1, 1, 1] }
      ],
      edges: [...edgeLoop(support), ...edgeLoop(top)],
      faces: [support, top]
    };

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ supportFaces: 1, groundSegments: 0, newVertices: 2 });
    expect(result.annotations.vertices.some((vertex) => vertex.position[1] === -3)).toBe(false);
    expect(result.annotations.vertices.filter((vertex) => vertex.position[1] === 0)).toHaveLength(8);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount, validation.issues.map((issue) => issue.message).join('\n')).toBe(0);
  });

  it('does not project an interior roof apex into the floor', () => {
    const faces = [
      ['a', 'apex', 'b'],
      ['b', 'apex', 'c'],
      ['c', 'apex', 'd'],
      ['d', 'apex', 'a']
    ];
    const source: AnnotationSet = {
      vertices: [
        { id: 'a', position: [-2, 2, -2] },
        { id: 'b', position: [2, 2, -2] },
        { id: 'c', position: [2, 2, 2] },
        { id: 'd', position: [-2, 2, 2] },
        { id: 'apex', position: [0, 4, 0] }
      ],
      edges: faces.flatMap(edgeLoop),
      faces
    };

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      componentFaces: 4,
      sideFaces: 4,
      floorFaces: 1,
      newVertices: 4,
      newFaces: 5
    });
    expect(result.annotations.vertices.some((vertex) =>
      vertex.position[0] === 0 && vertex.position[1] === -2 && vertex.position[2] === 0
    )).toBe(false);
    expect(result.annotations.faces.at(-1)).toHaveLength(4);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount).toBe(0);
    expect(validation.warningCount).toBe(0);
  });

  it('creates a closed shell on a planar annotated roof', () => {
    const source = planarFixture();
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ supportFaces: 1, boundarySplits: 0, newVertices: 4, newFaces: 5, floorFaces: 1 });
    expect(result.annotations.vertices.slice(-4).every((vertex) => vertex.position[1] === 0)).toBe(true);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount).toBe(0);
    expect(validation.topology.boundaryEdges).toHaveLength(4);
  });

  it('reuses support vertices when the extrusion lands on existing corners', () => {
    const source = planarFixture();
    source.vertices = source.vertices.map((vertex) => {
      const topIndex = ['r0', 'r1', 'r2', 'r3'].indexOf(vertex.id);
      return topIndex < 0
        ? vertex
        : { ...vertex, position: source.vertices.find((candidate) => candidate.id === `t${topIndex}`)!.position.map((value, axis) => axis === 1 ? 0 : value) as [number, number, number] };
    });

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats.newVertices).toBe(0);
    expect(result.annotations.vertices).toHaveLength(source.vertices.length);
    for (const id of ['r0', 'r1', 'r2', 'r3']) {
      expect(result.annotations.faces.some((face) => face.includes(id) && face.some((vertexId) => vertexId.startsWith('t')))).toBe(true);
    }
  });

  it('follows both triangles under F66 instead of treating their diagonal as a roof boundary', () => {
    const result = extrudeComponentDown({ annotations: f66Fixture(), selectedFaceIndex: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ supportFaces: 2, boundarySplits: 2, newVertices: 8, newFaces: 7, floorFaces: 1 });
    expect(result.annotations.faces[2]).toHaveLength(6);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount).toBe(0);
  });

  it('extrudes to ground and closes the floor when no annotated support exists', () => {
    const source = planarFixture();
    source.faces = [source.faces[1]];
    source.edges = edgeLoop(source.faces[0]);
    source.vertices = source.vertices.filter((vertex) => source.faces[0].includes(vertex.id));

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ target: 'ground', supportFaces: 0, boundarySplits: 0, newVertices: 4, newFaces: 5, floorFaces: 1 });
    expect(result.annotations.vertices.slice(-4).every((vertex) => vertex.position[1] === -3)).toBe(true);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount).toBe(0);
    expect(validation.warningCount).toBe(0);
    expect(validation.topology.boundaryEdges).toEqual([]);
  });

  it('still reports a missing support when no ground fallback is supplied', () => {
    const source = planarFixture();
    source.faces = [source.faces[1]];
    source.edges = edgeLoop(source.faces[0]);

    expect(extrudeComponentDown({ annotations: source, selectedFaceIndex: 0 })).toEqual({
      ok: false,
      error: 'Component boundary 1, edge 1: no mesh surface or scene ground lies below the complete boundary.'
    });
  });

  it('extends support-to-ground crossings down the real vertical transition', () => {
    const source = planarFixture();
    source.vertices = source.vertices.map((vertex) =>
      vertex.id === 'r1' || vertex.id === 'r2'
        ? { ...vertex, position: [0, vertex.position[1], vertex.position[2]] }
        : vertex
    );

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats.supportFaces).toBe(1);
    expect(result.stats.groundSegments).toBeGreaterThan(0);
    expect(result.stats.floorFaces).toBe(1);
    expect(result.annotations.vertices.some((vertex) => vertex.position[1] === -3)).toBe(true);
    expect(result.annotations.vertices.some((vertex) => vertex.position[1] === 0)).toBe(true);
    const generated = result.annotations.vertices.slice(source.vertices.length);
    expect(generated.filter((vertex) => vertex.position[1] === -3)).toHaveLength(4);
    for (const z of [-0.5, 0.5]) {
      const station = generated
        .filter((vertex) => Math.abs(vertex.position[0]) < 1e-6 && vertex.position[2] === z)
        .sort((left, right) => right.position[1] - left.position[1]);
      expect(station.map((vertex) => vertex.position[1])).toEqual([1, 0, -3]);
      expect(hasEdge(result.annotations.edges, station[0].id, station[1].id)).toBe(true);
      expect(hasEdge(result.annotations.edges, station[1].id, station[2].id)).toBe(true);
      expect(hasEdge(result.annotations.edges, station[0].id, station[2].id)).toBe(false);
    }
    const floor = result.annotations.faces.at(-1)!;
    const floorIds = new Set(floor);
    const insideFloorEdges = result.annotations.edges.filter(
      ([a, b]) => floorIds.has(a) && floorIds.has(b) && !hasEdge(edgeLoop(floor), a, b)
    );
    expect(insideFloorEdges).toEqual([]);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount, validation.issues.map((issue) => issue.message).join('\n')).toBe(0);
  });

  it('keeps both real heights at a discontinuous support transition', () => {
    const source = twoLevelFixture();

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 2, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ target: 'surface', supportFaces: 2, groundSegments: 0, boundarySplits: 2, newFaces: 7, floorFaces: 1 });
    const generated = result.annotations.vertices.slice(source.vertices.length);
    const stepHeights = generated
      .filter((vertex) => Math.abs(vertex.position[0]) < 1e-6 && Math.abs(vertex.position[2]) === 0.5)
      .map((vertex) => vertex.position[1])
      .sort((left, right) => right - left);
    expect(stepHeights).toEqual([1, 1, 0, 0, -1, -1]);
    for (const z of [-0.5, 0.5]) {
      const top = generated.find((vertex) => Math.abs(vertex.position[0]) < 1e-6 && vertex.position[1] === 1 && vertex.position[2] === z);
      const high = generated.find((vertex) => Math.abs(vertex.position[0]) < 1e-6 && vertex.position[1] === 0 && vertex.position[2] === z);
      const low = generated.find((vertex) => Math.abs(vertex.position[0]) < 1e-6 && vertex.position[1] === -1 && vertex.position[2] === z);
      expect(top && high && low).toBeTruthy();
      expect(hasEdge(result.annotations.edges, top!.id, high!.id)).toBe(true);
      expect(hasEdge(result.annotations.edges, high!.id, low!.id)).toBe(true);
      expect(hasEdge(result.annotations.edges, top!.id, low!.id)).toBe(false);
    }
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('splits where overlapping support planes exchange which one is highest', () => {
    const source = overlappingSlopesFixture();

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 2, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ supportFaces: 2, groundSegments: 0, boundarySplits: 2, newFaces: 7, floorFaces: 1 });
    const splitVertices = result.annotations.vertices
      .slice(source.vertices.length)
      .filter((vertex) => Math.abs(vertex.position[0]) < 1e-6 && Math.abs(vertex.position[1] - 2) < 1e-6);
    expect(splitVertices).toHaveLength(2);
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('extrudes a connected multi-face roof as one component without ridge walls', () => {
    const source = gableRoofFixture();
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      target: 'ground',
      componentFaces: 2,
      boundaryLoops: 1,
      sideFaces: 6,
      floorFaces: 1,
      newVertices: 6,
      newFaces: 7
    });
    expect(result.annotations.faces.filter((face) => face.includes('b') && face.includes('e'))).toHaveLength(2);
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('recomputes an existing extrusion after a new surface face is added', () => {
    const roof = gableRoofFixture();
    const first = extrudeComponentDown({ annotations: roof, selectedFaceIndex: 0, groundY: -3 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const oldBottomIds = first.annotations.vertices.slice(roof.vertices.length).map((vertex) => vertex.id);
    const extension = ['c', 'g', 'h', 'd'];
    const edited: AnnotationSet = {
      vertices: [
        ...first.annotations.vertices,
        { id: 'g', position: [3, 2, -1] },
        { id: 'h', position: [3, 2, 1] }
      ],
      edges: [...first.annotations.edges, ...edgeLoop(extension)],
      faces: [...first.annotations.faces, extension]
    };

    const result = extrudeComponentDown({
      annotations: edited,
      selectedFaceIndex: edited.faces.length - 1,
      groundY: -3
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      target: 'ground',
      componentFaces: 3,
      sideFaces: 8,
      floorFaces: 1,
      replacedFaces: first.stats.newFaces
    });
    expect(result.annotations.vertices.some((vertex) => oldBottomIds.includes(vertex.id))).toBe(false);
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('does not delete a lower roof connected through the old wall', () => {
    const mainRoof = ['m0', 'm1', 'm2'];
    const detailRoof = ['d0', 'd1', 'd2', 'd3'];
    const oldWall = ['d0', 'd1', 'm1', 'm0'];
    const extension = ['d1', 'e0', 'e1', 'd2'];
    const source: AnnotationSet = {
      vertices: [
        { id: 'm0', position: [0, 2, 0] },
        { id: 'm1', position: [1, 2, 0] },
        { id: 'm2', position: [0, 2, -1] },
        { id: 'd0', position: [0, 4, 0] },
        { id: 'd1', position: [1, 4, 0] },
        { id: 'd2', position: [1, 4, 1] },
        { id: 'd3', position: [0, 4, 1] },
        { id: 'e0', position: [2, 4, 0] },
        { id: 'e1', position: [2, 4, 1] }
      ],
      edges: [mainRoof, detailRoof, oldWall, extension].flatMap(edgeLoop),
      faces: [mainRoof, detailRoof, oldWall, extension]
    };

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 3, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({ componentFaces: 2, replacedFaces: 1 });
    expect(result.annotations.faces).toContainEqual(mainRoof);
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('keeps a separate lower face available as support for a multi-face component', () => {
    const source = gableRoofFixture(true);
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      target: 'surface',
      componentFaces: 2,
      boundaryLoops: 1,
      supportFaces: 1,
      sideFaces: 6,
      floorFaces: 1
    });
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('propagates support-boundary splits into the incident faces of a component', () => {
    const source = gableRoofFixture(true);
    source.vertices = source.vertices.map((vertex) =>
      vertex.id === 'p1' || vertex.id === 'p2'
        ? { ...vertex, position: [-1, vertex.position[1], vertex.position[2]] }
        : vertex
    );
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      componentFaces: 2,
      supportFaces: 1,
      boundarySplits: 2,
      sideFaces: 8
    });
    expect(result.annotations.faces[1]).toHaveLength(6);
    expect(result.annotations.faces[2]).toHaveLength(4);
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('splits one multi-face component down across separate support objects', () => {
    const roof = gableRoofFixture();
    const leftSupport = ['l0', 'l1', 'l2', 'l3'];
    const rightSupport = ['r0', 'r1', 'r2', 'r3'];
    const source: AnnotationSet = {
      vertices: [
        { id: 'l0', position: [-3, 0, -2] },
        { id: 'l1', position: [0, 0, -2] },
        { id: 'l2', position: [0, 0, 2] },
        { id: 'l3', position: [-3, 0, 2] },
        { id: 'r0', position: [0, -1, -2] },
        { id: 'r1', position: [3, -1, -2] },
        { id: 'r2', position: [3, -1, 2] },
        { id: 'r3', position: [0, -1, 2] },
        ...roof.vertices
      ],
      edges: [...edgeLoop(leftSupport), ...edgeLoop(rightSupport), ...roof.edges],
      faces: [leftSupport, rightSupport, ...roof.faces]
    };
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 2, groundY: -3 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      componentFaces: 2,
      supportFaces: 2,
      groundSegments: 0,
      sideFaces: 6,
      floorFaces: 1
    });
    const generated = result.annotations.vertices.slice(source.vertices.length);
    for (const id of ['b', 'e']) {
      const top = source.vertices.find((vertex) => vertex.id === id)!;
      const atStation = generated.filter(
        (vertex) => vertex.position[0] === top.position[0] && vertex.position[2] === top.position[2]
      );
      expect(atStation.map((vertex) => vertex.position[1]).sort((left, right) => right - left)).toEqual([0, -1]);
    }
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('mirrors component topology at ground so holes remain holes', () => {
    const source = roofWithHoleFixture();
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      target: 'ground',
      componentFaces: 4,
      boundaryLoops: 2,
      sideFaces: 8,
      floorFaces: 4,
      newVertices: 8,
      newFaces: 12
    });
    expect(validateAnnotations(result.annotations).errorCount).toBe(0);
  });

  it('collapses a folded projected boundary and closes it instead of extruding overlapping walls', () => {
    const source = foldedBoundaryFixture();
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      target: 'ground',
      componentFaces: 2,
      boundaryLoops: 1,
      sideFaces: 4,
      floorFaces: 2,
      closureFaces: 1,
      newVertices: 5,
      newFaces: 7
    });
    expect(result.annotations.faces).toContainEqual(['a', 'b', 'c']);
    const generatedWalls = result.annotations.faces.slice(source.faces.length + 1, source.faces.length + 1 + result.stats.sideFaces);
    expect(generatedWalls.some((face) => face[0] === 'a' && face[1] === 'b')).toBe(false);
    expect(generatedWalls.some((face) => face[0] === 'b' && face[1] === 'c')).toBe(false);
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount, validation.issues.map((issue) => issue.message).join('\n')).toBe(0);
  });

  it('keeps a folded corner conforming across support and ground heights', () => {
    const source = foldedBoundaryFixture(true);
    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 1, groundY: -2 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stats).toMatchObject({
      target: 'surface',
      componentFaces: 2,
      supportFaces: 1,
      closureFaces: 1,
      floorFaces: 2
    });
    const cornerVertices = result.annotations.vertices.filter(
      (vertex) => vertex.position[0] === 0 && vertex.position[2] === 0
    );
    expect(cornerVertices.map((vertex) => vertex.position[1])).toEqual(expect.arrayContaining([3, 2, 1, -2]));
    const validation = validateAnnotations(result.annotations);
    expect(validation.errorCount, validation.issues.map((issue) => issue.message).join('\n')).toBe(0);
  });

  it('rejects a closed component instead of extruding it again', () => {
    const faces = [
      ['a', 'b', 'c'],
      ['a', 'c', 'd'],
      ['a', 'd', 'b'],
      ['b', 'd', 'c']
    ];
    const source: AnnotationSet = {
      vertices: [
        { id: 'a', position: [0, 2, 0] },
        { id: 'b', position: [-1, 1, -1] },
        { id: 'c', position: [1, 1, -1] },
        { id: 'd', position: [0, 1, 1] }
      ],
      edges: faces.flatMap(edgeLoop),
      faces
    };

    expect(extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -2 })).toEqual({
      ok: false,
      error: 'The selected component is closed and has no boundary to extrude.'
    });
  });

  it('rejects a non-manifold selected component before generating geometry', () => {
    const faces = [
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
      ['a', 'b', 'e']
    ];
    const source: AnnotationSet = {
      vertices: [
        { id: 'a', position: [-1, 1, 0] },
        { id: 'b', position: [1, 1, 0] },
        { id: 'c', position: [0, 1, 1] },
        { id: 'd', position: [0, 1, -1] },
        { id: 'e', position: [0, 2, 2] }
      ],
      edges: faces.flatMap(edgeLoop),
      faces
    };

    const result = extrudeComponentDown({ annotations: source, selectedFaceIndex: 0, groundY: -2 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected non-manifold component rejection.');
    expect(result.error).toContain('selected component is non-manifold');
  });
});
