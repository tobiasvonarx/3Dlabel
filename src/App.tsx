import {
  ArrowDown,
  BoxSelect,
  CircleDot,
  Eye,
  FolderOpen,
  Layers,
  RotateCcw,
  MousePointer2,
  Play,
  Redo2,
  Save,
  Square,
  Trash2,
  Triangle,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import OpenDialog from './components/OpenDialog';
import Modal from './components/Modal';
import SceneViewport from './components/SceneViewport';
import { loadSceneBundle, sourceFromLibrary, type LoadedSceneBundle, type SceneLibraryEntry } from './lib/sceneBundle';
import {
  annotationsFromJson,
  annotationsToJson,
  annotationsToReferenceMeshPly
} from './lib/exporters';
import { extrudeComponentDown } from './lib/extrusion';
import { appendFaceDraftVertex, completeFaceDraft } from './lib/faceDraft';
import { type Point3, cross, faceNormal, normalizeVector, subtract, vectorLength } from './lib/geometry';
import { sampleRasterValue } from './lib/raster';
import {
  closedPathEdges,
  compactLoop as compactFace,
  dedupeEdges,
  facesUsingEdge,
  findCoincidentVertexId,
  hasEdge as annotationHasEdge,
  mergeCoincidentVertices,
  normalizeAnnotations,
  sameUndirectedEdge as sameEdge,
  splitEdgeAtVertex
} from './lib/topology';
import { validateAnnotations, type ValidationIssue } from './lib/validation';
import type {
  AnnotationEdge,
  AnnotationSet,
  Mode,
  RasterImage,
  SceneModel,
  TerrainReference,
  ViewPreset,
  ViewSettings
} from './types';

const DEFAULT_SETTINGS: ViewSettings = {
  orthoOpacity: 0.72,
  pointSize: 0.28,
  showTerrain: true,
  colorPointsByHeight: true,
  showPoints: true,
  pointColorMode: 'orthophoto'
};

const EMPTY_ANNOTATIONS: AnnotationSet = {
  vertices: [],
  edges: [],
  faces: []
};

const INITIAL_SCENE_ID = new URLSearchParams(window.location.search).get('scene');
const MAX_UNDO_STEPS = 80;
const DEFAULT_SQUARE_SIZE = 1;
const DEFAULT_SQUARE_SETTINGS = { size: DEFAULT_SQUARE_SIZE, rotationDeg: 0 };

interface SquareEditGeometry {
  center: Point3;
  baseFrame: { u: Point3; v: Point3 };
  size: number;
  rotationDeg: number;
}

export default function App() {
  const [model, setModel] = useState<SceneModel | null>(null);
  const [mode, setMode] = useState<Mode>('select');
  const [settings, setSettings] = useState<ViewSettings>(DEFAULT_SETTINGS);
  const [annotations, setAnnotations] = useState<AnnotationSet>(EMPTY_ANNOTATIONS);
  const annotationsRef = useRef<AnnotationSet>(EMPTY_ANNOTATIONS);
  const [undoStack, setUndoStack] = useState<AnnotationSet[]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationSet[]>([]);
  const [savedAnnotationKey, setSavedAnnotationKey] = useState(() => annotationKey(EMPTY_ANNOTATIONS));
  const [faceDraft, setFaceDraft] = useState<string[]>([]);
  const faceDraftRef = useRef<string[]>([]);
  const faceDraftBaselineRef = useRef<AnnotationSet | null>(null);
  const [selectedVertexId, setSelectedVertexId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<AnnotationEdge | null>(null);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(null);
  const [viewPreset, setViewPreset] = useState<{ id: number; kind: ViewPreset } | null>(null);
  const [status, setStatus] = useState('Loading scenes...');
  const [busy, setBusy] = useState(true);
  const [sceneLibrary, setSceneLibrary] = useState<SceneLibraryEntry[]>([]);
  const [terrainRaster, setTerrainRaster] = useState<RasterImage | null>(null);
  const [terrainReference, setTerrainReference] = useState<TerrainReference | null>(null);
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [visibleClasses, setVisibleClasses] = useState<Record<string, boolean>>({});
  const [savingGt, setSavingGt] = useState(false);
  const [activeBundle, setActiveBundle] = useState<{ manifest: LoadedSceneBundle['manifest']; libraryId?: string } | null>(null);
  const [openDialogVisible, setOpenDialogVisible] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 860px)').matches);
  const [mobilePanel, setMobilePanel] = useState<'scene' | 'view' | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const update = () => { setIsMobile(media.matches); setMobilePanel(null); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [squareSettings, setSquareSettings] = useState(DEFAULT_SQUARE_SETTINGS);
  const dirtyRef = useRef(false);
  const savedAnnotationsRef = useRef<AnnotationSet>(EMPTY_ANNOTATIONS);

  const validation = useMemo(() => validateAnnotations(annotations), [annotations]);
  const hasUnsavedChanges = useMemo(() => annotationKey(annotations) !== savedAnnotationKey, [annotations, savedAnnotationKey]);
  const hasAnnotations = useMemo(
    () => annotations.vertices.length > 0 || annotations.edges.length > 0 || annotations.faces.length > 0,
    [annotations]
  );
  const pointClassIds = useMemo(
    () => Object.keys(model?.classCounts ?? {}).sort((a, b) => Number(a) - Number(b)),
    [model?.classCounts]
  );

  useEffect(() => {
    dirtyRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);

    async function initialize() {
      const scenes = await fetchSceneLibrary();
      if (cancelled) return;
      setSceneLibrary(scenes);
      const initial = INITIAL_SCENE_ID
        ? scenes.find((entry) => entry.id === INITIAL_SCENE_ID || entry.name === INITIAL_SCENE_ID)
        : undefined;
      if (initial) {
        const bundle = await loadSceneBundle(sourceFromLibrary(initial));
        if (cancelled) return;
        loadBundleIntoApp(bundle);
        return;
      }
      setStatus(scenes.length ? 'Pick a scene to start annotating.' : 'No scenes found — acquire houses from the map or open your point cloud.');
      setOpenDialogVisible(true);
    }

    initialize()
      .catch((error) => {
        if (cancelled) return;
        setStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    annotationsRef.current = annotations;
    setSelectedVertexId((current) => (current && annotations.vertices.some((vertex) => vertex.id === current) ? current : null));
    setSelectedEdge((current) => (current && annotationHasEdge(annotations, current) ? current : null));
    setSelectedFaceIndex((current) => (current !== null && annotations.faces[current] ? current : null));
  }, [annotations]);

  useEffect(() => {
    setVisibleClasses(Object.fromEntries(Object.keys(model?.classCounts ?? {}).map((key) => [key, true])));
  }, [model?.classCounts]);

  const activeLibraryIndex = useMemo(
    () => (activeBundle?.libraryId ? sceneLibrary.findIndex((entry) => entry.id === activeBundle.libraryId) : -1),
    [activeBundle?.libraryId, sceneLibrary]
  );
  const savedSceneCount = useMemo(() => sceneLibrary.filter((entry) => entry.hasAnnotations).length, [sceneLibrary]);
  const sceneGroups = useMemo(() => {
    const groups = new Map<string, SceneLibraryEntry[]>();
    for (const entry of sceneLibrary) {
      const list = groups.get(entry.collection) ?? [];
      list.push(entry);
      groups.set(entry.collection, list);
    }
    return [...groups.entries()];
  }, [sceneLibrary]);

  // Scenes without their own locked alignment inherit the median of locked
  // alignments in their collection (or globally), so new cases start aligned
  // and only need a nudge via Align mode.
  const effectiveEarthAlignment = useMemo(() => {
    if (!activeBundle) return null;
    const own = activeBundle.manifest.earth_alignment;
    if (own) return { ...own, source: 'scene' as const };
    const locked = sceneLibrary.filter((entry) => entry.earthAlignment);
    const peers = locked.filter((entry) => entry.collection === activeBundle.manifest.collection);
    const pool = peers.length >= 2 ? peers : locked.length >= 3 ? locked : [];
    if (!pool.length) return null;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
    return {
      de: median(pool.map((entry) => entry.earthAlignment!.de)),
      dn: median(pool.map((entry) => entry.earthAlignment!.dn)),
      dh: median(pool.map((entry) => entry.earthAlignment!.dh)),
      source: 'default' as const,
      basedOn: pool.length
    };
  }, [activeBundle, sceneLibrary]);
  const selectedObjectLabel =
    selectedVertexId ?? (selectedEdge ? `edge ${selectedEdge[0]} -> ${selectedEdge[1]}` : selectedFaceIndex !== null ? `face ${selectedFaceIndex + 1}` : 'none');
  const primaryValidationIssue = validation.issues.find((issue) => issue.severity === 'error') ?? validation.issues[0];
  const selectedSquare = useMemo(
    () => (selectedFaceIndex === null ? null : squareEditGeometry(annotations, selectedFaceIndex)),
    [annotations, selectedFaceIndex]
  );
  const squareControlSize = selectedSquare?.size ?? squareSettings.size;
  const squareControlRotationDeg = selectedSquare?.rotationDeg ?? squareSettings.rotationDeg;

  const replaceFaceDraft = useCallback((next: string[]) => {
    faceDraftRef.current = next;
    setFaceDraft(next);
  }, []);

  const clearFaceDraft = useCallback(() => {
    faceDraftBaselineRef.current = null;
    replaceFaceDraft([]);
  }, [replaceFaceDraft]);

  const rollbackFaceDraft = useCallback(() => {
    const baseline = faceDraftBaselineRef.current;
    faceDraftBaselineRef.current = null;
    replaceFaceDraft([]);
    if (!baseline) return;
    annotationsRef.current = baseline;
    setAnnotations(baseline);
  }, [replaceFaceDraft]);

  const changeMode = useCallback((next: Mode) => {
    rollbackFaceDraft();
    if (next === 'face') {
      setSelectedVertexId(null);
      setSelectedEdge(null);
      setSelectedFaceIndex(null);
    }
    setMode(next);
  }, [rollbackFaceDraft]);

  const confirmDiscardChanges = useCallback((action: string) => {
    return !dirtyRef.current || window.confirm(`You have unsaved annotation changes. ${action}?`);
  }, []);

  const replaceAnnotations = useCallback((next: AnnotationSet, options?: { markSaved?: boolean }) => {
    const normalized = normalizeAnnotations(next);
    annotationsRef.current = normalized;
    setAnnotations(normalized);
    setUndoStack([]);
    setRedoStack([]);
    if (options?.markSaved ?? true) {
      savedAnnotationsRef.current = normalized;
      setSavedAnnotationKey(annotationKey(normalized));
    }
    clearFaceDraft();
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
    setMode('select');
  }, [clearFaceDraft]);

  const refreshSceneLibrary = useCallback(async () => {
    try {
      setSceneLibrary(await fetchSceneLibrary());
    } catch {
      // Files-only static deployments do not have a scene library API.
    }
  }, []);

  const loadBundleIntoApp = useCallback(
    (bundle: LoadedSceneBundle) => {
      if (!confirmDiscardChanges('Discard them and open the new scene')) return;
      try {
        setModel(bundle.model);
        setTerrainRaster(bundle.terrainRaster);
        setTerrainReference(
          bundle.terrainExtent ? { terrain_tif: '', extent_lv95: bundle.terrainExtent, gsd_m: null } : null
        );
        setActiveBundle({ manifest: bundle.manifest, libraryId: bundle.libraryId });
        const restored = bundle.annotationJson ? annotationsFromJson(bundle.annotationJson, bundle.model) : EMPTY_ANNOTATIONS;
        replaceAnnotations(restored);
        setSquareSettings(DEFAULT_SQUARE_SETTINGS);
        setStatus(
          `Loaded ${bundle.manifest.name}: ${bundle.model.pointCount.toLocaleString()} points` +
            `${bundle.annotationJson ? ' + saved annotations' : ''} · ${bundle.manifest.crs ?? 'local coordinates'}`
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [confirmDiscardChanges, replaceAnnotations]
  );

  const loadLibraryScene = useCallback(
    async (entry: SceneLibraryEntry) => {
      setBusy(true);
      setStatus(`Loading ${entry.name}...`);
      try {
        const bundle = await loadSceneBundle(sourceFromLibrary(entry));
        loadBundleIntoApp(bundle);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [loadBundleIntoApp]
  );

  const loadAdjacentScene = useCallback(
    async (direction: -1 | 1) => {
      if (!sceneLibrary.length) return;
      const index = activeLibraryIndex >= 0 ? activeLibraryIndex : 0;
      const next = sceneLibrary[(index + direction + sceneLibrary.length) % sceneLibrary.length];
      if (next) await loadLibraryScene(next);
    },
    [activeLibraryIndex, loadLibraryScene, sceneLibrary]
  );

  const saveBundleAnnotations = useCallback(async (options?: { advanceToNext?: boolean }) => {
    if (!activeBundle || !model) {
      setStatus('Load a scene before saving annotations.');
      return;
    }
    if (faceDraftRef.current.length) {
      setStatus('Finish or cancel the current face before saving.');
      return;
    }
    setSavingGt(true);
    setStatus('Saving annotations...');
    try {
      const clean = normalizeAnnotations(annotationsRef.current);
      const savingEmptyScene = !clean.vertices.length && !clean.edges.length && !clean.faces.length;
      annotationsRef.current = clean;
      setAnnotations(clean);
      const annotationJson = annotationsToJson(model, clean, settings);
      const cleanValidation = validateAnnotations(clean);
      const validationIssue = savingEmptyScene ? undefined : cleanValidation.issues.find((issue) => issue.severity === 'error');
      let meshPly: string | null = null;
      const hasFaces = clean.faces.length > 0;
      let meshSkipReason = savingEmptyScene
        ? 'empty scene reset; mesh.ply cleared'
        : !hasFaces
          ? 'wireframe saved; add mesh faces before exporting mesh.ply'
          : validationIssue?.message ?? '';
      if (!savingEmptyScene && hasFaces && !cleanValidation.errorCount) {
        try {
          meshPly = annotationsToReferenceMeshPly(model, clean);
        } catch (error) {
          meshSkipReason = `mesh export failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (activeBundle.libraryId) {
        const response = await fetch('/api/scenes/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activeBundle.libraryId, annotationJson, meshPly })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `Save failed: ${response.status}`);
        savedAnnotationsRef.current = clean;
        setSavedAnnotationKey(annotationKey(clean));
        setStatus(
          meshPly
            ? `Saved annotations.json + mesh.ply to ${payload.sceneDir}`
            : `Saved annotations.json to ${payload.sceneDir}; ${meshSkipReason || 'mesh export returned no data.'}`
        );
        void refreshSceneLibrary();
        if (options?.advanceToNext && meshPly) {
          dirtyRef.current = false;
          await loadAdjacentScene(1);
        }
        return;
      }

      downloadTextFile(`${activeBundle.manifest.name}.annotations.json`, annotationJson);
      if (meshPly) downloadTextFile(`${activeBundle.manifest.name}.mesh.ply`, meshPly);
      savedAnnotationsRef.current = clean;
      setSavedAnnotationKey(annotationKey(clean));
      setStatus(meshPly ? 'Annotations + mesh downloaded (scene was opened from local files).' : `Annotations downloaded; ${meshSkipReason || 'mesh export returned no data.'}`);
    } catch (error) {
      setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingGt(false);
    }
  }, [activeBundle, annotations, loadAdjacentScene, model, refreshSceneLibrary, settings, validation]);

  const updateSetting = useCallback(<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const setAllPointClassesVisible = useCallback(
    (visible: boolean) => {
      setVisibleClasses(Object.fromEntries(pointClassIds.map((key) => [key, visible])));
    },
    [pointClassIds]
  );

  const commitAnnotationChange = useCallback((updater: (current: AnnotationSet) => AnnotationSet) => {
    const current = annotationsRef.current;
    const next = normalizeAnnotations(updater(current));
    if (next === current) return;
    annotationsRef.current = next;
    setUndoStack((history) => [...history.slice(-(MAX_UNDO_STEPS - 1)), current]);
    setRedoStack([]);
    setAnnotations(next);
  }, []);

  const updateFaceDraftAnnotations = useCallback((updater: (current: AnnotationSet) => AnnotationSet) => {
    const current = annotationsRef.current;
    if (!faceDraftBaselineRef.current) faceDraftBaselineRef.current = current;
    const next = normalizeAnnotations(updater(current));
    annotationsRef.current = next;
    setAnnotations(next);
  }, []);

  const commitFaceDraftAnnotations = useCallback((updater: (current: AnnotationSet) => AnnotationSet) => {
    const current = annotationsRef.current;
    const baseline = faceDraftBaselineRef.current ?? current;
    const next = normalizeAnnotations(updater(current));
    annotationsRef.current = next;
    faceDraftBaselineRef.current = null;
    replaceFaceDraft([]);
    setUndoStack((history) => [...history.slice(-(MAX_UNDO_STEPS - 1)), baseline]);
    setRedoStack([]);
    setAnnotations(next);
  }, [replaceFaceDraft]);

  const beginAnnotationEdit = useCallback(() => {
    setUndoStack((history) => [...history.slice(-(MAX_UNDO_STEPS - 1)), annotationsRef.current]);
    setRedoStack([]);
  }, []);

  const undoLastAction = useCallback(() => {
    if (faceDraftRef.current.length) {
      rollbackFaceDraft();
      setStatus('Cancelled the entire face draft.');
      return;
    }
    setUndoStack((history) => {
      const previous = history.at(-1);
      if (!previous) return history;
      setRedoStack((redo) => [...redo.slice(-(MAX_UNDO_STEPS - 1)), annotationsRef.current]);
      annotationsRef.current = previous;
      setAnnotations(previous);
      setSelectedEdge((current) => (current && annotationHasEdge(previous, current) ? current : null));
      setSelectedFaceIndex((current) => (current !== null && previous.faces[current] ? current : null));
      return history.slice(0, -1);
    });
  }, [rollbackFaceDraft]);

  const redoAnnotationChange = useCallback(() => {
    if (faceDraftRef.current.length) {
      setStatus('Cancel or finish the current face before redoing an annotation edit.');
      return;
    }
    setRedoStack((history) => {
      const next = history.at(-1);
      if (!next) return history;
      setUndoStack((undo) => [...undo.slice(-(MAX_UNDO_STEPS - 1)), annotationsRef.current]);
      annotationsRef.current = next;
      setAnnotations(next);
      setSelectedEdge((current) => (current && annotationHasEdge(next, current) ? current : null));
      setSelectedFaceIndex((current) => (current !== null && next.faces[current] ? current : null));
      return history.slice(0, -1);
    });
  }, []);

  const addAnnotationVertex = useCallback((position: [number, number, number], snap?: { edge?: [string, string] }) => {
    const id = findCoincidentVertexId(annotationsRef.current, position) ?? `v${crypto.randomUUID().slice(0, 8)}`;
    commitAnnotationChange((current) => {
      const withVertex = current.vertices.some((vertex) => vertex.id === id)
        ? current
        : { ...current, vertices: [...current.vertices, { id, position }] };
      return snap?.edge ? splitEdgeAtVertex(withVertex, snap.edge, id) : withVertex;
    });
    setSelectedVertexId(id);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
    return id;
  }, [commitAnnotationChange]);

  const moveAnnotationVertices = useCallback((positionsById: Record<string, [number, number, number]>) => {
    const ids = new Set(Object.keys(positionsById));
    if (!ids.size) return;
    const current = annotationsRef.current;
    const next = {
      ...current,
      vertices: current.vertices.map((vertex) => (ids.has(vertex.id) ? { ...vertex, position: positionsById[vertex.id] } : vertex))
    };
    annotationsRef.current = next;
    setAnnotations(next);
  }, []);

  const finishMoveAnnotationVertices = useCallback((movedIds: string[]) => {
    const moved = new Set(movedIds);
    const current = annotationsRef.current;
    const result = mergeCoincidentVertices(current, (id) => !moved.has(id));
    if (result.annotations !== current) {
      annotationsRef.current = result.annotations;
      setAnnotations(result.annotations);
      const vertexIds = new Set(result.annotations.vertices.map((vertex) => vertex.id));
      const remap = (id: string) => result.idById.get(id) ?? id;
      replaceFaceDraft(compactFace(faceDraftRef.current.map(remap)).filter((id) => vertexIds.has(id)));
      setSelectedVertexId((id) => {
        if (!id) return null;
        const next = remap(id);
        return vertexIds.has(next) ? next : null;
      });
      setSelectedEdge((edge) => {
        if (!edge) return null;
        const next: AnnotationEdge = [remap(edge[0]), remap(edge[1])];
        return next[0] !== next[1] && annotationHasEdge(result.annotations, next) ? next : null;
      });
      setSelectedFaceIndex((index) => (index !== null && result.annotations.faces[index] ? index : null));
    }
    return {
      mergedCount: result.mergedCount,
      canonicalIds: Object.fromEntries(movedIds.map((id) => [id, result.idById.get(id) ?? id]))
    };
  }, [replaceFaceDraft]);

  const selectAnnotationVertex = useCallback((id: string | null) => {
    setSelectedVertexId(id);
    if (id) {
      setSelectedEdge(null);
      setSelectedFaceIndex(null);
    }
  }, []);

  const selectAnnotationEdge = useCallback((edge: AnnotationEdge | null) => {
    setSelectedEdge(edge);
    if (edge) {
      setSelectedVertexId(null);
      setSelectedFaceIndex(null);
    }
  }, []);

  const selectAnnotationFace = useCallback((faceIndex: number | null) => {
    setSelectedFaceIndex(faceIndex);
    if (faceIndex !== null) {
      setSelectedVertexId(null);
      setSelectedEdge(null);
    }
  }, []);

  const deleteAnnotationVertex = useCallback((id: string) => {
    commitAnnotationChange((current) => ({
      vertices: current.vertices.filter((vertex) => vertex.id !== id),
      edges: current.edges.filter((edge) => edge[0] !== id && edge[1] !== id),
      faces: current.faces.map((face) => face.filter((vertexId) => vertexId !== id)).filter((face) => face.length >= 3)
    }));
    replaceFaceDraft(faceDraftRef.current.filter((vertexId) => vertexId !== id));
    setSelectedVertexId((current) => (current === id ? null : current));
    setSelectedEdge((current) => (current?.includes(id) ? null : current));
    setSelectedFaceIndex(null);
  }, [commitAnnotationChange, replaceFaceDraft]);

  const deleteAnnotationEdge = useCallback((edge: AnnotationEdge) => {
    commitAnnotationChange((current) => {
      const faceIndices = facesUsingEdge(current.faces, edge);
      return {
        ...current,
        edges: current.edges.filter((item) => !sameEdge(item, edge)),
        faces: current.faces.filter((_, index) => !faceIndices.has(index))
      };
    });
    setSelectedEdge((current) => (current && sameEdge(current, edge) ? null : current));
    setSelectedFaceIndex(null);
  }, [commitAnnotationChange]);

  const deleteAnnotationFace = useCallback((faceIndex: number) => {
    commitAnnotationChange((current) => {
      const faces = current.faces.filter((_, index) => index !== faceIndex);
      return { ...current, faces };
    });
    setSelectedFaceIndex(null);
  }, [commitAnnotationChange]);

  const deleteSelectedAnnotation = useCallback(() => {
    if (faceDraftRef.current.length) {
      setStatus('Finish or cancel the current face before deleting other geometry.');
      return;
    }
    if (selectedVertexId) {
      deleteAnnotationVertex(selectedVertexId);
      setStatus(`Deleted ${selectedVertexId}`);
      return;
    }
    if (selectedEdge) {
      deleteAnnotationEdge(selectedEdge);
      setStatus(`Deleted edge ${selectedEdge[0]} -> ${selectedEdge[1]}`);
      return;
    }
    if (selectedFaceIndex !== null) {
      deleteAnnotationFace(selectedFaceIndex);
      setStatus(`Deleted mesh face ${selectedFaceIndex + 1}`);
    }
  }, [deleteAnnotationEdge, deleteAnnotationFace, deleteAnnotationVertex, selectedEdge, selectedFaceIndex, selectedVertexId]);

  const addAnnotationEdge = useCallback((a: string, b: string) => {
    if (a === b) return;
    commitAnnotationChange((current) => {
      const exists = current.edges.some((edge) => (edge[0] === a && edge[1] === b) || (edge[0] === b && edge[1] === a));
      return exists ? current : { ...current, edges: [...current.edges, [a, b]] };
    });
    setSelectedVertexId(null);
    setSelectedFaceIndex(null);
    setSelectedEdge([a, b]);
    changeMode('select');
  }, [changeMode, commitAnnotationChange]);

  const closeFaceDraft = useCallback((face: string[]) => {
    const compact = compactFace(face);
    const duplicateIndex = findDuplicateFaceIndex(annotationsRef.current.faces, compact);
    if (duplicateIndex !== null) {
      rollbackFaceDraft();
      setSelectedVertexId(null);
      setSelectedEdge(null);
      setSelectedFaceIndex(duplicateIndex);
      setMode('select');
      setStatus(`Mesh face already exists as face ${duplicateIndex + 1}.`);
      return;
    }

    const nextFaceIndex = annotationsRef.current.faces.length;
    commitFaceDraftAnnotations((current) => ({
      ...current,
      edges: dedupeEdges([...current.edges, ...closedPathEdges(compact)]),
      faces: [...current.faces, compact]
    }));
    setMode('select');
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(nextFaceIndex);
    setStatus(`Added mesh face with ${compact.length} vertices and its wireframe edges.`);
  }, [commitFaceDraftAnnotations, rollbackFaceDraft]);

  const draftFaceVertex = useCallback((id: string) => {
    const currentDraft = faceDraftRef.current;
    const result = appendFaceDraftVertex(currentDraft, id);
    if (result.kind === 'invalid') {
      setStatus(result.message);
      return;
    }
    if (result.kind === 'complete') {
      closeFaceDraft(result.face);
      return;
    }

    if (!faceDraftBaselineRef.current) faceDraftBaselineRef.current = annotationsRef.current;
    const previous = currentDraft.at(-1);
    if (previous) {
      updateFaceDraftAnnotations((current) => ({
        ...current,
        edges: dedupeEdges([...current.edges, [previous, id]])
      }));
    }
    replaceFaceDraft(result.draft);
    setStatus(
      result.draft.length === 1
        ? `Face started at ${id}. Click an existing vertex or the roof to create the next one.`
        : `Face draft: ${result.draft.length} vertices and ${result.draft.length - 1} edges. Click the green start vertex to close.`
    );
  }, [closeFaceDraft, replaceFaceDraft, updateFaceDraftAnnotations]);

  const addFaceDraftVertex = useCallback((position: [number, number, number], snap?: { edge?: [string, string] }) => {
    const id = findCoincidentVertexId(annotationsRef.current, position) ?? `v${crypto.randomUUID().slice(0, 8)}`;
    updateFaceDraftAnnotations((current) => {
      const withVertex = current.vertices.some((vertex) => vertex.id === id)
        ? current
        : { ...current, vertices: [...current.vertices, { id, position }] };
      return snap?.edge ? splitEdgeAtVertex(withVertex, snap.edge, id) : withVertex;
    });
    draftFaceVertex(id);
  }, [draftFaceVertex, updateFaceDraftAnnotations]);

  const finishFace = useCallback(() => {
    const result = completeFaceDraft(faceDraftRef.current);
    if (result.kind === 'invalid') {
      setStatus(result.message);
      return;
    }
    closeFaceDraft(result.face);
  }, [closeFaceDraft]);

  const cancelFaceDraft = useCallback(() => {
    if (!faceDraftRef.current.length) return;
    rollbackFaceDraft();
    setStatus('Cancelled face draft and removed its unfinished vertices and edges.');
  }, [rollbackFaceDraft]);

  const placeSquareFace = useCallback((center: [number, number, number], frameFaceIndex?: number) => {
    const alignmentFaceIndex = frameFaceIndex ?? selectedFaceIndex;
    const baseFrame = squarePlacementFrame(annotationsRef.current, alignmentFaceIndex);
    const rotationDeg = squareSettings.rotationDeg;
    const frame = rotateFrame(baseFrame, (rotationDeg * Math.PI) / 180);
    const size = Math.max(0.001, squareSettings.size);
    const half = size / 2;
    const positions: [number, number, number][] = [
      offsetPoint(center, frame.u, -half, frame.v, -half),
      offsetPoint(center, frame.u, half, frame.v, -half),
      offsetPoint(center, frame.u, half, frame.v, half),
      offsetPoint(center, frame.u, -half, frame.v, half)
    ];
    const vertices: AnnotationSet['vertices'] = [];
    const ids = positions.map((position) => {
      const currentWithPending = { ...annotationsRef.current, vertices: [...annotationsRef.current.vertices, ...vertices] };
      const id = findCoincidentVertexId(currentWithPending, position) ?? `v${crypto.randomUUID().slice(0, 8)}`;
      if (!currentWithPending.vertices.some((vertex) => vertex.id === id)) vertices.push({ id, position });
      return id;
    });
    const nextFaceIndex = annotationsRef.current.faces.length;
    commitAnnotationChange((current) => ({
      ...current,
      vertices: [...current.vertices, ...vertices],
      edges: dedupeEdges([...current.edges, ...closedPathEdges(ids)]),
      faces: [...current.faces, ids]
    }));
    changeMode('select');
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(nextFaceIndex);
    setStatus(`Added ${size.toFixed(2)} m square mesh face (${rotationDeg.toFixed(0)} deg).`);
  }, [changeMode, commitAnnotationChange, selectedFaceIndex, squareSettings.rotationDeg, squareSettings.size]);

  const transformSelectedSquare = useCallback((size: number, rotationDeg: number) => {
    const nextSettings = { size: Math.max(0.001, size), rotationDeg };
    setSquareSettings(nextSettings);
    if (selectedFaceIndex === null) return;
    if (!squareEditGeometry(annotationsRef.current, selectedFaceIndex)) return;
    let transformed = false;
    commitAnnotationChange((current) => {
      const nextPositions = transformedSquarePositions(current, selectedFaceIndex, nextSettings.size, nextSettings.rotationDeg);
      if (!nextPositions) return current;
      transformed = true;
      return {
        ...current,
        vertices: current.vertices.map((vertex) => {
          const position = nextPositions.get(vertex.id);
          return position ? { ...vertex, position } : vertex;
        })
      };
    });
    if (!transformed) {
      setStatus('Select a four-vertex square mesh face to resize or rotate.');
      return;
    }
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(selectedFaceIndex);
    setStatus(`Updated square ${selectedFaceIndex + 1}: ${nextSettings.size.toFixed(2)} m, ${nextSettings.rotationDeg.toFixed(0)} deg.`);
  }, [commitAnnotationChange, selectedFaceIndex]);

  const extrudeSelectedComponentDown = useCallback(() => {
    if (faceDraftRef.current.length) {
      setStatus('Finish or cancel the current face before extruding.');
      return;
    }
    if (selectedFaceIndex === null) {
      setStatus('Select a mesh face before extruding.');
      return;
    }
    if (!model) {
      setStatus('Load a model before extruding.');
      return;
    }
    const source = normalizeAnnotations(annotationsRef.current);
    const face = source.faces[selectedFaceIndex];
    if (!face || face.length < 3) {
      setStatus('Selected mesh face is not valid.');
      return;
    }
    const result = extrudeComponentDown({
      annotations: source,
      selectedFaceIndex,
      groundY: sceneGroundY(model, source, terrainRaster, terrainReference?.extent_lv95 ?? null)
    });
    if (!result.ok) {
      setStatus(result.error);
      return;
    }

    commitAnnotationChange(() => result.annotations);
    changeMode('select');
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
    const recomputed = result.stats.replacedFaces
      ? `Recomputed the existing extrusion (${result.stats.replacedFaces} old wall/floor face${result.stats.replacedFaces === 1 ? '' : 's'} replaced). `
      : '';
    if (result.stats.target === 'ground') {
      const target = terrainRaster && terrainReference?.extent_lv95 ? 'DEM ground' : 'scene ground';
      setStatus(
        `${recomputed}Extruded ${result.stats.componentFaces} connected face${result.stats.componentFaces === 1 ? '' : 's'} to ${target}: ${result.stats.sideFaces} walls and ${result.stats.floorFaces} floor face${result.stats.floorFaces === 1 ? '' : 's'}.`
      );
    } else {
      const groundPart = result.stats.groundSegments
        ? `, with ${result.stats.groundSegments} segment${result.stats.groundSegments === 1 ? '' : 's'} continuing to ground`
        : '';
      setStatus(
        `${recomputed}Extruded ${result.stats.componentFaces} connected face${result.stats.componentFaces === 1 ? '' : 's'} onto ${result.stats.supportFaces} lower surface${result.stats.supportFaces === 1 ? '' : 's'}${groundPart}: ${result.stats.sideFaces} walls and ${result.stats.floorFaces} bottom face${result.stats.floorFaces === 1 ? '' : 's'}.`
      );
    }
  }, [changeMode, commitAnnotationChange, model, selectedFaceIndex, terrainRaster, terrainReference?.extent_lv95]);

  // Revert and Clear are ordinary undoable edits: they go through the same
  // history as any other change, so a mistaken click is always one Undo away.
  const revertToSaved = useCallback(() => {
    if (!hasUnsavedChanges) {
      setStatus('Annotations already match the last saved state.');
      return;
    }
    if (!window.confirm('Revert annotations to the last saved state? (Undo restores your edits.)')) return;
    rollbackFaceDraft();
    commitAnnotationChange(() => savedAnnotationsRef.current);
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
    setMode('select');
    setStatus(
      savedAnnotationsRef.current.vertices.length
        ? 'Reverted to the last saved annotations.'
        : 'Reverted: this scene has no saved annotations yet.'
    );
  }, [commitAnnotationChange, hasUnsavedChanges, rollbackFaceDraft]);

  const clearAnnotations = useCallback(() => {
    if (!hasAnnotations) {
      setStatus('No annotations to clear.');
      return;
    }
    if (!window.confirm('Clear all annotations in this scene? (Undo restores them; the saved file is untouched until you Save.)')) return;
    rollbackFaceDraft();
    commitAnnotationChange(() => EMPTY_ANNOTATIONS);
    setSelectedVertexId(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
    setMode('select');
    setStatus('Cleared all annotations (Undo to restore).');
  }, [commitAnnotationChange, hasAnnotations, rollbackFaceDraft]);

  const clearFaces = useCallback(() => {
    if (!annotationsRef.current.faces.length) {
      setStatus('No mesh faces to clear.');
      return;
    }
    if (!window.confirm('Clear every mesh face while keeping all vertices and edges? (Undo restores the faces; the saved file is untouched until you Save.)')) return;
    const count = annotationsRef.current.faces.length;
    rollbackFaceDraft();
    commitAnnotationChange((current) => ({ ...current, faces: [] }));
    setSelectedFaceIndex(null);
    setMode('select');
    setStatus(`Cleared ${count} mesh faces; all vertices and edges were kept (Undo to restore).`);
  }, [commitAnnotationChange, rollbackFaceDraft]);

  const saveEarthAlignment = useCallback(
    async (alignment: { de: number; dn: number; dh: number }) => {
      setActiveBundle((current) =>
        current ? { ...current, manifest: { ...current.manifest, earth_alignment: alignment } } : current
      );
      const libraryId = activeBundle?.libraryId;
      if (!libraryId) {
        setStatus(
          `Earth alignment ΔE ${alignment.de} m, ΔN ${alignment.dn} m, ΔH ${alignment.dh} m (not persisted — scene was opened from local files).`
        );
        return;
      }
      try {
        const response = await fetch('/api/scenes/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: libraryId, earthAlignment: alignment })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `Save failed: ${response.status}`);
        setStatus(`Earth alignment locked: ΔE ${alignment.de} m, ΔN ${alignment.dn} m, ΔH ${alignment.dh} m → ${payload.sceneDir}/scene.json`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [activeBundle?.libraryId]
  );

  const applyViewPreset = useCallback((kind: ViewPreset) => {
    setViewPreset({ id: Date.now(), kind });
  }, []);

  const selectValidationIssue = useCallback((issue: ValidationIssue) => {
    const target = issue.target;
    if (!target?.vertexIds.length) return;
    const vertexIds = target.vertexIds.filter((id) => annotationsRef.current.vertices.some((vertex) => vertex.id === id));
    if (!vertexIds.length) return;

    const faceIndex = target.faceIndices?.find((index) => Boolean(annotationsRef.current.faces[index]));
    const edge = target.edges?.find((candidate) => annotationHasEdge(annotationsRef.current, candidate));
    const vertexId = vertexIds[0];
    changeMode('select');
    setSelectedFaceIndex(faceIndex ?? null);
    setSelectedEdge(faceIndex === undefined ? edge ?? null : null);
    setSelectedVertexId(faceIndex === undefined && !edge ? vertexId : null);
    setStatus(issue.message);
  }, [changeMode]);

  const mergeValidationVertices = useCallback((issue: ValidationIssue) => {
    if (issue.repair !== 'merge-vertices') return;
    if (faceDraftRef.current.length) {
      setStatus('Finish or cancel the current face before merging another vertex pair.');
      return;
    }
    const [keepId, mergeId] = issue.target?.vertexIds ?? [];
    if (!keepId || !mergeId) return;
    const source = annotationsRef.current;
    const keep = source.vertices.find((vertex) => vertex.id === keepId);
    const merge = source.vertices.find((vertex) => vertex.id === mergeId);
    if (!keep || !merge) {
      setStatus('That vertex pair no longer exists.');
      return;
    }
    commitAnnotationChange((current) => {
      const coincident = {
        ...current,
        vertices: current.vertices.map((vertex) =>
          vertex.id === mergeId ? { ...vertex, position: keep.position } : vertex
        )
      };
      return mergeCoincidentVertices(coincident, (id) => id === keepId).annotations;
    });
    setSelectedVertexId(keepId);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
    setStatus(`Merged ${mergeId} into ${keepId} (Undo to restore).`);
  }, [commitAnnotationChange]);

  const saveCurrent = saveBundleAnnotations;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (openDialogVisible || showHelp || document.querySelector('dialog[open]')) return;
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if (command && key === 's') {
        event.preventDefault();
        void saveCurrent();
        return;
      }
      if (command && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoAnnotationChange();
        else undoLastAction();
        return;
      }
      if (event.key === 'Escape') {
        changeMode('select');
        setSelectedVertexId(null);
        setSelectedEdge(null);
        setSelectedFaceIndex(null);
        setStatus('Select mode');
        return;
      }
      if (event.key === 'Enter' && mode === 'face') {
        event.preventDefault();
        finishFace();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        deleteSelectedAnnotation();
        return;
      }
      if (event.key === '?') {
        setShowHelp((value) => !value);
        return;
      }
      if (key === 'v') changeMode('vertex');
      if (key === 'e') changeMode('edge');
      if (key === 'f') changeMode('face');
      if (key === 'q') changeMode('square');
      if (key === 's') changeMode('select');
      if (key === 'd') extrudeSelectedComponentDown();
      if (key === 'n') void saveCurrent({ advanceToNext: true });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [changeMode, deleteSelectedAnnotation, extrudeSelectedComponentDown, finishFace, mode, openDialogVisible, showHelp, redoAnnotationChange, saveCurrent, undoLastAction]);

  return (
    <div
      className="appShell"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDroppedFiles([...event.dataTransfer.files]);
        setOpenDialogVisible(true);
      }}
    >
      <aside className="sidebar">
        <header className="brand">
          <div className="brandMark">
            <Layers size={19} />
          </div>
          <div className="brandText">
            <h1>3Dlabel</h1>
            <p>{model ? `${model.pointCount.toLocaleString()} points · ${activeBundle?.manifest.crs ?? 'local'}` : 'Point-cloud annotation'}</p>
          </div>
          <button className="openButton" onClick={() => setOpenDialogVisible(true)} title="Open scene bundles or point clouds (also: drop files anywhere)">
            <FolderOpen size={15} />
            Open
          </button>
          <div className="mobileToolbar">
            <button onClick={() => setMobilePanel('scene')}>Scene</button>
            <button onClick={() => setMobilePanel('view')}>View</button>
            <button className="primaryButton" disabled={!activeBundle || savingGt} onClick={() => void saveBundleAnnotations()}>Save</button>
            <button onClick={() => setShowHelp(true)} aria-label="Keyboard shortcuts">Help</button>
          </div>
        </header>

        <Inspector title="Scene" mobile={isMobile} visible={mobilePanel === 'scene'} onClose={() => setMobilePanel(null)}>
          {activeBundle ? (
            <div className="caseFlow">
              {activeBundle.libraryId && sceneLibrary.length > 0 && (
                <>
                  <label className="caseSelect">
                    <span>Scene</span>
                    <select
                      value={activeBundle.libraryId}
                      onChange={(event) => {
                        const entry = sceneLibrary.find((item) => item.id === event.currentTarget.value);
                        if (entry) void loadLibraryScene(entry);
                      }}
                    >
                      {sceneGroups.map(([collection, entries]) => (
                        <optgroup key={collection} label={collection}>
                          {entries.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.hasAnnotations ? '✓ ' : '· '}
                              {sceneDisplayName(entry)}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <div className="caseActions">
                    <button className="secondaryButton" onClick={() => void loadAdjacentScene(-1)} title="Load the previous scene in the library">
                      Previous
                    </button>
                    <button className="secondaryButton" onClick={() => void loadAdjacentScene(1)} title="Load the next scene in the library">
                      Next
                    </button>
                  </div>
                  <div className="artifactStatus">
                    <span>{savedSceneCount}/{sceneLibrary.length} scenes annotated</span>
                  </div>
                </>
              )}
              <div className="referenceStatus">
                <span title={activeBundle.manifest.name}>
                  {sceneDisplayName({ name: activeBundle.manifest.name, collection: activeBundle.manifest.collection ?? '' })}
                </span>
                <strong className={hasUnsavedChanges ? 'dirty' : ''}>{hasUnsavedChanges ? 'Unsaved edits' : activeBundle.libraryId ? 'Saved' : 'No unsaved edits'}</strong>
              </div>
              <div className="artifactStatus">
                <span>
                  {activeBundle.manifest.crs ?? 'local coordinates'} ·{' '}
                  {activeBundle.libraryId ? 'library scene' : 'local files — saves download'}
                </span>
              </div>
              <div className="artifactStatus">
                <span>Terrain {terrainRaster ? 'loaded' : 'unavailable'}</span>
              </div>
              {hasAnnotations ? <div className={`validationStatus ${validation.errorCount ? 'error' : validation.warningCount ? 'warning' : 'ok'}`}>
                <strong>{validation.errorCount ? `${validation.errorCount} errors` : validation.warningCount ? `${validation.warningCount} warnings` : 'valid'}</strong>
                <span>{primaryValidationIssue?.message ?? 'Wireframe is saveable.'}</span>
                {primaryValidationIssue?.target && (
                  <button className="validationTakeMe" type="button" onClick={() => selectValidationIssue(primaryValidationIssue)}>
                    <Eye size={13} />
                    Select source
                  </button>
                )}
                {primaryValidationIssue?.repair === 'merge-vertices' && (
                  <button className="validationTakeMe validationRepair" type="button" onClick={() => mergeValidationVertices(primaryValidationIssue)}>
                    <CircleDot size={13} />
                    Merge pair
                  </button>
                )}
              </div> : <p className="emptyAnnotation">Start with Face or Vertex to draw your roof. Square adds a ready-made face.</p>}
              {validation.issues.length > 1 && (
                <details className="validationIssues">
                  <summary>All validation issues</summary>
                  <ul>
                    {validation.issues.map((issue, index) => (
                      <li className={issue.severity} key={`${issue.message}-${index}`}>
                        <span>{issue.message}</span>
                        {issue.target && (
                          <button className="validationTakeMe" type="button" onClick={() => selectValidationIssue(issue)}>
                            <Eye size={13} />
                            Select source
                          </button>
                        )}
                        {issue.repair === 'merge-vertices' && (
                          <button className="validationTakeMe validationRepair" type="button" onClick={() => mergeValidationVertices(issue)}>
                            <CircleDot size={13} />
                            Merge pair
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="actionGrid">
                <button
                  className="secondaryButton"
                  disabled={!hasUnsavedChanges}
                  onClick={revertToSaved}
                  title="Restore the last saved annotations for this scene (undoable)"
                >
                  <RotateCcw size={15} />
                  Revert
                </button>
                <button
                  className="secondaryButton"
                  disabled={!hasAnnotations}
                  onClick={clearAnnotations}
                  title="Remove all annotations from the scene (undoable; saved file untouched until you Save)"
                >
                  <Trash2 size={15} />
                  Clear
                </button>
                <button
                  className="secondaryButton"
                  disabled={!annotations.faces.length}
                  onClick={clearFaces}
                  title="Remove only mesh faces; preserve every annotated vertex and edge (undoable)"
                >
                  <Triangle size={15} />
                  Clear faces
                </button>
                <button className="secondaryButton" disabled={!annotations.vertices.length} onClick={() => setStatus(primaryValidationIssue?.message ?? 'Wireframe annotation is valid.')}>
                  Validate
                </button>
                <button
                  className="primaryButton"
                  disabled={savingGt}
                  onClick={() => void saveBundleAnnotations()}
                  title="Save annotations; also write mesh.ply when every face passes validation (Ctrl+S)"
                >
                  <Save size={15} />
                  Save
                </button>
                {activeBundle.libraryId && (
                  <button
                    className="secondaryButton"
                    disabled={savingGt}
                    onClick={() => void saveBundleAnnotations({ advanceToNext: true })}
                    title="Save and load the next scene (N)"
                  >
                    <Play size={15} />
                    Save + next
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="referencePath">Nothing loaded. Use Open to load a scene.</p>
          )}
        </Inspector>

        <section className="panel toolsPanel" aria-label="Annotation tools">
          <div className="panelTitle">
            <MousePointer2 size={16} />
            <span>Tools</span>
          </div>
          <div className="modeGrid">
            <ToolButton active={mode === 'select'} icon={<MousePointer2 size={16} />} label="Select" shortcut="S" onClick={() => changeMode('select')} />
            <ToolButton active={mode === 'vertex'} icon={<CircleDot size={16} />} label="Vertex" shortcut="V" onClick={() => changeMode('vertex')} />
            <ToolButton active={mode === 'edge'} icon={<BoxSelect size={16} />} label="Edge" shortcut="E" onClick={() => changeMode('edge')} />
            <ToolButton active={mode === 'face'} icon={<Triangle size={16} />} label="Face" shortcut="F" onClick={() => changeMode('face')} />
            <ToolButton active={mode === 'square'} icon={<Square size={16} />} label="Square" shortcut="Q" onClick={() => changeMode('square')} />
          </div>
          <div className="toolActions">
            <button className="iconText" disabled={!faceDraft.length && !undoStack.length} onClick={undoLastAction} title={faceDraft.length ? 'Cancel the current face draft (Ctrl+Z)' : 'Undo (Ctrl+Z)'}>
              <Undo2 size={14} />
              Undo
            </button>
            <button className="iconText" disabled={Boolean(faceDraft.length) || !redoStack.length} onClick={redoAnnotationChange} title="Redo (Ctrl+Shift+Z)">
              <Redo2 size={14} />
              Redo
            </button>
            <button
              className="iconText"
              disabled={!selectedVertexId && !selectedEdge && selectedFaceIndex === null}
              onClick={deleteSelectedAnnotation}
              title="Delete selection (Del)"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
          {(faceDraft.length > 0 || selectedFaceIndex !== null) && <div className="toolActions">
            {faceDraft.length > 0 && <><button className="iconText" disabled={mode !== 'face' || faceDraft.length < 3} onClick={finishFace} title="Close the drafted face (Enter)">
              <Triangle size={14} />
              Finish face
            </button>
            <button className="iconText" disabled={!faceDraft.length} onClick={cancelFaceDraft} title="Cancel the entire face draft (Esc or Ctrl+Z)">
              <X size={14} />
              Cancel face
            </button></>}
            {selectedFaceIndex !== null && <button
              className="iconText"
              disabled={selectedFaceIndex === null}
              onClick={extrudeSelectedComponentDown}
              title="Extrude the selected face's connected component to lower mesh surfaces or DEM ground (D)"
            >
              <ArrowDown size={14} />
              Extrude component
            </button>}
          </div>}
          {(mode === 'square' || selectedSquare) && <div className="modeOptions">
          <Slider
            disabled={!model}
            label="Square size"
            max={5}
            min={0.2}
            step={0.05}
            value={squareControlSize}
            onChange={(size) => transformSelectedSquare(size, squareControlRotationDeg)}
          />
          <Slider
            disabled={!model}
            label="Square rotate"
            max={180}
            min={-180}
            step={1}
            value={squareControlRotationDeg}
            onChange={(rotationDeg) => transformSelectedSquare(squareControlSize, rotationDeg)}
          />
          </div>}
          <div className="annotationSummary">
            <span>{annotations.vertices.length} vertices</span>
            <span>{annotations.edges.length} edges</span>
            <span>{annotations.faces.length} mesh faces</span>
            <span>{selectedObjectLabel} selected</span>
          </div>
        </section>

        <Inspector title="View" mobile={isMobile} visible={mobilePanel === 'view'} onClose={() => setMobilePanel(null)}>
          <div className="segmented two">
            <button
              className={!settings.colorPointsByHeight && settings.pointColorMode === 'orthophoto' ? 'active' : ''}
              onClick={() => setSettings((current) => ({ ...current, colorPointsByHeight: false, pointColorMode: 'orthophoto' }))}
            >
              Photo colors
            </button>
            <button
              className={!settings.colorPointsByHeight && settings.pointColorMode === 'class' ? 'active' : ''}
              onClick={() => setSettings((current) => ({ ...current, colorPointsByHeight: false, pointColorMode: 'class' }))}
            >
              Classification
            </button>
          </div>
          <div className="segmented three compact">
            <button onClick={() => applyViewPreset('top')}>Top</button>
            <button onClick={() => applyViewPreset('oblique')}>Oblique</button>
            <button onClick={() => applyViewPreset('profile')}>Profile</button>
          </div>
          <Slider label="Surface alpha" max={1} min={0} step={0.01} value={settings.orthoOpacity} onChange={(value) => updateSetting('orthoOpacity', value)} />
          <Slider label="Point size" max={0.9} min={0.03} step={0.005} value={settings.pointSize} onChange={(value) => updateSetting('pointSize', value)} />
          <label className="compactToggle">
            <input type="checkbox" checked={settings.showTerrain} disabled={!terrainRaster} onChange={(event) => updateSetting('showTerrain', event.currentTarget.checked)} />
            <span>Show DEM</span>
          </label>
          <label className="compactToggle">
            <input
              type="checkbox"
              checked={settings.colorPointsByHeight}
              onChange={(event) => updateSetting('colorPointsByHeight', event.currentTarget.checked)}
            />
            <span>Color points by height</span>
          </label>
          <label className="compactToggle">
            <input type="checkbox" checked={settings.showPoints} onChange={(event) => updateSetting('showPoints', event.currentTarget.checked)} />
            <span>Show points</span>
          </label>
          <label className="compactToggle">
            <input type="checkbox" checked={showExportPreview} onChange={(event) => setShowExportPreview(event.currentTarget.checked)} />
            <Eye size={14} />
            <span>Export mesh preview</span>
          </label>
          {pointClassIds.length > 0 && (
            <details className="classFilter">
              <summary>Point classes</summary>
              <div className="classFilterActions">
                <button type="button" onClick={() => setAllPointClassesVisible(true)}>All</button>
                <button type="button" onClick={() => setAllPointClassesVisible(false)}>None</button>
              </div>
              <div className="classFilterGrid">
                {pointClassIds.map((classId) => (
                  <label key={classId}>
                    <input
                      type="checkbox"
                      checked={visibleClasses[classId] !== false}
                      onChange={(event) => setVisibleClasses((current) => ({ ...current, [classId]: event.currentTarget.checked }))}
                    />
                    <span>{pointClassLabel(classId)}</span>
                    <em>{model?.classCounts?.[classId]?.toLocaleString()}</em>
                  </label>
                ))}
              </div>
            </details>
          )}
        </Inspector>
      </aside>

      <main className="viewportWrap">
        <SceneViewport
          annotations={annotations}
          boundaryEdges={validation.topology.boundaryEdges}
          faceDraft={faceDraft}
          houseBboxLv95={activeBundle?.manifest.focus_extent ?? null}
          mode={mode}
          model={model}
          selectedEdge={selectedEdge}
          selectedFaceIndex={selectedFaceIndex}
          selectedVertexId={selectedVertexId}
          settings={settings}
          showExportPreview={showExportPreview}
          terrainRaster={terrainRaster}
          terrainReference={terrainReference}
          visibleClasses={visibleClasses}
          viewPreset={viewPreset}
          onAddEdge={addAnnotationEdge}
          onAddFaceVertex={addFaceDraftVertex}
          onAddVertex={addAnnotationVertex}
          onBeginAnnotationEdit={beginAnnotationEdit}
          onDeleteEdge={deleteAnnotationEdge}
          onDeleteFace={deleteAnnotationFace}
          onDeleteVertex={deleteAnnotationVertex}
          onDraftFace={draftFaceVertex}
          onModeChange={changeMode}
          onFinishMoveVertices={finishMoveAnnotationVertices}
          onMoveVertices={moveAnnotationVertices}
          onPlaceSquare={placeSquareFace}
          onSelectEdge={selectAnnotationEdge}
          onSelectFace={selectAnnotationFace}
          onSelectVertex={selectAnnotationVertex}
          onStatus={setStatus}
          earthAlignment={effectiveEarthAlignment}
          onEarthAlignmentChange={saveEarthAlignment}
        />
        <div className="statusBar">
          <span role="status" className={busy ? 'pulse' : ''}>{status}</span>
          <span className="statusRight">
            <span>{activeBundle?.manifest.crs ?? model?.metadata?.crs ?? 'local coordinates'}</span>
            <button className="helpButton" onClick={() => setShowHelp((value) => !value)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
              ?
            </button>
          </span>
        </div>
      </main>
      <OpenDialog
        visible={openDialogVisible}
        initialFiles={droppedFiles}
        onClose={() => {
          setOpenDialogVisible(false);
          setDroppedFiles(null);
          void refreshSceneLibrary();
        }}
        onLoadBundle={loadBundleIntoApp}
      />
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function Inspector(props: { title: string; mobile: boolean; visible: boolean; onClose: () => void; children: ReactNode }) {
  if (props.mobile && !props.visible) return null;
  if (props.mobile) return (
    <Modal title={props.title} className="inspectorDialog" onClose={props.onClose}>
      <header className="dialogHeader"><h2>{props.title}</h2><button className="dialogClose" aria-label="Close" onClick={props.onClose}><X size={18} /></button></header>
      <div className="dialogBody">{props.children}</div>
    </Modal>
  );
  return <section className="panel inspectorPanel"><h2 className="panelTitle">{props.title}</h2>{props.children}</section>;
}

const SHORTCUTS: [string, string][] = [
  ['S / V / E / F / Q', 'Select · Vertex · Edge · Face · Square mode'],
  ['Esc', 'Cancel the face draft and return to Select mode'],
  ['Enter', 'Close the drafted face'],
  ['D', "Extrude the selected face's connected component to lower surfaces or DEM ground"],
  ['Del / Backspace', 'Delete selection'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Cancel current face draft, otherwise Undo / Redo'],
  ['Ctrl+S', 'Save annotations'],
  ['N', 'Save + next scene'],
  ['?', 'Toggle this help'],
  ['Drag on object', 'Move (Shift = horizontal, Alt = vertical)'],
  ['Right-click on object', 'Delete vertex / edge / face'],
  ['Align mode', 'Shift+drag / Alt+drag shifts the Google tiles']
];

function ShortcutHelp(props: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" className="helpDialog" closeKey="?" onClose={props.onClose}>
        <header className="dialogHeader">
          <h2>Keyboard shortcuts</h2>
          <button className="dialogClose" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="dialogBody">
          <table className="helpTable">
            <tbody>
              {SHORTCUTS.map(([keys, action]) => (
                <tr key={keys}>
                  <td>
                    <kbd>{keys}</kbd>
                  </td>
                  <td>{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </Modal>
  );
}

function downloadTextFile(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function fetchSceneLibrary(): Promise<SceneLibraryEntry[]> {
  const response = await fetch('/api/scenes');
  if (!response.ok) throw new Error(`Scene library unavailable (${response.status})`);
  const payload = (await response.json()) as { scenes?: SceneLibraryEntry[] };
  return payload.scenes ?? [];
}

function pointClassLabel(classId: string): string {
  const names: Record<string, string> = {
    '1': 'Unclassified',
    '2': 'Ground',
    '3': 'Low veg',
    '4': 'Med veg',
    '5': 'High veg',
    '6': 'Building',
    '9': 'Water'
  };
  return names[classId] ? `${classId} ${names[classId]}` : `Class ${classId}`;
}

/**
 * Match the pre-rewrite floor behavior: use the lowest DEM sample across the
 * active building/site, with scene bounds as a fallback when no DEM exists.
 */
function sceneGroundY(
  model: SceneModel,
  annotations: AnnotationSet,
  raster: RasterImage | null,
  extent: [number, number, number, number] | null
): number {
  const fallback = fallbackSceneGroundY(model, annotations);
  if (!raster || !extent) return fallback;
  const values = sceneGroundSamplePoints(model, extent)
    .map(([worldX, worldY]) => sampleTerrainZAtWorldXY(raster, extent, worldX, worldY))
    .filter((value): value is number => value !== null)
    .map((worldZ) => worldZ - (model.verticalOffset ?? 0));
  return values.length ? Math.min(...values) : fallback;
}

function sceneGroundSamplePoints(model: SceneModel, terrainExtent: [number, number, number, number]): [number, number][] {
  const samples: [number, number][] = [];
  for (const ring of model.buildingOutline?.rings ?? []) {
    for (const point of ring) samples.push([model.center.x + point[0], model.center.y - point[2]]);
  }
  const points = model.buildingOutline?.rings.flat() ?? [];
  const bounds: [number, number, number, number] = points.length
    ? [
        Math.min(...points.map((point) => point[0])),
        Math.min(...points.map((point) => point[2])),
        Math.max(...points.map((point) => point[0])),
        Math.max(...points.map((point) => point[2]))
      ]
    : [
        model.worldBounds.minX - model.center.x,
        -(model.worldBounds.maxY - model.center.y),
        model.worldBounds.maxX - model.center.x,
        -(model.worldBounds.minY - model.center.y)
      ];
  const [minX, minZ, maxX, maxZ] = bounds;
  for (let row = 0; row <= 8; row += 1) {
    const z = minZ + ((maxZ - minZ) * row) / 8;
    for (let col = 0; col <= 8; col += 1) {
      const x = minX + ((maxX - minX) * col) / 8;
      samples.push([model.center.x + x, model.center.y - z]);
    }
  }
  const [terrainMinX, terrainMinY, terrainMaxX, terrainMaxY] = terrainExtent;
  return samples.filter(
    ([worldX, worldY]) => worldX >= terrainMinX && worldX <= terrainMaxX && worldY >= terrainMinY && worldY <= terrainMaxY
  );
}

function fallbackSceneGroundY(model: SceneModel, annotations: AnnotationSet): number {
  const outlineGround = model.buildingOutline?.heightExtent?.yMin;
  const annotatedGround = annotations.vertices.length
    ? Math.min(...annotations.vertices.map((vertex) => vertex.position[1])) - 0.25
    : Number.POSITIVE_INFINITY;
  return Math.min(
    outlineGround ?? Number.POSITIVE_INFINITY,
    model.worldBounds.minZ - (model.verticalOffset ?? 0),
    annotatedGround
  );
}

function sampleTerrainZAtWorldXY(
  raster: RasterImage,
  extent: [number, number, number, number],
  worldX: number,
  worldY: number
): number | null {
  const [minX, minY, maxX, maxY] = extent;
  if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) return null;
  const col = ((worldX - minX) / (maxX - minX || 1)) * (raster.width - 1);
  const row = (1 - (worldY - minY) / (maxY - minY || 1)) * (raster.height - 1);
  return sampleRasterValue(raster, col, row);
}

function annotationKey(annotations: AnnotationSet): string {
  return JSON.stringify({
    vertices: annotations.vertices.map((vertex) => [vertex.id, ...vertex.position.map((value) => Number(value.toFixed(5)))]),
    edges: annotations.edges,
    faces: annotations.faces
  });
}

function ToolButton(props: { active: boolean; icon: React.ReactNode; label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      className={`toolButton ${props.active ? 'active' : ''}`}
      onClick={props.onClick}
      title={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
    >
      {props.icon}
      <span>{props.label}</span>
      {props.shortcut && <kbd>{props.shortcut}</kbd>}
    </button>
  );
}

function sceneDisplayName(entry: { name: string; collection: string }): string {
  if (entry.collection && entry.name.startsWith(entry.collection) && entry.name.length > entry.collection.length) {
    return entry.name.slice(entry.collection.length).replace(/^[_-]+/, '');
  }
  return entry.name;
}

function Slider(props: {
  disabled?: boolean;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const decimals = props.step >= 1 ? 0 : props.step < 0.01 ? 3 : 2;
  return (
    <label className={`sliderRow ${props.disabled ? 'disabled' : ''}`}>
      <span>{props.label}</span>
      <input
        max={props.max}
        min={props.min}
        step={props.step}
        type="range"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
      <output>{props.value.toFixed(decimals)}</output>
    </label>
  );
}


function findDuplicateFaceIndex(faces: string[][], face: string[]): number | null {
  const key = faceVertexSetKey(face);
  const index = faces.findIndex((candidate) => faceVertexSetKey(candidate) === key);
  return index === -1 ? null : index;
}

function faceVertexSetKey(face: string[]): string {
  return [...new Set(face)].sort().join('|');
}

function squareEditGeometry(annotations: AnnotationSet, faceIndex: number): SquareEditGeometry | null {
  const face = annotations.faces[faceIndex];
  if (!face || face.length !== 4) return null;
  const verticesById = new Map(annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
  const points = face.map((id) => verticesById.get(id));
  if (points.some((point) => !point)) return null;
  const squarePoints = points as Point3[];
  const normal = faceNormal(squarePoints);
  if (!normal) return null;
  const firstEdge = subtract(squarePoints[1], squarePoints[0]);
  if (vectorLength(firstEdge) <= 1e-6) return null;
  const u = normalizeVector(firstEdge);
  const baseFrame = squareReferenceFrame(normal);
  const edgeLengths = squarePoints
    .map((point, index) => vectorLength(subtract(squarePoints[(index + 1) % squarePoints.length], point)))
    .filter((length) => length > 1e-6);
  if (!edgeLengths.length) return null;

  return {
    center: centroid(squarePoints),
    baseFrame,
    size: edgeLengths.reduce((sum, length) => sum + length, 0) / edgeLengths.length,
    rotationDeg: normalizeAngleDegrees((signedAngleInPlane(baseFrame.u, u, normal) * 180) / Math.PI)
  };
}

function transformedSquarePositions(
  annotations: AnnotationSet,
  faceIndex: number,
  size: number,
  rotationDeg: number
): Map<string, Point3> | null {
  const geometry = squareEditGeometry(annotations, faceIndex);
  const face = annotations.faces[faceIndex];
  if (!geometry || !face || face.length !== 4) return null;
  const frame = rotateFrame(geometry.baseFrame, (rotationDeg * Math.PI) / 180);
  const half = Math.max(0.001, size) / 2;
  const positions: Point3[] = [
    offsetPoint(geometry.center, frame.u, -half, frame.v, -half),
    offsetPoint(geometry.center, frame.u, half, frame.v, -half),
    offsetPoint(geometry.center, frame.u, half, frame.v, half),
    offsetPoint(geometry.center, frame.u, -half, frame.v, half)
  ];
  return new Map(face.map((id, index) => [id, positions[index]]));
}

function squareReferenceFrame(normal: Point3): { u: Point3; v: Point3 } {
  const candidates: Point3[] = [
    [1, 0, 0],
    [0, 0, 1],
    [0, 1, 0]
  ];
  for (const candidate of candidates) {
    const projected = subtract(candidate, scale(normal, dot(candidate, normal)));
    if (vectorLength(projected) <= 1e-6) continue;
    const u = normalizeVector(projected);
    const v = normalizeVector(cross(normal, u));
    if (vectorLength(v) > 1e-6) return { u, v };
  }
  return { u: [1, 0, 0], v: [0, 0, 1] };
}

function squarePlacementFrame(annotations: AnnotationSet, faceIndex: number | null): { u: Point3; v: Point3 } {
  const squareGeometry = faceIndex === null ? null : squareEditGeometry(annotations, faceIndex);
  return squareGeometry?.baseFrame ?? squareFrame(annotations, faceIndex);
}

function squareFrame(annotations: AnnotationSet, faceIndex: number | null): { u: [number, number, number]; v: [number, number, number] } {
  const fallback = { u: [1, 0, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number] };
  if (faceIndex === null) return fallback;
  const face = annotations.faces[faceIndex];
  if (!face) return fallback;
  const verticesById = new Map(annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
  const points = face.map((id) => verticesById.get(id)).filter((point): point is [number, number, number] => Boolean(point));
  const normal = faceNormal(points);
  if (!normal) return fallback;
  for (let index = 0; index < points.length; index += 1) {
    const edge = subtract(points[(index + 1) % points.length], points[index]);
    if (vectorLength(edge) <= 1e-6) continue;
    const u = normalizeVector(edge);
    const v = normalizeVector(cross(normal, u));
    if (vectorLength(v) > 1e-6) return { u, v };
  }
  return fallback;
}

function rotateFrame(
  frame: { u: [number, number, number]; v: [number, number, number] },
  radians: number
): { u: [number, number, number]; v: [number, number, number] } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    u: [
      frame.u[0] * cos + frame.v[0] * sin,
      frame.u[1] * cos + frame.v[1] * sin,
      frame.u[2] * cos + frame.v[2] * sin
    ],
    v: [
      frame.v[0] * cos - frame.u[0] * sin,
      frame.v[1] * cos - frame.u[1] * sin,
      frame.v[2] * cos - frame.u[2] * sin
    ]
  };
}

function offsetPoint(
  origin: [number, number, number],
  u: [number, number, number],
  uAmount: number,
  v: [number, number, number],
  vAmount: number
): [number, number, number] {
  return [
    origin[0] + u[0] * uAmount + v[0] * vAmount,
    origin[1] + u[1] * uAmount + v[1] * vAmount,
    origin[2] + u[2] * uAmount + v[2] * vAmount
  ];
}

function centroid(points: Point3[]): Point3 {
  const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1], acc[2] + point[2]] as Point3, [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function scale(vector: Point3, amount: number): Point3 {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function signedAngleInPlane(from: Point3, to: Point3, normal: Point3): number {
  return Math.atan2(dot(cross(from, to), normal), dot(from, to));
}

function normalizeAngleDegrees(degrees: number): number {
  let normalized = degrees;
  while (normalized <= -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return normalized;
}
