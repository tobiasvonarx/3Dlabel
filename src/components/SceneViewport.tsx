import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Globe2 } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { AnnotationEdge, AnnotationSet, BuildingOutline, Mode, RasterImage, SceneModel, TerrainReference, ViewPreset, ViewSettings } from '../types';
import { colorFromHeight, createTexture, sampleRasterRgb, sampleRasterValue } from '../lib/raster';
import { annotationsToTriangleMesh, triangulateFaceIndices } from '../lib/mesh';
import { geolocateModel, modelPointToWgs84 } from '../lib/geo';
import { createGoogleTilesLayer, type GoogleTilesLayer } from '../lib/googleTiles';

const EARTH_MODE_KEY = 'label3d.earthLayerMode';
const LEGACY_EARTH_ENABLED_KEY = 'label3d.earthLayerEnabled';
const EARTH_TRANSPARENT_OPACITY = 0.4;
// Approximate geoid undulation (ellipsoidal minus orthometric height) for Switzerland;
// the auto-alignment removes the per-case residual after tiles load.
const DEFAULT_GEOID_OFFSET = 49.5;
const GOOGLE_LOGO_URL = 'https://www.gstatic.com/images/branding/googlelogo/1x/googlelogo_color_68x28dp.png';
const COPLANAR_FACE_HIT_EPS = 0.02;

interface Props {
  annotations: AnnotationSet;
  boundaryEdges: AnnotationEdge[];
  faceDraft: string[];
  houseBboxLv95?: [number, number, number, number] | null;
  mode: Mode;
  model: SceneModel | null;
  selectedEdge: AnnotationEdge | null;
  selectedFaceIndex: number | null;
  selectedVertexId: string | null;
  settings: ViewSettings;
  showExportPreview: boolean;
  terrainRaster: RasterImage | null;
  terrainReference: TerrainReference | null;
  visibleClasses: Record<string, boolean>;
  viewPreset: { id: number; kind: ViewPreset } | null;
  onAddFaceVertex: (position: [number, number, number], snap?: { edge?: [string, string] }) => void;
  onAddVertex: (position: [number, number, number], snap?: { edge?: [string, string] }) => string;
  onAddEdge: (a: string, b: string) => void;
  onBeginAnnotationEdit: () => void;
  onDeleteEdge: (edge: AnnotationEdge) => void;
  onDeleteFace: (faceIndex: number) => void;
  onDeleteVertex: (id: string) => void;
  onDraftFace: (id: string) => void;
  onModeChange: (mode: Mode) => void;
  onFinishMoveVertices: (vertexIds: string[]) => { mergedCount: number; canonicalIds: Record<string, string> };
  onMoveVertices: (positionsById: Record<string, [number, number, number]>) => void;
  onPlaceSquare: (center: [number, number, number], frameFaceIndex?: number) => void;
  onSelectEdge: (edge: AnnotationEdge | null) => void;
  onSelectFace: (faceIndex: number | null) => void;
  onSelectVertex: (id: string | null) => void;
  onStatus: (status: string) => void;
  /** Manually locked Google-tiles shift from the scene manifest (ΔE/ΔN/ΔH meters). */
  earthAlignment?: EarthAlignmentShift | null;
  /** Called when the user locks an alignment so it can be persisted per scene. */
  onEarthAlignmentChange?: (alignment: EarthAlignmentShift) => void;
}

export interface EarthAlignmentShift {
  de: number;
  dn: number;
  dh: number;
  /** Where the shift comes from: locked on this scene, or a collection/global median default. */
  source?: 'scene' | 'default';
  /** Number of locked scenes the default median was derived from. */
  basedOn?: number;
}

interface EarthDragState {
  pointerId: number;
  mode: 'horizontal' | 'vertical';
  plane: THREE.Plane;
  lastPoint: THREE.Vector3 | null;
  lastClientY: number;
  heightPerPixel: number;
}

type EarthMode = 'off' | 'transparent' | 'full';

function initialEarthMode(): EarthMode {
  const stored = localStorage.getItem(EARTH_MODE_KEY);
  if (stored === 'transparent' || stored === 'full' || stored === 'off') return stored;
  return localStorage.getItem(LEGACY_EARTH_ENABLED_KEY) === '1' ? 'full' : 'off';
}

interface DragState {
  kind: 'vertex' | 'edge' | 'face';
  id: string;
  vertexIds: string[];
  mode: 'free' | 'height' | 'horizontal';
  moved: boolean;
  plane: THREE.Plane;
  pointerId: number;
  startPositions: Record<string, [number, number, number]>;
  currentPositions: Record<string, [number, number, number]>;
  startX: number;
  startY: number;
  heightPerPixel: number;
  currentAnchor: [number, number, number];
  modeStartAnchor: [number, number, number];
  modeStartPositions: Record<string, [number, number, number]>;
  modeStartY: number;
}

interface HoverPointState {
  index: number;
  points: THREE.Points;
  color: [number, number, number];
}

interface PointHit {
  index: number;
  point: THREE.Vector3;
  points: THREE.Points;
}

interface AnnotationSnap {
  kind: 'vertex' | 'edge' | 'face';
  point: THREE.Vector3;
  vertexId?: string;
  edge?: [string, string];
  faceIndex?: number;
}

interface SnapOptions {
  excludeVertexIds?: Set<string>;
  maxCameraDistance?: number;
}

interface PlacementSurfaceHit {
  point: THREE.Vector3;
  snap?: AnnotationSnap;
  distance: number;
  pointHit?: PointHit;
  source: 'point' | 'face' | 'terrain';
}

