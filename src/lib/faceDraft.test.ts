import { describe, expect, it } from 'vitest';
import { appendFaceDraftVertex, completeFaceDraft } from './faceDraft';

describe('face draft', () => {
  it('accepts existing or newly created vertices in click order', () => {
    expect(appendFaceDraftVertex([], 'a')).toEqual({ kind: 'continue', draft: ['a'] });
    expect(appendFaceDraftVertex(['a'], 'b')).toEqual({ kind: 'continue', draft: ['a', 'b'] });
    expect(appendFaceDraftVertex(['a', 'b'], 'c')).toEqual({ kind: 'continue', draft: ['a', 'b', 'c'] });
  });

  it('rejects repeated vertices without changing the draft', () => {
    expect(appendFaceDraftVertex(['a', 'b', 'c'], 'b').kind).toBe('invalid');
  });

  it('closes only after at least three vertices', () => {
    expect(appendFaceDraftVertex(['a', 'b', 'c'], 'a')).toEqual({
      kind: 'complete',
      face: ['a', 'b', 'c']
    });
    expect(completeFaceDraft(['a', 'b']).kind).toBe('invalid');
    expect(completeFaceDraft(['a', 'b', 'x'])).toEqual({ kind: 'complete', face: ['a', 'b', 'x'] });
  });
});
