export type FaceDraftResult =
  | { kind: 'continue'; draft: string[] }
  | { kind: 'complete'; face: string[] }
  | { kind: 'invalid'; message: string };

export type FaceDraftCompletion = Exclude<FaceDraftResult, { kind: 'continue' }>;

/** Add one vertex to an in-progress face boundary. */
export function appendFaceDraftVertex(draft: string[], vertexId: string): FaceDraftResult {
  if (!draft.length) return { kind: 'continue', draft: [vertexId] };
  if (vertexId === draft[0]) return completeFaceDraft(draft);
  if (draft.includes(vertexId)) {
    return { kind: 'invalid', message: 'That vertex is already in this face. Click the green start vertex to close it.' };
  }
  return { kind: 'continue', draft: [...draft, vertexId] };
}

/** Close an in-progress face boundary. */
export function completeFaceDraft(draft: string[]): FaceDraftCompletion {
  if (draft.length < 3) {
    return { kind: 'invalid', message: 'A face needs at least three vertices.' };
  }
  return { kind: 'complete', face: [...draft] };
}