export default function SceneViewport(props: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const annotationGroupRef = useRef<THREE.Group | null>(null);
  const buildingOutlineGroupRef = useRef<THREE.Group | null>(null);
  const hoverPointRef = useRef<HoverPointState | null>(null);
  const hoverMarkerRef = useRef<THREE.Mesh | null>(null);
  const hoverLabelRef = useRef('');
  const hoverThrottleRef = useRef(0);
  const lastEdgeVertexRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const earthLayerRef = useRef<GoogleTilesLayer | null>(null);
  const earthOffsetRef = useRef({ x: 0, y: 0, z: 0 });
  const earthDragRef = useRef<EarthDragState | null>(null);
  const alignModeRef = useRef(false);
  const [hoverLabel, setHoverLabel] = useState('');
  const [terrainReadout, setTerrainReadout] = useState('');
  const [showDebugLabels, setShowDebugLabels] = useState(false);
  const [showDrapedOrtho, setShowDrapedOrtho] = useState(false);
  const [earthMode, setEarthMode] = useState<EarthMode>(initialEarthMode);
  const [earthAttribution, setEarthAttribution] = useState('');
  const [alignMode, setAlignMode] = useState(false);
  const [earthOffsetLabel, setEarthOffsetLabel] = useState('');
  const propsRef = useRef(props);

  alignModeRef.current = alignMode;
  const earthEnabled = earthMode !== 'off';
  const earthOpacity = earthMode === 'transparent' ? EARTH_TRANSPARENT_OPACITY : 1;

  propsRef.current = props;

  useEffect(() => {
    if (props.mode !== 'edge') lastEdgeVertexRef.current = null;
  }, [props.mode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor('#080b10');
    rendererRef.current = renderer;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.fog = new THREE.Fog('#080b10', 110, 240);

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(host.clientHeight, 1), 0.01, 10000);
    camera.position.set(34, 34, 42);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.target.set(0, 4, 0);
    controlsRef.current = controls;

    const ambient = new THREE.HemisphereLight('#dbeafe', '#101827', 2.4);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight('#ffffff', 2.5);
    directional.position.set(25, 45, 20);
    scene.add(directional);

    const grid = new THREE.GridHelper(70, 28, '#2f3b4f', '#151c29');
    grid.position.y = -0.15;
    scene.add(grid);

    const annotationGroup = new THREE.Group();
    annotationGroup.name = 'annotations';
    annotationGroupRef.current = annotationGroup;
    scene.add(annotationGroup);

    const buildingOutlineGroup = new THREE.Group();
    buildingOutlineGroup.name = 'buildingOutline';
    buildingOutlineGroupRef.current = buildingOutlineGroup;
    scene.add(buildingOutlineGroup);

    const resize = () => {
      if (!host || !camera || !renderer) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let running = true;
    const animate = () => {
      if (!running) return;
      controls.update();
      earthLayerRef.current?.update();
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    animate();

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    return () => {
      running = false;
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const syncModifier = (event: KeyboardEvent) => {
      const enabled = !document.querySelector('dialog[open]') && (event.ctrlKey || event.metaKey);
      setShowDebugLabels(enabled);
      setShowDrapedOrtho(enabled);
    };
    const clearModifier = () => {
      setShowDebugLabels(false);
      setShowDrapedOrtho(false);
    };
    window.addEventListener('keydown', syncModifier);
    window.addEventListener('keyup', syncModifier);
    window.addEventListener('blur', clearModifier);
    return () => {
      window.removeEventListener('keydown', syncModifier);
      window.removeEventListener('keyup', syncModifier);
      window.removeEventListener('blur', clearModifier);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(EARTH_MODE_KEY, earthMode);
    localStorage.setItem(LEGACY_EARTH_ENABLED_KEY, earthEnabled ? '1' : '0');
  }, [earthEnabled, earthMode]);

  useEffect(() => {
    const layer = earthLayerRef.current;
    if (!layer) return;
    layer.setOpacity(earthOpacity);
    layer.setLocalOffset(earthOffsetRef.current);
  }, [earthOpacity]);

  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const model = props.model;
    if (!earthEnabled || !scene || !camera || !renderer || !model) return;

    const located = geolocateModel(model);
    if (!located) {
      propsRef.current.onStatus('3D Earth: model has no usable georeference.');
      return;
    }
    const apiKey = window.label3dConfig?.googleCloudApiKey;
    if (!apiKey) {
      propsRef.current.onStatus('3D Earth: set GOOGLE_CLOUD_API_KEY in .env and restart the application server.');
      return;
    }

    let layer: GoogleTilesLayer;
    try {
      layer = createGoogleTilesLayer({
        apiKey,
        lat: located.lat,
        lon: located.lon,
        originHeight: (model.verticalOffset ?? 0) + DEFAULT_GEOID_OFFSET,
        opacity: earthOpacity,
        camera,
        renderer
      });
    } catch (error) {
      propsRef.current.onStatus(`3D Earth failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    earthLayerRef.current = layer;
    scene.add(layer.group);

    // Re-apply the manually locked shift stored in the scene manifest.
    const stored = propsRef.current.earthAlignment;
    if (stored) {
      layer.applyLocalOffset({ x: stored.de, y: stored.dh, z: -stored.dn });
      earthOffsetRef.current = { x: stored.de, y: stored.dh, z: -stored.dn };
      const values = `ΔE ${stored.de.toFixed(2)} m, ΔN ${stored.dn.toFixed(2)} m, ΔH ${stored.dh.toFixed(2)} m`;
      propsRef.current.onStatus(
        stored.source === 'default'
          ? `3D Earth ${earthModeLabel(earthMode)} · default alignment ${values} (median of ${stored.basedOn ?? '?'} locked scenes — Align to adjust and lock)`
          : `3D Earth ${earthModeLabel(earthMode)} · stored alignment ${values}`
      );
    } else {
      earthOffsetRef.current = { x: 0, y: 0, z: 0 };
      propsRef.current.onStatus(`3D Earth ${earthModeLabel(earthMode)}: streaming Google photorealistic tiles. Use Align to shift them onto the LiDAR.`);
    }
    setEarthOffsetLabel(formatEarthOffset(earthOffsetRef.current));

    const attributionTimer = window.setInterval(() => setEarthAttribution(layer.getAttributions()), 2000);
    return () => {
      window.clearInterval(attributionTimer);
      setEarthAttribution('');
      setAlignMode(false);
      earthLayerRef.current = null;
      scene.remove(layer.group);
      layer.dispose();
    };
  }, [earthEnabled, props.model]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const old = scene.getObjectByName('modelRoot');
    clearHoverPoint();
    if (old) {
      scene.remove(old);
      disposeObject(old);
    }
    terrainMeshRef.current = null;

    if (!props.model) return;
    const root = new THREE.Group();
    root.name = 'modelRoot';

    if (props.model.textureCanvas && props.terrainRaster && props.terrainReference?.extent_lv95) {
      const geometry = createTerrainOrthophotoGeometry(props.model, props.terrainRaster, props.terrainReference.extent_lv95);
      const texture = createTexture(props.model.textureCanvas);
      const surfaceMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        map: texture,
        transparent: true,
        opacity: props.settings.orthoOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geometry, surfaceMaterial);
      mesh.name = 'orthoSurface';
      mesh.visible = props.settings.showTerrain && !showDrapedOrtho;
      mesh.userData.textureCanvas = props.model.textureCanvas;
      terrainMeshRef.current = props.settings.showTerrain ? mesh : null;
      root.add(mesh);

      const dsmGeometry = createDsmOrthophotoGeometry(props.model, props.terrainRaster, props.terrainReference.extent_lv95);
      const dsmMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        map: createTexture(props.model.textureCanvas),
        transparent: true,
        opacity: props.settings.orthoOpacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const dsmMesh = new THREE.Mesh(dsmGeometry, dsmMaterial);
      dsmMesh.name = 'dsmOrthoSurface';
      dsmMesh.visible = props.settings.showTerrain && showDrapedOrtho;
      dsmMesh.userData.textureCanvas = props.model.textureCanvas;
      root.add(dsmMesh);

      const wireMaterial = new THREE.LineBasicMaterial({ color: '#f8fafc', transparent: true, opacity: 0.28 });
      const wire = new THREE.LineSegments(createTerrainOrthoGridGeometry(props.model, props.terrainRaster, props.terrainReference.extent_lv95), wireMaterial);
      wire.name = 'demWire';
      wire.visible = props.settings.showTerrain && showDrapedOrtho;
      root.add(wire);
      terrainMeshRef.current = props.settings.showTerrain ? (showDrapedOrtho ? dsmMesh : mesh) : null;
    }

    const pointsGeometry = createPointGeometry(props.model, props.settings, props.visibleClasses);
    const pointsMaterial = new THREE.PointsMaterial({
      size: props.settings.pointSize,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 1
    });
    const points = new THREE.Points(pointsGeometry, pointsMaterial);
    points.name = 'pointCloud';
    points.visible = props.settings.showPoints;
    root.add(points);

    scene.add(root);
    frameModel(props.model);
  }, [props.model?.positions, props.terrainRaster, props.terrainReference?.extent_lv95]);

  useEffect(() => {
    syncTerrainDisplay();
  }, [showDrapedOrtho, props.settings.showTerrain]);

  useEffect(() => {
    if (!props.model || !props.viewPreset) return;
    applyViewPreset(props.model, props.viewPreset.kind);
  }, [props.model, props.viewPreset]);

  useEffect(() => {
    const root = sceneRef.current?.getObjectByName('modelRoot');
    const model = props.model;
    if (!root || !model) return;
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments)) return;
      const geometry = object.geometry as THREE.BufferGeometry;
      if (geometry.attributes.position.count === model.positions.length / 3) {
        geometry.setAttribute('position', new THREE.BufferAttribute(model.positions.slice(), 3));
        geometry.computeVertexNormals();
        geometry.attributes.position.needsUpdate = true;
      }
      if (object instanceof THREE.Points) {
        object.visible = props.settings.showPoints;
        clearHoverPoint();
        object.geometry.dispose();
        object.geometry = createPointGeometry(model, props.settings, props.visibleClasses);
        const material = object.material as THREE.PointsMaterial;
        material.size = props.settings.pointSize;
      }
      if (object instanceof THREE.Mesh && object.name === 'orthoSurface') {
        object.geometry.dispose();
        if (props.terrainRaster && props.terrainReference?.extent_lv95) {
          object.geometry = createTerrainOrthophotoGeometry(model, props.terrainRaster, props.terrainReference.extent_lv95);
        }
        const material = object.material as THREE.MeshBasicMaterial;
        syncMeshTexture(material, model.textureCanvas, object);
        material.opacity = props.settings.orthoOpacity;
        material.needsUpdate = true;
      }
      if (object instanceof THREE.Mesh && object.name === 'dsmOrthoSurface') {
        object.geometry.dispose();
        if (props.terrainRaster && props.terrainReference?.extent_lv95) {
          object.geometry = createDsmOrthophotoGeometry(model, props.terrainRaster, props.terrainReference.extent_lv95);
        }
        const material = object.material as THREE.MeshBasicMaterial;
        syncMeshTexture(material, model.textureCanvas, object);
        material.opacity = props.settings.orthoOpacity;
        material.needsUpdate = true;
      }
      if (object instanceof THREE.LineSegments && object.name === 'demWire') {
        object.geometry.dispose();
        if (props.terrainRaster && props.terrainReference?.extent_lv95) {
          object.geometry = createTerrainOrthoGridGeometry(model, props.terrainRaster, props.terrainReference.extent_lv95);
        }
      }
    });
    syncTerrainDisplay();
  }, [props.model, props.settings, props.terrainRaster, props.terrainReference?.extent_lv95, props.visibleClasses]);

  useEffect(() => {
    const group = annotationGroupRef.current;
    if (!group) return;
    disposeObjectChildren(group);

    if (props.annotations.vertices.length) {
      const selectedPositions: number[] = [];
      const unselectedPositions: number[] = [];
      const draftVertexPositions: number[] = [];
      const draftStartPositions: number[] = [];
      const draftVertexIds = new Set(props.faceDraft);
      props.annotations.vertices.forEach((vertex) => {
        if (vertex.id === props.faceDraft[0]) {
          draftStartPositions.push(...vertex.position);
        } else if (draftVertexIds.has(vertex.id)) {
          draftVertexPositions.push(...vertex.position);
        } else if (vertex.id === props.selectedVertexId) {
          selectedPositions.push(...vertex.position);
        } else {
          unselectedPositions.push(...vertex.position);
        }
      });
      addAnnotationPointLayer(group, unselectedPositions, '#ff6b1a', Math.max(props.settings.pointSize * 2.2, 0.32), 'annotationVertices');
      addAnnotationPointLayer(group, selectedPositions, '#ffd84d', Math.max(props.settings.pointSize * 2.7, 0.38), 'selectedAnnotationVertex', 21);
      addAnnotationPointLayer(group, draftVertexPositions, '#38bdf8', Math.max(props.settings.pointSize * 2.9, 0.4), 'faceDraftVertices', 22);
      addAnnotationPointLayer(group, draftStartPositions, '#22c55e', Math.max(props.settings.pointSize * 3.4, 0.48), 'faceDraftStart', 23);
    }

    const vertexPositions = new Map(props.annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
    const linePositions: number[] = [];
    const boundaryEdgePositions: number[] = [];
    const selectedEdgePositions: number[] = [];
    const boundaryEdgeKeys = new Set(props.boundaryEdges.map(undirectedEdgeKey));
    for (const edge of props.annotations.edges) {
      const a = vertexPositions.get(edge[0]);
      const b = vertexPositions.get(edge[1]);
      if (!a || !b) continue;
      if (props.selectedEdge && sameEdge(edge, props.selectedEdge)) {
        selectedEdgePositions.push(...a, ...b);
        continue;
      }
      const key = undirectedEdgeKey(edge);
      if (boundaryEdgeKeys.has(key)) {
        boundaryEdgePositions.push(...a, ...b);
        continue;
      }
      linePositions.push(...a, ...b);
    }
    if (props.selectedEdge && !selectedEdgePositions.length) {
      const a = vertexPositions.get(props.selectedEdge[0]);
      const b = vertexPositions.get(props.selectedEdge[1]);
      if (a && b) selectedEdgePositions.push(...a, ...b);
    }
    const draftPositions: number[] = [];
    for (let i = 1; i < props.faceDraft.length; i += 1) {
      const a = vertexPositions.get(props.faceDraft[i - 1]);
      const b = vertexPositions.get(props.faceDraft[i]);
      if (a && b) draftPositions.push(...a, ...b);
    }
    addLines(group, linePositions, '#e34b31', 0.95, 'annotationEdges');
    addLines(group, boundaryEdgePositions, '#facc15', 1, 'boundaryEdges', { depthTest: false, renderOrder: 18 });
    addLines(group, selectedEdgePositions, '#f8fafc', 1, 'selectedAnnotationEdge', { depthTest: false, renderOrder: 20 });
    addLines(group, draftPositions, '#38bdf8', 1, 'faceDraft', { depthTest: false, renderOrder: 21 });

    props.annotations.faces.forEach((face, faceIndex) => {
      if (face.length < 3) return;
      const points = face.map((id) => vertexPositions.get(id)).filter(Boolean) as [number, number, number][];
      if (points.length < 3) return;
      const selected = faceIndex === props.selectedFaceIndex;
      const geometry = new THREE.BufferGeometry();
      const triangles: number[] = [];
      try {
        for (const [a, b, c] of triangulateFaceIndices(points)) {
          triangles.push(...points[a], ...points[b], ...points[c]);
        }
      } catch {
        // Keep the editable boundary visible; validation explains why it cannot export.
      }
      if (triangles.length) {
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color: selected ? '#ffd84d' : '#2563eb',
          transparent: true,
          opacity: selected ? 0.38 : 0.18,
          side: THREE.DoubleSide,
          depthWrite: false
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = 'annotationFace';
        mesh.userData.faceIndex = faceIndex;
        mesh.userData.faceArea = faceArea(points);
        group.add(mesh);
      }

      if (selected) {
        const outline: number[] = [];
        for (let index = 0; index < points.length; index += 1) {
          outline.push(...points[index], ...points[(index + 1) % points.length]);
        }
        addLines(group, outline, '#ffd84d', 1, 'selectedAnnotationFace');
      }

      if (showDebugLabels) {
        const label = createTextSprite(`F${faceIndex + 1}`, selected ? '#111827' : '#dbeafe', selected ? 'rgba(255, 216, 77, 0.92)' : 'rgba(37, 99, 235, 0.82)');
        label.position.copy(faceLabelPosition(points));
        label.name = 'annotationFaceLabel';
        group.add(label);
      }
    });

    if (props.showExportPreview) addExportPreview(group, props.annotations);
  }, [props.annotations, props.boundaryEdges, props.faceDraft, props.selectedEdge, props.selectedFaceIndex, props.selectedVertexId, props.settings.pointSize, props.showExportPreview, showDebugLabels]);

  useEffect(() => {
    const group = buildingOutlineGroupRef.current;
    if (!group) return;
    disposeObjectChildren(group);
    const model = props.model;
    const outline = model?.buildingOutline;
    if (!showDebugLabels || !model) return;
    if (outline?.rings.length) addBuildingOutlineLevelMarkers(group, outline);
  }, [props.model, showDebugLabels]);

  return (
    <div className={`sceneHost mode-${props.mode}`} ref={hostRef}>
      <div className="sceneHint">
        {props.mode === 'select' && 'Select: click once to select; drag vertices, edges, or mesh faces. Drag a vertex onto another vertex to merge. Shift = horizontal drag, Alt = vertical drag.'}
        {props.mode === 'vertex' && 'Vertex: click roof points to place wireframe vertices; snaps to vertices, edges, faces, and LiDAR points.'}
        {props.mode === 'edge' && 'Edge: click two vertices; edge hits split existing edges. Shift = horizontal drag, Alt = vertical drag.'}
        {props.mode === 'face' && (props.faceDraft.length
          ? `Face: ${props.faceDraft.length} connected vertices · green = start · click it or press Enter to finish · Ctrl+Z cancels the draft`
          : 'Face: click existing vertices or click the roof to create new vertices; edges are added automatically')}
        {props.mode === 'square' && 'Square: click the center point for a mesh face using the current size and rotation'}
      </div>
      {hoverLabel && <div className="snapHint">{hoverLabel}</div>}
      {props.settings.showTerrain && terrainReadout && <div className="terrainReadout">{terrainReadout}</div>}
      <div className="centerCrosshair" aria-hidden="true" />
      <div className="earthControls">
        <button
          className={`earthButton${earthEnabled ? ' earthButtonActive' : ''}${earthMode === 'transparent' ? ' earthButtonTransparent' : ''}`}
          disabled={!props.model}
          onClick={cycleEarthMode}
          title="Cycle Google photorealistic 3D tiles: off, transparent, full"
        >
          <Globe2 size={16} />
          <span>{earthButtonLabel(earthMode)}</span>
        </button>
        <button className="earthButton" disabled={!props.model} onClick={openGoogleEarth} title="Open house center in Google Earth">
          <ExternalLink size={16} />
          <span>Google Earth</span>
        </button>
        {earthEnabled && (
          <button
            className={`earthButton${alignMode ? ' earthButtonActive' : ''}`}
            onClick={toggleAlignMode}
            title="Align the Google tiles manually: Shift+drag = horizontal, Alt+drag = vertical. Click again to lock the shift into the scene."
          >
            <span>{alignMode ? 'Lock align' : 'Align'}</span>
          </button>
        )}
        {earthEnabled && alignMode && (
          <div className="earthOffsetChip">{earthOffsetLabel || formatEarthOffset(earthOffsetRef.current)}</div>
        )}
      </div>
      {earthEnabled && (
        <div className="earthAttribution">
          <img src={GOOGLE_LOGO_URL} alt="Google" />
          {earthAttribution && <span>{earthAttribution}</span>}
        </div>
      )}
    </div>
  );

  function toggleAlignMode() {
    if (!earthLayerRef.current) {
      propsRef.current.onStatus('3D Earth is not active; nothing to align.');
      return;
    }
    const next = !alignModeRef.current;
    if (next) {
      propsRef.current.onStatus('Align mode: Shift+drag shifts Google tiles horizontally, Alt+drag vertically. Click "Lock align" when done.');
    } else {
      lockEarthAlignment();
    }
    setAlignMode(next);
  }

  function cycleEarthMode() {
    setEarthMode((current) => {
      const next: EarthMode = current === 'off' ? 'transparent' : current === 'transparent' ? 'full' : 'off';
      propsRef.current.onStatus(`3D Earth ${earthModeLabel(next)}.`);
      return next;
    });
  }

  function lockEarthAlignment() {
    const offset = earthOffsetRef.current;
    const alignment = {
      de: Number(offset.x.toFixed(3)),
      dn: Number((-offset.z).toFixed(3)),
      dh: Number(offset.y.toFixed(3))
    };
    propsRef.current.onEarthAlignmentChange?.(alignment);
  }

  function onPointerDown(event: PointerEvent) {
    const current = propsRef.current;
    if (event.button !== 0) return;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!renderer || !camera || !scene) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));

    if (alignModeRef.current && earthLayerRef.current && (event.shiftKey || event.altKey)) {
      const anchorY = controlsRef.current?.target.y ?? 0;
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -anchorY);
      earthDragRef.current = {
        pointerId: event.pointerId,
        mode: event.shiftKey ? 'horizontal' : 'vertical',
        plane,
        lastPoint: event.shiftKey ? intersectPlane(ndc, plane) : null,
        lastClientY: event.clientY,
        heightPerPixel: dragHeightPerPixel([0, anchorY, 0])
      };
      controlsRef.current!.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (current.mode === 'square') {
      const hit = squarePlacementHit(event.clientX, event.clientY, rect, ndc);
      if (!hit) {
        current.onStatus('No square center hit. Click an annotation, mesh face, LiDAR point, or visible orthophoto surface.');
        event.preventDefault();
        return;
      }
      clearHoverPoint();
      current.onPlaceSquare([hit.point.x, hit.point.y, hit.point.z], hit.faceIndex);
      event.preventDefault();
      return;
    }

    const selected = findNearestVertex(event.clientX, event.clientY, rect);
    if (selected) {
      const vertex = current.annotations.vertices.find((item) => item.id === selected);
      if (!vertex) return;
      if (current.mode !== 'select') {
        clearHoverPoint();
        addOrUseVertex(selected);
        event.preventDefault();
        return;
      }
      const wasSelected = current.selectedVertexId === selected;
      clearHoverPoint();
      current.onSelectVertex(selected);
      current.onSelectEdge(null);
      current.onSelectFace(null);
      current.onStatus(`Selected ${selected}`);
      if (!wasSelected) {
        event.preventDefault();
        return;
      }
      dragRef.current = {
        kind: 'vertex',
        id: selected,
        vertexIds: [selected],
        mode: 'free',
        moved: false,
        plane: cameraFacingPlaneThrough(vertex.position),
        pointerId: event.pointerId,
        startPositions: { [selected]: vertex.position },
        currentPositions: { [selected]: vertex.position },
        startX: event.clientX,
        startY: event.clientY,
        heightPerPixel: dragHeightPerPixel(vertex.position),
        currentAnchor: vertex.position,
        modeStartAnchor: vertex.position,
        modeStartPositions: { [selected]: vertex.position },
        modeStartY: event.clientY
      };
      controlsRef.current!.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (current.mode === 'select') {
      const edgeSnap = findNearestAnnotationEdgeSnap(ndc, {});
      if (edgeSnap?.edge) {
        const wasSelected = current.selectedEdge ? sameEdge(current.selectedEdge, edgeSnap.edge) : false;
        clearHoverPoint();
        current.onSelectVertex(null);
        current.onSelectEdge(edgeSnap.edge);
        current.onSelectFace(null);
        current.onStatus(`Selected edge ${edgeSnap.edge[0]} -> ${edgeSnap.edge[1]}`);
        if (!wasSelected) {
          event.preventDefault();
          return;
        }
        const drag = createEdgeDrag(edgeSnap.edge, event);
        if (!drag) return;
        dragRef.current = drag;
        controlsRef.current!.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      const faceIndex = findNearestFace(ndc);
      if (faceIndex !== null) {
        const wasSelected = current.selectedFaceIndex === faceIndex;
        clearHoverPoint();
        current.onSelectFace(faceIndex);
        current.onSelectEdge(null);
        current.onSelectVertex(null);
        current.onStatus(`Selected mesh face ${faceIndex + 1}`);
        if (!wasSelected) {
          event.preventDefault();
          return;
        }
        const drag = createFaceDrag(faceIndex, event);
        if (!drag) return;
        dragRef.current = drag;
        controlsRef.current!.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      current.onSelectVertex(null);
      current.onSelectEdge(null);
      current.onSelectFace(null);
      return;
    }
    addOrUseVertex(null, ndc);
  }

  function squarePlacementHit(clientX: number, clientY: number, rect: DOMRect, ndc: THREE.Vector2): { point: THREE.Vector3; faceIndex?: number } | null {
    const vertexId = findNearestVertex(clientX, clientY, rect);
    const vertex = vertexId ? propsRef.current.annotations.vertices.find((item) => item.id === vertexId) : null;
    if (vertex) return { point: new THREE.Vector3(...vertex.position) };
    const hit = placementHit(ndc);
    return hit ? { point: hit.point, faceIndex: hit.snap?.kind === 'face' ? hit.snap.faceIndex : undefined } : null;
  }

  function placementHit(ndc: THREE.Vector2, options: SnapOptions = {}): { point: THREE.Vector3; snap?: AnnotationSnap } | null {
    const surfaceHit = nearestPlacementSurfaceHit(ndc);
    const edgeSnap = findNearestAnnotationEdgeSnap(ndc, {
      ...options,
      maxCameraDistance: surfaceHit ? surfaceHit.distance + foregroundSnapTolerance(surfaceHit.distance) : undefined
    });
    if (edgeSnap) return { point: edgeSnap.point, snap: edgeSnap };
    return surfaceHit ? { point: surfaceHit.point, snap: surfaceHit.snap } : null;
  }

  function onPointerMove(event: PointerEvent) {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const earthDrag = earthDragRef.current;
    if (earthDrag) {
      const layer = earthLayerRef.current;
      if (!layer) return;
      if (earthDrag.mode === 'horizontal') {
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
        const point = intersectPlane(ndc, earthDrag.plane);
        if (point && earthDrag.lastPoint) {
          const delta = { x: point.x - earthDrag.lastPoint.x, y: 0, z: point.z - earthDrag.lastPoint.z };
          layer.applyLocalOffset(delta);
          earthOffsetRef.current = {
            x: earthOffsetRef.current.x + delta.x,
            y: earthOffsetRef.current.y,
            z: earthOffsetRef.current.z + delta.z
          };
        }
        if (point) earthDrag.lastPoint = point;
      } else {
        const deltaY = (earthDrag.lastClientY - event.clientY) * earthDrag.heightPerPixel;
        layer.applyLocalOffset({ x: 0, y: deltaY, z: 0 });
        earthOffsetRef.current = { ...earthOffsetRef.current, y: earthOffsetRef.current.y + deltaY };
        earthDrag.lastClientY = event.clientY;
      }
      setEarthOffsetLabel(formatEarthOffset(earthOffsetRef.current));
      event.preventDefault();
      return;
    }
    const drag = dragRef.current;
    if (!drag) {
      updateHoverPoint(event);
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    if (!moved && !drag.moved) return;
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
    const target = dragTarget(event, ndc, drag);
    if (!target) return;
    updateTerrainReadout(target);
    if (!drag.moved) {
      propsRef.current.onBeginAnnotationEdit();
      drag.moved = true;
    }
    const delta = new THREE.Vector3(target.x - drag.currentAnchor[0], target.y - drag.currentAnchor[1], target.z - drag.currentAnchor[2]);
    const nextPositions: Record<string, [number, number, number]> = {};
    for (const id of drag.vertexIds) {
      const currentPosition = drag.currentPositions[id];
      nextPositions[id] = [currentPosition[0] + delta.x, currentPosition[1] + delta.y, currentPosition[2] + delta.z];
    }
    propsRef.current.onMoveVertices(nextPositions);
    drag.currentPositions = nextPositions;
    drag.currentAnchor = [target.x, target.y, target.z];
    event.preventDefault();
  }

  function onPointerLeave(event: PointerEvent) {
    clearHoverPoint();
    setTerrainReadout('');
    onPointerUp(event);
  }

  function onPointerUp(event: PointerEvent) {
    const earthDrag = earthDragRef.current;
    if (earthDrag) {
      const renderer = rendererRef.current;
      if (renderer) {
        try {
          renderer.domElement.releasePointerCapture(earthDrag.pointerId);
        } catch {
          // Pointer capture may already be released when leaving the canvas.
        }
      }
      controlsRef.current!.enabled = true;
      earthDragRef.current = null;
      propsRef.current.onStatus(`Earth shift: ${formatEarthOffset(earthOffsetRef.current)} — click Align again to lock.`);
      event.preventDefault();
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const renderer = rendererRef.current;
    if (renderer) {
      try {
        renderer.domElement.releasePointerCapture(drag.pointerId);
      } catch {
        // Pointer capture may already be released when leaving the canvas.
      }
    }
    controlsRef.current!.enabled = true;
    dragRef.current = null;

    if (drag.moved) {
      const result = propsRef.current.onFinishMoveVertices(drag.vertexIds);
      if (result.mergedCount > 0 && drag.kind === 'vertex') {
        propsRef.current.onStatus(`Merged ${drag.id} into ${result.canonicalIds[drag.id] ?? 'existing vertex'}`);
      } else if (result.mergedCount > 0) {
        propsRef.current.onStatus(`Moved ${drag.kind} ${drag.id}; merged ${result.mergedCount} coincident vertex${result.mergedCount === 1 ? '' : 'es'}`);
      } else {
        propsRef.current.onStatus(`Moved ${drag.kind} ${drag.id}`);
      }
      event.preventDefault();
      return;
    }
    if (drag.kind === 'vertex') addOrUseVertex(drag.id);
    event.preventDefault();
  }

  function onContextMenu(event: MouseEvent) {
    const current = propsRef.current;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (current.mode === 'select' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      return;
    }
    const selected = findNearestVertex(event.clientX, event.clientY, rect);
    if (selected) {
      event.preventDefault();
      current.onDeleteVertex(selected);
      current.onStatus(`Deleted ${selected}`);
      return;
    }
    if (current.mode === 'select') {
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
      const edgeSnap = findNearestAnnotationEdgeSnap(ndc, {});
      if (edgeSnap?.edge) {
        event.preventDefault();
        current.onDeleteEdge(edgeSnap.edge);
        current.onStatus(`Deleted edge ${edgeSnap.edge[0]} -> ${edgeSnap.edge[1]}`);
        return;
      }
      const faceIndex = findNearestFace(ndc);
      if (faceIndex !== null) {
        event.preventDefault();
        current.onDeleteFace(faceIndex);
        current.onStatus(`Deleted mesh face ${faceIndex + 1}`);
        return;
      }
    }
  }

  function addOrUseVertex(selected: string | null, ndc?: THREE.Vector2) {
    const current = propsRef.current;
    let id = selected;
    if (!id) {
      const hit = ndc ? placementHit(ndc) : null;
      if (!hit) {
        current.onStatus('No surface hit. Rotate or zoom toward the roof and try again.');
        return;
      }
      const { point, snap } = hit;
      if (current.mode === 'face') {
        current.onAddFaceVertex([point.x, point.y, point.z], snap?.edge ? { edge: snap.edge } : undefined);
        return;
      }
      id = current.onAddVertex([point.x, point.y, point.z], snap?.edge ? { edge: snap.edge } : undefined);
      if (snap?.kind === 'edge') current.onStatus(`Added ${id} on edge ${snap.edge?.[0]} -> ${snap.edge?.[1]}`);
      if (snap?.kind === 'face') current.onStatus(`Added ${id} on mesh face ${(snap.faceIndex ?? 0) + 1}`);
    }

    if (current.mode === 'vertex') {
      current.onStatus(`Added ${id}`);
      current.onModeChange('select');
      return;
    }
    if (current.mode === 'edge') {
      const previous = lastEdgeVertexRef.current;
      if (previous && previous !== id) {
        current.onAddEdge(previous, id);
        current.onStatus(`Added edge ${previous} -> ${id}`);
        lastEdgeVertexRef.current = null;
        current.onModeChange('select');
      } else {
        lastEdgeVertexRef.current = id;
        current.onStatus(`Edge start ${id}`);
      }
    }
    if (current.mode === 'face') {
      current.onDraftFace(id);
    }
  }

  function cameraFacingPlaneThrough(position: [number, number, number]): THREE.Plane {
    const camera = cameraRef.current;
    if (!camera) return new THREE.Plane(new THREE.Vector3(0, 1, 0), -position[1]);
    const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(...position));
  }

  function dragTarget(event: PointerEvent, ndc: THREE.Vector2, drag: DragState): THREE.Vector3 | null {
    if (event.shiftKey || event.altKey) {
      const mode = event.shiftKey ? 'horizontal' : 'height';
      if (drag.mode !== mode) startShiftLock(drag, event, mode);
      if (mode === 'height') {
        const deltaY = (drag.modeStartY - event.clientY) * drag.heightPerPixel;
        return new THREE.Vector3(drag.modeStartAnchor[0], drag.modeStartAnchor[1] + deltaY, drag.modeStartAnchor[2]);
      }
      const target = intersectPlane(ndc, drag.plane);
      return target ? new THREE.Vector3(target.x, drag.modeStartAnchor[1], target.z) : null;
    }
    if (drag.mode !== 'free') {
      drag.mode = 'free';
      drag.plane = cameraFacingPlaneThrough(drag.currentAnchor);
    }
    const excludedVertices = new Set(drag.vertexIds);
    return (
      (event.altKey ? intersectPointCloud(ndc) : null) ??
      (drag.kind === 'vertex' ? findNearestAnnotationVertexSnap(ndc, { excludeVertexIds: excludedVertices })?.point : null) ??
      findAnnotationSnap(ndc, { excludeVertexIds: excludedVertices })?.point ??
      intersectPlane(ndc, drag.plane)
    );
  }

  function startShiftLock(drag: DragState, event: PointerEvent, mode: 'height' | 'horizontal') {
    drag.mode = mode;
    drag.modeStartAnchor = drag.currentAnchor;
    drag.modeStartPositions = { ...drag.currentPositions };
    drag.modeStartY = event.clientY;
    drag.heightPerPixel = dragHeightPerPixel(drag.currentAnchor);
    if (mode === 'horizontal') {
      drag.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -drag.currentAnchor[1]);
    }
  }

  function dragHeightPerPixel(position: [number, number, number]): number {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    if (!camera || !renderer) return 0.03;
    const height = renderer.domElement.getBoundingClientRect().height || 800;
    const distance = camera.position.distanceTo(new THREE.Vector3(...position));
    return Math.max(0.005, distance / height);
  }

  function createFaceDrag(faceIndex: number, event: PointerEvent): DragState | null {
    const face = propsRef.current.annotations.faces[faceIndex];
    if (!face?.length) return null;
    const verticesById = new Map(propsRef.current.annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
    const vertexIds = [...new Set(face)].filter((id) => verticesById.has(id));
    if (!vertexIds.length) return null;
    const startPositions = Object.fromEntries(vertexIds.map((id) => [id, verticesById.get(id)!])) as Record<string, [number, number, number]>;
    const anchor = centroid(vertexIds.map((id) => startPositions[id]));
    return {
      kind: 'face',
      id: String(faceIndex + 1),
      vertexIds,
      mode: 'free',
      moved: false,
      plane: cameraFacingPlaneThrough(anchor),
      pointerId: event.pointerId,
      startPositions,
      currentPositions: startPositions,
      startX: event.clientX,
      startY: event.clientY,
      heightPerPixel: dragHeightPerPixel(anchor),
      currentAnchor: anchor,
      modeStartAnchor: anchor,
      modeStartPositions: startPositions,
      modeStartY: event.clientY
    };
  }

  function createEdgeDrag(edge: [string, string], event: PointerEvent): DragState | null {
    const verticesById = new Map(propsRef.current.annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
    const positions = {
      [edge[0]]: verticesById.get(edge[0]),
      [edge[1]]: verticesById.get(edge[1])
    };
    if (!positions[edge[0]] || !positions[edge[1]]) return null;
    const startPositions = positions as Record<string, [number, number, number]>;
    const anchor = centroid([startPositions[edge[0]], startPositions[edge[1]]]);
    return {
      kind: 'edge',
      id: `${edge[0]} -> ${edge[1]}`,
      vertexIds: edge,
      mode: 'free',
      moved: false,
      plane: cameraFacingPlaneThrough(anchor),
      pointerId: event.pointerId,
      startPositions,
      currentPositions: startPositions,
      startX: event.clientX,
      startY: event.clientY,
      heightPerPixel: dragHeightPerPixel(anchor),
      currentAnchor: anchor,
      modeStartAnchor: anchor,
      modeStartPositions: startPositions,
      modeStartY: event.clientY
    };
  }

  function intersectModel(ndc: THREE.Vector2): THREE.Vector3 | null {
    const camera = cameraRef.current;
    const root = sceneRef.current?.getObjectByName('modelRoot');
    if (!camera || !root) return null;
    const pointHit = intersectPointCloud(ndc);
    if (pointHit) return pointHit;
    return intersectTerrainSurface(ndc);
  }

  function intersectTerrainSurface(ndc: THREE.Vector2): THREE.Vector3 | null {
    const camera = cameraRef.current;
    const root = sceneRef.current?.getObjectByName('modelRoot');
    if (!camera || !root) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const mesh = terrainMeshRef.current;
    if (!mesh?.visible) return null;
    const hits = raycaster.intersectObject(mesh, false);
    return hits[0]?.point ?? null;
  }

  function intersectPointCloud(ndc: THREE.Vector2): THREE.Vector3 | null {
    return findNearestPointCloudHit(ndc)?.point ?? null;
  }

  function nearestPlacementSurfaceHit(ndc: THREE.Vector2): PlacementSurfaceHit | null {
    const camera = cameraRef.current;
    if (!camera) return null;

    const pointHit = findNearestPointCloudHit(ndc);
    const faceHit = findAnnotationFaceSurfaceHit(ndc);
    const terrainPoint = intersectTerrainSurface(ndc);
    const hits: PlacementSurfaceHit[] = [];

    if (pointHit) hits.push({ point: pointHit.point, distance: camera.position.distanceTo(pointHit.point), pointHit, source: 'point' });
    if (faceHit) hits.push(faceHit);
    if (terrainPoint) hits.push({ point: terrainPoint, distance: camera.position.distanceTo(terrainPoint), source: 'terrain' });

    return hits.sort((left, right) => left.distance - right.distance)[0] ?? null;
  }

  function foregroundSnapTolerance(distance: number): number {
    return Math.max(0.15, distance * 0.01);
  }

  function findNearestPointCloudHit(ndc: THREE.Vector2): PointHit | null {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const root = sceneRef.current?.getObjectByName('modelRoot');
    if (!camera || !renderer || !root) return null;
    const points = root.getObjectByName('pointCloud');
    if (!(points instanceof THREE.Points) || !points.visible) return null;

    const position = points.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position?.count) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const targetX = ((ndc.x + 1) / 2) * rect.width + rect.left;
    const targetY = ((-ndc.y + 1) / 2) * rect.height + rect.top;
    const radiusPx = Math.max(18, propsRef.current.settings.pointSize * 28);
    const radiusSq = radiusPx * radiusPx;
    const world = new THREE.Vector3();
    const projected = new THREE.Vector3();
    let bestIndex = -1;
    let bestDistanceSq = radiusSq;
    let bestCameraDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < position.count; index += 1) {
      world.fromBufferAttribute(position, index);
      points.localToWorld(world);
      projected.copy(world).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const x = ((projected.x + 1) / 2) * rect.width + rect.left;
      const y = ((-projected.y + 1) / 2) * rect.height + rect.top;
      const distanceSq = (x - targetX) ** 2 + (y - targetY) ** 2;
      const cameraDistance = camera.position.distanceToSquared(world);
      if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && cameraDistance < bestCameraDistance)) {
        bestIndex = index;
        bestDistanceSq = distanceSq;
        bestCameraDistance = cameraDistance;
      }
    }

    if (bestIndex < 0) return null;
    const point = new THREE.Vector3().fromBufferAttribute(position, bestIndex);
    points.localToWorld(point);
    return { index: bestIndex, point, points };
  }

  function setHoveredPointColor(points: THREE.Points, index: number) {
    const color = points.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!color || index < 0 || index >= color.count) return;
    const current = hoverPointRef.current;
    if (current?.points === points && current.index === index) return;

    clearHoverPoint();
    hoverPointRef.current = {
      points,
      index,
      color: [color.getX(index), color.getY(index), color.getZ(index)]
    };
    color.setXYZ(index, 1, 0.96, 0.24);
    color.needsUpdate = true;
  }

  function clearHoverPoint() {
    const current = hoverPointRef.current;
    if (current) {
      const color = current.points.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (color && current.index >= 0 && current.index < color.count) {
        color.setXYZ(current.index, current.color[0], current.color[1], current.color[2]);
        color.needsUpdate = true;
      }
      hoverPointRef.current = null;
    }
    clearHoverMarker();
  }

  function setHoverMarker(point: THREE.Vector3, color: string, label: string) {
    clearHoverMarker();
    const group = annotationGroupRef.current;
    if (!group) return;
    const geometry = new THREE.SphereGeometry(Math.max(propsRef.current.settings.pointSize * 1.35, 0.18), 12, 8);
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(point);
    marker.renderOrder = 40;
    marker.name = 'hoverSnapMarker';
    group.add(marker);
    hoverMarkerRef.current = marker;
    setHoverLabelText(label);
  }

  function clearHoverMarker() {
    const marker = hoverMarkerRef.current;
    if (marker) {
      marker.parent?.remove(marker);
      marker.geometry.dispose();
      const material = marker.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
      hoverMarkerRef.current = null;
    }
    setHoverLabelText('');
  }

  function setHoverLabelText(label: string) {
    if (hoverLabelRef.current === label) return;
    hoverLabelRef.current = label;
    setHoverLabel(label);
  }

  function updateTerrainReadout(point: THREE.Vector3 | null) {
    const sample = sampleTerrainAtLocalPoint(point);
    setTerrainReadout(sample ? `DTM ${sample.terrainZ.toFixed(2)} m · XY ${sample.worldX.toFixed(1)}, ${sample.worldY.toFixed(1)}` : '');
  }

  function sampleTerrainAtLocalPoint(point: THREE.Vector3 | null): { worldX: number; worldY: number; terrainZ: number } | null {
    const current = propsRef.current;
    const model = current.model;
    const raster = current.terrainRaster;
    const extent = current.terrainReference?.extent_lv95;
    if (!current.settings.showTerrain || !point || !model || !raster || !extent) return null;
    const [minX, minY, maxX, maxY] = extent;
    const worldX = model.center.x + point.x;
    const worldY = model.center.y - point.z;
    if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) return null;
    const col = ((worldX - minX) / (maxX - minX || 1)) * (raster.width - 1);
    const row = (1 - (worldY - minY) / (maxY - minY || 1)) * (raster.height - 1);
    const terrainZ = sampleRasterValue(raster, col, row);
    return terrainZ === null ? null : { worldX, worldY, terrainZ };
  }

  function updateHoverPoint(event: PointerEvent) {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const now = performance.now();
    if (now - hoverThrottleRef.current < 40) return;
    hoverThrottleRef.current = now;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
    const vertexId = findNearestVertex(event.clientX, event.clientY, rect);
    if (vertexId) {
      const vertex = propsRef.current.annotations.vertices.find((item) => item.id === vertexId);
      if (vertex) {
        clearHoverPoint();
        setHoverMarker(new THREE.Vector3(...vertex.position), '#ffd84d', `vertex ${vertexId}`);
        updateTerrainReadout(new THREE.Vector3(...vertex.position));
        return;
      }
    }
    const surfaceHit = nearestPlacementSurfaceHit(ndc);
    const edgeSnap = findNearestAnnotationEdgeSnap(ndc, {
      maxCameraDistance: surfaceHit ? surfaceHit.distance + foregroundSnapTolerance(surfaceHit.distance) : undefined
    });
    if (edgeSnap) {
      clearHoverPoint();
      setHoverMarker(edgeSnap.point, '#38bdf8', `edge ${edgeSnap.edge?.[0]} -> ${edgeSnap.edge?.[1]}`);
      updateTerrainReadout(edgeSnap.point);
      return;
    }
    const hit = surfaceHit?.source === 'point' ? surfaceHit.pointHit : null;
    if (hit) {
      clearHoverMarker();
      setHoveredPointColor(hit.points, hit.index);
      setHoverLabelText('LiDAR point');
      updateTerrainReadout(hit.point);
      return;
    }
    const faceHit = surfaceHit?.snap?.kind === 'face' ? surfaceHit.snap : null;
    if (faceHit) {
      clearHoverPoint();
      setHoverMarker(faceHit.point, '#38bdf8', typeof faceHit.faceIndex === 'number' ? `mesh face ${faceHit.faceIndex + 1}` : 'mesh face');
      updateTerrainReadout(faceHit.point);
      return;
    }
    updateTerrainReadout(intersectTerrainSurface(ndc));
    clearHoverPoint();
  }

  function intersectPlane(ndc: THREE.Vector2, plane: THREE.Plane): THREE.Vector3 | null {
    const camera = cameraRef.current;
    if (!camera) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  function findNearestVertex(clientX: number, clientY: number, rect: DOMRect): string | null {
    const camera = cameraRef.current;
    if (!camera) return null;
    const draftStartId = propsRef.current.mode === 'face' ? propsRef.current.faceDraft[0] : undefined;
    const draftStart = draftStartId
      ? propsRef.current.annotations.vertices.find((vertex) => vertex.id === draftStartId)
      : undefined;
    if (draftStart) {
      const screen = worldToClient(new THREE.Vector3(...draftStart.position), camera, rect);
      if (screen && Math.hypot(clientX - screen.x, clientY - screen.y) < 10) return draftStart.id;
    }

    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestCameraDistance = Number.POSITIVE_INFINITY;
    for (const vertex of propsRef.current.annotations.vertices) {
      const position = new THREE.Vector3(...vertex.position);
      const screen = worldToClient(position, camera, rect);
      if (!screen) continue;
      const distance = Math.hypot(clientX - screen.x, clientY - screen.y);
      const cameraDistance = camera.position.distanceToSquared(position);
      const closerOnScreen = distance < bestDistance - 0.5;
      const sameScreenPointButCloser = Math.abs(distance - bestDistance) <= 0.5 && cameraDistance < bestCameraDistance;
      if (distance < 14 && (closerOnScreen || sameScreenPointButCloser)) {
        bestId = vertex.id;
        bestDistance = distance;
        bestCameraDistance = cameraDistance;
      }
    }
    return bestId;
  }

  function findAnnotationSnap(ndc: THREE.Vector2, options: SnapOptions = {}): AnnotationSnap | null {
    return findNearestAnnotationEdgeSnap(ndc, options) ?? findAnnotationFaceHit(ndc);
  }

  function findNearestAnnotationVertexSnap(ndc: THREE.Vector2, options: SnapOptions): AnnotationSnap | null {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    if (!camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const target = ndcToClient(ndc, rect);
    const thresholdSq = 14 * 14;
    let best: AnnotationSnap | null = null;
    let bestDistanceSq = thresholdSq;
    let bestCameraDistance = Number.POSITIVE_INFINITY;

    for (const vertex of propsRef.current.annotations.vertices) {
      if (options.excludeVertexIds?.has(vertex.id)) continue;
      const point = new THREE.Vector3(...vertex.position);
      const screen = worldToClient(point, camera, rect);
      if (!screen) continue;
      const distanceSq = (target.x - screen.x) ** 2 + (target.y - screen.y) ** 2;
      const cameraDistance = camera.position.distanceToSquared(point);
      if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && cameraDistance < bestCameraDistance)) {
        bestDistanceSq = distanceSq;
        bestCameraDistance = cameraDistance;
        best = { kind: 'vertex', point, vertexId: vertex.id };
      }
    }
    return best;
  }

  function findNearestAnnotationEdgeSnap(ndc: THREE.Vector2, options: SnapOptions): AnnotationSnap | null {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    if (!camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const target = ndcToClient(ndc, rect);
    const verticesById = new Map(propsRef.current.annotations.vertices.map((vertex) => [vertex.id, vertex.position]));
    const edges = annotationEdgeCandidates();
    const thresholdSq = 12 * 12;
    let best: AnnotationSnap | null = null;
    let bestDistanceSq = thresholdSq;

    for (const edge of edges) {
      if (options.excludeVertexIds?.has(edge[0]) || options.excludeVertexIds?.has(edge[1])) continue;
      const a = verticesById.get(edge[0]);
      const b = verticesById.get(edge[1]);
      if (!a || !b) continue;
      const screenA = worldToClient(new THREE.Vector3(...a), camera, rect);
      const screenB = worldToClient(new THREE.Vector3(...b), camera, rect);
      if (!screenA || !screenB) continue;
      const closest = closestPointOnScreenSegment(target, screenA, screenB);
      const distanceSq = (target.x - closest.x) ** 2 + (target.y - closest.y) ** 2;
      if (distanceSq >= bestDistanceSq) continue;

      const point = new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), closest.t);
      if (options.maxCameraDistance !== undefined && camera.position.distanceTo(point) > options.maxCameraDistance) continue;
      bestDistanceSq = distanceSq;
      best = { kind: 'edge', point, edge };
    }

    return best;
  }

  function findAnnotationFaceHit(ndc: THREE.Vector2): AnnotationSnap | null {
    return findAnnotationFaceSurfaceHit(ndc)?.snap ?? null;
  }

  function findAnnotationFaceSurfaceHit(ndc: THREE.Vector2): PlacementSurfaceHit | null {
    const camera = cameraRef.current;
    const group = annotationGroupRef.current;
    if (!camera || !group) return null;
    const faces: THREE.Object3D[] = [];
    group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.name === 'annotationFace') faces.push(object);
    });
    if (!faces.length) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const hit = bestAnnotationFaceHit(raycaster.intersectObjects(faces, false));
    const faceIndex = typeof hit?.object.userData.faceIndex === 'number' ? hit.object.userData.faceIndex : undefined;
    return hit ? { point: hit.point, snap: { kind: 'face', point: hit.point, faceIndex }, distance: hit.distance, source: 'face' } : null;
  }

  function findNearestFace(ndc: THREE.Vector2): number | null {
    const hit = findAnnotationFaceHit(ndc);
    return typeof hit?.faceIndex === 'number' ? hit.faceIndex : null;
  }

  function annotationEdgeCandidates(): [string, string][] {
    const seen = new Set<string>();
    const edges: [string, string][] = [];
    const add = (a: string, b: string) => {
      if (a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push([a, b]);
    };

    for (const edge of propsRef.current.annotations.edges) add(edge[0], edge[1]);
    for (const face of propsRef.current.annotations.faces) {
      for (let index = 0; index < face.length; index += 1) add(face[index], face[(index + 1) % face.length]);
    }
    return edges;
  }

  function syncTerrainDisplay() {
    const root = sceneRef.current?.getObjectByName('modelRoot');
    const orthoSurface = root?.getObjectByName('orthoSurface');
    const dsmOrthoSurface = root?.getObjectByName('dsmOrthoSurface');
    const demWire = root?.getObjectByName('demWire');
    const showTerrain = propsRef.current.settings.showTerrain;
    if (orthoSurface) orthoSurface.visible = showTerrain && !showDrapedOrtho;
    if (dsmOrthoSurface) dsmOrthoSurface.visible = showTerrain && showDrapedOrtho;
    if (demWire) demWire.visible = showTerrain && showDrapedOrtho;
    terrainMeshRef.current =
      showTerrain
        ? (showDrapedOrtho && dsmOrthoSurface instanceof THREE.Mesh ? dsmOrthoSurface : null) ??
          (orthoSurface instanceof THREE.Mesh ? orthoSurface : null) ??
          null
        : null;
    if (!showTerrain) setTerrainReadout('');
  }

  function frameModel(model: SceneModel) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const width = model.worldBounds.maxX - model.worldBounds.minX || 40;
    const depth = model.worldBounds.maxY - model.worldBounds.minY || 40;
    const height = model.worldBounds.maxZ - model.worldBounds.minZ || 15;
    const radius = Math.max(width, depth, height * 2);
    controls.target.set(0, Math.max(2, height * 0.35), 0);
    camera.position.set(radius * 0.58, radius * 0.52, radius * 0.7);
    camera.near = 0.01;
    camera.far = Math.max(1000, radius * 18);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function applyViewPreset(model: SceneModel, kind: ViewPreset) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const width = model.worldBounds.maxX - model.worldBounds.minX || 40;
    const depth = model.worldBounds.maxY - model.worldBounds.minY || 40;
    const height = model.worldBounds.maxZ - model.worldBounds.minZ || 15;
    const radius = Math.max(width, depth, height * 2);
    const target = new THREE.Vector3(0, Math.max(2, height * 0.35), 0);
    controls.target.copy(target);
    camera.up.set(0, 1, 0);
    if (kind === 'top') {
      camera.up.set(0, 0, -1);
      camera.position.set(0, radius * 1.55, 0.001);
    } else if (kind === 'profile') {
      camera.position.set(radius * 1.35, target.y, 0);
    } else {
      camera.position.set(radius * 0.58, radius * 0.52, radius * 0.7);
    }
    camera.near = 0.01;
    camera.far = Math.max(1000, radius * 18);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function openGoogleEarth() {
    const model = propsRef.current.model;
    const houseBboxLv95 = propsRef.current.houseBboxLv95;
    if (!model) {
      propsRef.current.onStatus('Load a georeferenced model before opening Google Earth.');
      return;
    }

    const { worldX, worldY } = houseCenterWorldPoint(model, houseBboxLv95);
    const located = modelPointToWgs84(model, worldX, worldY);
    if (!located) {
      propsRef.current.onStatus('Google Earth: model has no usable georeference.');
      return;
    }
    const { lat, lon } = located;
    const url = `https://earth.google.com/web/search/${encodeURIComponent(`${lat.toFixed(7)},${lon.toFixed(7)}`)}`;

    window.open(url, '_blank', 'noopener,noreferrer');
    propsRef.current.onStatus(`Opened house center in Google Earth: ${lat.toFixed(7)}, ${lon.toFixed(7)}.`);
  }
}

function houseCenterWorldPoint(model: SceneModel, bboxLv95?: [number, number, number, number] | null): { worldX: number; worldY: number } {
  if (bboxLv95) {
    return {
      worldX: (bboxLv95[0] + bboxLv95[2]) / 2,
      worldY: (bboxLv95[1] + bboxLv95[3]) / 2
    };
  }

  const outline = model.buildingOutline;
  if (!outline?.rings.length) return { worldX: model.center.x, worldY: model.center.y };

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const ring of outline.rings) {
    for (const point of ring) {
      minX = Math.min(minX, point[0]);
      maxX = Math.max(maxX, point[0]);
      minZ = Math.min(minZ, point[2]);
      maxZ = Math.max(maxZ, point[2]);
      count += 1;
    }
  }

  return count
    ? {
        worldX: model.center.x + (minX + maxX) / 2,
        worldY: model.center.y - (minZ + maxZ) / 2
      }
    : { worldX: model.center.x, worldY: model.center.y };
}

function syncMeshTexture(material: THREE.MeshBasicMaterial, canvas: HTMLCanvasElement | undefined, owner: THREE.Object3D) {
  if (!canvas || owner.userData.textureCanvas === canvas) return;
  material.map?.dispose();
  material.map = createTexture(canvas) ?? null;
  owner.userData.textureCanvas = canvas;
}

function createPointGeometry(model: SceneModel, settings: ViewSettings, visibleClasses: Record<string, boolean>) {
  const sourceCount = model.positions.length / 3;
  const hasClassFilter = Boolean(model.classifications && Object.keys(visibleClasses).length);
  const keptIndices: number[] = [];
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    const classId = model.classifications?.[sourceIndex];
    if (!hasClassFilter || classId === undefined || visibleClasses[String(classId)] !== false) keptIndices.push(sourceIndex);
  }

  const positions = new Float32Array(keptIndices.length * 3);
  const colors = new Float32Array(keptIndices.length * 3);
  const [heightMin, heightMax] = visiblePointHeightRange(model, keptIndices);
  keptIndices.forEach((sourceIndex, targetIndex) => {
    const classId = model.classifications?.[sourceIndex];
    const tint = classId === undefined ? undefined : classColor(classId);
    const useClassColor = settings.pointColorMode === 'class';
    const height = model.positions[sourceIndex * 3 + 1] + (model.verticalOffset ?? 0);
    const visibleColor = settings.colorPointsByHeight
      ? pointHeightColor(height, heightMin, heightMax)
      : useClassColor && tint
        ? tint
        : enhancePointColor(pointPhotoColor(model, sourceIndex, settings.orthoOpacity));
    positions[targetIndex * 3] = model.positions[sourceIndex * 3];
    positions[targetIndex * 3 + 1] = model.positions[sourceIndex * 3 + 1];
    positions[targetIndex * 3 + 2] = model.positions[sourceIndex * 3 + 2];
    colors[targetIndex * 3] = visibleColor[0];
    colors[targetIndex * 3 + 1] = visibleColor[1];
    colors[targetIndex * 3 + 2] = visibleColor[2];
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

const POINT_HEIGHT_COLORS = ['#313695', '#2878b8', '#22a884', '#7ad151', '#fde725', '#d73027']
  .map((value) => new THREE.Color(value).toArray() as [number, number, number]);

function visiblePointHeightRange(model: SceneModel, indices: number[]): [number, number] {
  if (!indices.length) return [model.worldBounds.minZ, model.worldBounds.maxZ];
  const offset = model.verticalOffset ?? 0;
  const sampleStep = Math.max(1, Math.ceil(indices.length / 20_000));
  const heights: number[] = [];
  for (let item = 0; item < indices.length; item += sampleStep) {
    const height = model.positions[indices[item] * 3 + 1] + offset;
    if (Number.isFinite(height)) heights.push(height);
  }
  heights.sort((left, right) => left - right);
  if (!heights.length) return [model.worldBounds.minZ, model.worldBounds.maxZ];
  const low = heights[Math.floor((heights.length - 1) * 0.02)];
  const high = heights[Math.ceil((heights.length - 1) * 0.98)];
  return high - low > 1e-4 ? [low, high] : [heights[0], heights.at(-1)!];
}

function pointHeightColor(height: number, minHeight: number, maxHeight: number): [number, number, number] {
  const scaled = clamp((height - minHeight) / (maxHeight - minHeight || 1), 0, 1) * (POINT_HEIGHT_COLORS.length - 1);
  const index = Math.min(Math.floor(scaled), POINT_HEIGHT_COLORS.length - 2);
  const blend = scaled - index;
  const low = POINT_HEIGHT_COLORS[index];
  const high = POINT_HEIGHT_COLORS[index + 1];
  return [
    low[0] + (high[0] - low[0]) * blend,
    low[1] + (high[1] - low[1]) * blend,
    low[2] + (high[2] - low[2]) * blend
  ];
}

function pointPhotoColor(model: SceneModel, sourceIndex: number, blendValue: number): [number, number, number] {
  const raster = model.colorRaster;
  if (!raster) return [model.colors[sourceIndex * 3], model.colors[sourceIndex * 3 + 1], model.colors[sourceIndex * 3 + 2]];
  const z = model.positions[sourceIndex * 3 + 1] + (model.verticalOffset ?? 0);
  const base = colorFromHeight(z, model.worldBounds.minZ, model.worldBounds.maxZ);
  const draped = sampleRasterRgb(raster, model.uvs[sourceIndex * 2] * (raster.width - 1), (1 - model.uvs[sourceIndex * 2 + 1]) * (raster.height - 1));
  const blend = clamp(blendValue, 0, 1);
  return [
    base[0] * (1 - blend) + draped[0] * blend,
    base[1] * (1 - blend) + draped[1] * blend,
    base[2] * (1 - blend) + draped[2] * blend
  ];
}

function enhancePointColor(color: [number, number, number]): [number, number, number] {
  const lifted = color.map((channel) => clamp(channel * 1.22 + 0.08, 0, 1)) as [number, number, number];
  const avg = (lifted[0] + lifted[1] + lifted[2]) / 3;
  return lifted.map((channel) => clamp(avg + (channel - avg) * 1.2, 0, 1)) as [number, number, number];
}

function createTerrainOrthophotoGeometry(model: SceneModel, raster: RasterImage, terrainExtent: [number, number, number, number]) {
  const extent = modelExtent(model);
  const { cols, rows } = terrainGridSize(extent);
  return createOrthophotoGridGeometry(model, cols, rows, (worldX, worldY) => terrainLocalYAtWorldXY(model, raster, terrainExtent, worldX, worldY));
}

function createDsmOrthophotoGeometry(model: SceneModel, raster: RasterImage, terrainExtent: [number, number, number, number]) {
  const extent = modelExtent(model);
  const { cols, rows } = terrainGridSize(extent);
  const dsm = createDsmHeightGrid(model, raster, terrainExtent, extent, cols, rows);
  return createOrthophotoGridGeometry(model, cols, rows, (_worldX, _worldY, col, row) => dsm[row * (cols + 1) + col]);
}

function createOrthophotoGridGeometry(
  model: SceneModel,
  cols: number,
  rows: number,
  heightAt: (worldX: number, worldY: number, col: number, row: number) => number
) {
  const extent = modelExtent(model);
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((cols + 1) * (rows + 1) * 2);
  const indices = new Uint32Array(cols * rows * 6);
  let vertexOffset = 0;
  let uvOffset = 0;

  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    const worldY = extent[1] + (extent[3] - extent[1]) * v;
    for (let col = 0; col <= cols; col += 1) {
      const u = col / cols;
      const worldX = extent[0] + (extent[2] - extent[0]) * u;
      positions[vertexOffset] = worldX - model.center.x;
      positions[vertexOffset + 1] = heightAt(worldX, worldY, col, row);
      positions[vertexOffset + 2] = -(worldY - model.center.y);
      uvs[uvOffset] = u;
      uvs[uvOffset + 1] = v;
      vertexOffset += 3;
      uvOffset += 2;
    }
  }

  let indexOffset = 0;
  const stride = cols + 1;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const a = row * stride + col;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices[indexOffset] = a;
      indices[indexOffset + 1] = c;
      indices[indexOffset + 2] = b;
      indices[indexOffset + 3] = b;
      indices[indexOffset + 4] = c;
      indices[indexOffset + 5] = d;
      indexOffset += 6;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createDsmHeightGrid(
  model: SceneModel,
  raster: RasterImage,
  terrainExtent: [number, number, number, number],
  extent: [number, number, number, number],
  cols: number,
  rows: number
): Float32Array {
  const stride = cols + 1;
  const heights = new Float32Array(stride * (rows + 1));
  heights.fill(Number.NEGATIVE_INFINITY);
  const width = extent[2] - extent[0] || 1;
  const depth = extent[3] - extent[1] || 1;

  for (let index = 0; index < model.positions.length / 3; index += 1) {
    const localX = model.positions[index * 3];
    const localY = model.positions[index * 3 + 1];
    const localZ = model.positions[index * 3 + 2];
    const worldX = model.center.x + localX;
    const worldY = model.center.y - localZ;
    if (worldX < extent[0] || worldX > extent[2] || worldY < extent[1] || worldY > extent[3]) continue;
    const col = clamp(Math.round(((worldX - extent[0]) / width) * cols), 0, cols);
    const row = clamp(Math.round(((worldY - extent[1]) / depth) * rows), 0, rows);
    const gridIndex = row * stride + col;
    heights[gridIndex] = Math.max(heights[gridIndex], localY + 0.03);
  }

  const filled = new Float32Array(heights);
  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    const worldY = extent[1] + depth * v;
    for (let col = 0; col <= cols; col += 1) {
      const gridIndex = row * stride + col;
      if (Number.isFinite(filled[gridIndex])) continue;
      const neighborHeight = nearbyDsmHeight(heights, col, row, cols, rows);
      const worldX = extent[0] + width * (col / cols);
      filled[gridIndex] = neighborHeight ?? terrainLocalYAtWorldXY(model, raster, terrainExtent, worldX, worldY);
    }
  }

  return filled;
}

function nearbyDsmHeight(heights: Float32Array, col: number, row: number, cols: number, rows: number): number | null {
  const stride = cols + 1;
  for (let radius = 1; radius <= 3; radius += 1) {
    let best = Number.NEGATIVE_INFINITY;
    for (let y = Math.max(0, row - radius); y <= Math.min(rows, row + radius); y += 1) {
      for (let x = Math.max(0, col - radius); x <= Math.min(cols, col + radius); x += 1) {
        const height = heights[y * stride + x];
        if (Number.isFinite(height)) best = Math.max(best, height);
      }
    }
    if (Number.isFinite(best)) return best;
  }
  return null;
}

function createTerrainOrthoGridGeometry(model: SceneModel, raster: RasterImage, terrainExtent: [number, number, number, number]) {
  const extent = modelExtent(model);
  const { cols, rows } = terrainGridSize(extent);
  const positions: number[] = [];

  for (let col = 0; col <= cols; col += 1) {
    const u = col / cols;
    const worldX = extent[0] + (extent[2] - extent[0]) * u;
    for (let row = 0; row < rows; row += 1) {
      const worldY0 = extent[1] + (extent[3] - extent[1]) * (row / rows);
      const worldY1 = extent[1] + (extent[3] - extent[1]) * ((row + 1) / rows);
      positions.push(
        worldX - model.center.x,
        terrainLocalYAtWorldXY(model, raster, terrainExtent, worldX, worldY0) + 0.004,
        -(worldY0 - model.center.y),
        worldX - model.center.x,
        terrainLocalYAtWorldXY(model, raster, terrainExtent, worldX, worldY1) + 0.004,
        -(worldY1 - model.center.y)
      );
    }
  }

  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    const worldY = extent[1] + (extent[3] - extent[1]) * v;
    for (let col = 0; col < cols; col += 1) {
      const worldX0 = extent[0] + (extent[2] - extent[0]) * (col / cols);
      const worldX1 = extent[0] + (extent[2] - extent[0]) * ((col + 1) / cols);
      positions.push(
        worldX0 - model.center.x,
        terrainLocalYAtWorldXY(model, raster, terrainExtent, worldX0, worldY) + 0.004,
        -(worldY - model.center.y),
        worldX1 - model.center.x,
        terrainLocalYAtWorldXY(model, raster, terrainExtent, worldX1, worldY) + 0.004,
        -(worldY - model.center.y)
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function modelExtent(model: SceneModel): [number, number, number, number] {
  return model.extent ?? [model.worldBounds.minX, model.worldBounds.minY, model.worldBounds.maxX, model.worldBounds.maxY];
}

function terrainGridSize(extent: [number, number, number, number]): { cols: number; rows: number } {
  const width = Math.max(1, extent[2] - extent[0]);
  const depth = Math.max(1, extent[3] - extent[1]);
  const longest = Math.max(width, depth);
  const cols = clamp(Math.ceil((width / longest) * 80), 8, 96);
  const rows = clamp(Math.ceil((depth / longest) * 80), 8, 96);
  return { cols, rows };
}

function terrainLocalYAtWorldXY(
  model: SceneModel,
  raster: RasterImage,
  extent: [number, number, number, number],
  worldX: number,
  worldY: number
): number {
  const [minX, minY, maxX, maxY] = extent;
  const col = ((worldX - minX) / (maxX - minX || 1)) * (raster.width - 1);
  const row = (1 - (worldY - minY) / (maxY - minY || 1)) * (raster.height - 1);
  const terrainZ = sampleRasterValue(raster, col, row) ?? model.worldBounds.minZ;
  return terrainZ - (model.verticalOffset ?? 0);
}

function classColor(classId: number): [number, number, number] {
  if (classId === 1) return [0.32, 0.64, 1];
  if (classId === 2) return [0.92, 0.78, 0.42];
  if (classId === 3) return [0.16, 0.92, 0.42];
  if (classId === 4) return [0.24, 0.72, 0.24];
  if (classId === 5) return [0.05, 0.52, 0.14];
  if (classId === 6) return [1, 0.28, 0.18];
  if (classId === 9) return [0.16, 0.72, 0.95];
  return [0.86, 0.9, 0.96];
}

function formatEarthOffset(offset: { x: number; y: number; z: number }): string {
  return `ΔE ${offset.x.toFixed(2)} · ΔN ${(-offset.z).toFixed(2)} · ΔH ${offset.y.toFixed(2)} m`;
}

function earthButtonLabel(mode: EarthMode): string {
  if (mode === 'transparent') return '3D Earth: Transparent';
  if (mode === 'full') return '3D Earth: Full';
  return '3D Earth: Off';
}

function earthModeLabel(mode: EarthMode): string {
  if (mode === 'transparent') return 'transparent';
  if (mode === 'full') return 'full';
  return 'off';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ndcToClient(ndc: THREE.Vector2, rect: DOMRect): THREE.Vector2 {
  return new THREE.Vector2(((ndc.x + 1) / 2) * rect.width + rect.left, ((-ndc.y + 1) / 2) * rect.height + rect.top);
}

function worldToClient(point: THREE.Vector3, camera: THREE.Camera, rect: DOMRect): THREE.Vector2 | null {
  const projected = point.clone().project(camera);
  if (projected.z < -1 || projected.z > 1) return null;
  return ndcToClient(new THREE.Vector2(projected.x, projected.y), rect);
}

function closestPointOnScreenSegment(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): { x: number; y: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq > 0 ? clamp(((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSq, 0, 1) : 0;
  return {
    x: a.x + abx * t,
    y: a.y + aby * t,
    t
  };
}

function bestAnnotationFaceHit(hits: THREE.Intersection<THREE.Object3D>[]): THREE.Intersection<THREE.Object3D> | undefined {
  const nearestByFace = new Map<number, THREE.Intersection<THREE.Object3D>>();
  for (const hit of hits) {
    const faceIndex = hit.object.userData.faceIndex;
    if (typeof faceIndex !== 'number') continue;
    const existing = nearestByFace.get(faceIndex);
    if (!existing || hit.distance < existing.distance) nearestByFace.set(faceIndex, hit);
  }

  return [...nearestByFace.values()].sort((left, right) => {
    const distanceDelta = left.distance - right.distance;
    if (Math.abs(distanceDelta) > COPLANAR_FACE_HIT_EPS) return distanceDelta;

    const areaDelta = annotationFaceArea(left) - annotationFaceArea(right);
    if (areaDelta !== 0) return areaDelta;

    return left.object.userData.faceIndex - right.object.userData.faceIndex;
  })[0];
}

function annotationFaceArea(hit: THREE.Intersection<THREE.Object3D>): number {
  const area = hit.object.userData.faceArea;
  return typeof area === 'number' && Number.isFinite(area) && area > 0 ? area : Number.POSITIVE_INFINITY;
}

function sameEdge(a: AnnotationEdge, b: AnnotationEdge): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

function addBuildingOutlineLevelMarkers(group: THREE.Group, outline: BuildingOutline) {
  const topY = outline.heightExtent?.yMax ?? outline.rings[0]?.[0]?.[1];
  if (!Number.isFinite(topY)) return;
  const topRings = ringsAtY(outline.rings, topY);
  addLines(group, buildingOutlinePositions(topRings), '#22d3ee', 1, 'buildingOutlineTop', {
    depthTest: false,
    renderOrder: 12
  });

  if (outline.heightExtent) {
    const floorRings = ringsAtY(outline.rings, outline.heightExtent.yMin);
    addLines(group, buildingOutlinePositions(floorRings), '#f59e0b', 0.92, 'buildingOutlineFloor', {
      depthTest: false,
      renderOrder: 12
    });
    addLines(group, buildingOutlineVerticalPositions(floorRings, topRings), '#f8fafc', 0.38, 'buildingOutlineVerticalExtent', {
      depthTest: false,
      renderOrder: 11
    });
  }
}

function ringsAtY(rings: [number, number, number][][], y: number): [number, number, number][][] {
  return rings.map((ring) => ring.map(([x, , z]) => [x, y, z] as [number, number, number]));
}

function buildingOutlineVerticalPositions(
  floorRings: [number, number, number][][],
  topRings: [number, number, number][][]
): number[] {
  const positions: number[] = [];
  floorRings.forEach((floorRing, ringIndex) => {
    const topRing = topRings[ringIndex] ?? [];
    const count = Math.min(floorRing.length, topRing.length);
    const isClosed = count > 1 && floorRing[0][0] === floorRing[count - 1][0] && floorRing[0][2] === floorRing[count - 1][2];
    const limit = isClosed ? count - 1 : count;
    for (let index = 0; index < limit; index += 1) {
      positions.push(...floorRing[index], ...topRing[index]);
    }
  });
  return positions;
}

function buildingOutlinePositions(rings: [number, number, number][][]): number[] {
  const positions: number[] = [];
  for (const ring of rings) {
    const closed = ring.length > 1 && ring[0][0] === ring.at(-1)?.[0] && ring[0][2] === ring.at(-1)?.[2];
    const count = closed ? ring.length - 1 : ring.length;
    for (let index = 0; index < count; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % count];
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  return positions;
}

function addExportPreview(group: THREE.Group, annotations: AnnotationSet) {
  let mesh: ReturnType<typeof annotationsToTriangleMesh>;
  try {
    mesh = annotationsToTriangleMesh(annotations);
  } catch {
    return;
  }
  if (!mesh.vertices.length || !mesh.faces.length) return;

  const trianglePositions: number[] = [];
  const linePositions: number[] = [];
  for (const face of mesh.faces) {
    trianglePositions.push(...mesh.vertices[face[0]], ...mesh.vertices[face[1]], ...mesh.vertices[face[2]]);
    for (let index = 0; index < face.length; index += 1) {
      linePositions.push(...mesh.vertices[face[index]], ...mesh.vertices[face[(index + 1) % face.length]]);
    }
  }

  if (trianglePositions.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(trianglePositions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: '#22c55e',
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const surface = new THREE.Mesh(geometry, material);
    surface.name = 'exportMeshPreview';
    surface.renderOrder = 8;
    group.add(surface);
  }

  addLines(group, linePositions, '#86efac', 0.95, 'exportMeshPreviewEdges', { depthTest: false, renderOrder: 16 });
}

function undirectedEdgeKey([a, b]: AnnotationEdge): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function faceLabelPosition(points: [number, number, number][]): THREE.Vector3 {
  const center = centroid(points);
  const normal = faceNormal(points);
  return new THREE.Vector3(center[0], center[1], center[2]).add(new THREE.Vector3(...normal).multiplyScalar(0.12));
}

function faceArea(points: [number, number, number][]): number {
  if (points.length < 3) return 0;
  const origin = new THREE.Vector3(...points[0]);
  let area = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = new THREE.Vector3(...points[index]).sub(origin);
    const b = new THREE.Vector3(...points[index + 1]).sub(origin);
    area += a.cross(b).length() * 0.5;
  }
  return area;
}

function faceNormal(points: [number, number, number][]): [number, number, number] {
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = new THREE.Vector3(...points[index]).sub(new THREE.Vector3(...points[0]));
    const b = new THREE.Vector3(...points[index + 1]).sub(new THREE.Vector3(...points[0]));
    const normal = a.cross(b);
    if (normal.length() > 1e-6) {
      normal.normalize();
      return [normal.x, normal.y, normal.z];
    }
  }
  return [0, 1, 0];
}

function createTextSprite(text: string, color: string, background: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const fontSize = 28;
  const paddingX = 10;
  const paddingY = 6;
  const font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  if (!context) return new THREE.Sprite();
  context.font = font;
  const metrics = context.measureText(text);
  canvas.width = Math.ceil(metrics.width + paddingX * 2);
  canvas.height = fontSize + paddingY * 2;
  context.font = font;
  context.textBaseline = 'middle';
  context.fillStyle = background;
  roundRect(context, 0, 0, canvas.width, canvas.height, 6);
  context.fill();
  context.fillStyle = color;
  context.fillText(text, paddingX, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width / 125, canvas.height / 125, 1);
  sprite.renderOrder = 60;
  return sprite;
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function addLines(
  group: THREE.Group,
  positions: number[],
  color: string,
  opacity: number,
  name: string,
  options?: { depthTest?: boolean; renderOrder?: number }
) {
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: options?.depthTest ?? true });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = name;
  lines.renderOrder = options?.renderOrder ?? 0;
  group.add(lines);
}

function addAnnotationPointLayer(group: THREE.Group, positions: number[], color: string, size: number, name: string, renderOrder = 20) {
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const material = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: true,
    vertexColors: false,
    transparent: false,
    opacity: 1,
    depthTest: false,
    depthWrite: false
  });
  const points = new THREE.Points(geometry, material);
  points.name = name;
  points.renderOrder = renderOrder;
  group.add(points);
}

function centroid(points: [number, number, number][]): [number, number, number] {
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
    points.reduce((sum, point) => sum + point[2], 0) / points.length
  ];
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
}

function disposeObjectChildren(object: THREE.Object3D) {
  for (const child of [...object.children]) {
    object.remove(child);
    disposeObject(child);
  }
}

function disposeMaterial(material: THREE.Material) {
  const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
  map?.dispose();
  material.dispose();
}
