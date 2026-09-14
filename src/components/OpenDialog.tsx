import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, FolderOpen, Library, Map as MapIcon, X } from 'lucide-react';
import {
  hasSceneManifest,
  loadLooseScene,
  loadSceneBundle,
  pickDemFile,
  pickPointFile,
  sourceFromFiles,
  sourceFromLibrary,
  type LoadedSceneBundle,
  type SceneLibraryEntry
} from '../lib/sceneBundle';
import { isKnownCrs } from '../lib/geo';
import Modal from './Modal';

interface Props {
  visible: boolean;
  /** Files dropped onto the app shell; pre-fills the Files tab. */
  initialFiles?: File[] | null;
  onClose: () => void;
  onLoadBundle: (bundle: LoadedSceneBundle) => void;
}

type Tab = 'library' | 'files' | 'acquire';

const CRS_PRESETS = [
  { value: 'EPSG:2056', label: 'EPSG:2056 — Swiss LV95' },
  { value: 'EPSG:25832', label: 'EPSG:25832 — ETRS89 / UTM 32N' },
  { value: 'EPSG:32632', label: 'EPSG:32632 — WGS84 / UTM 32N' },
  { value: 'EPSG:31983', label: 'EPSG:31983 — SIRGAS 2000 / UTM 23S' },
  { value: 'EPSG:27700', label: 'EPSG:27700 — British National Grid' },
  { value: 'EPSG:2154', label: 'EPSG:2154 — France Lambert-93' },
  { value: '', label: 'Local coordinates (no georeference)' },
  { value: 'custom', label: 'Other EPSG / proj4 string…' }
];

export default function OpenDialog(props: Props) {
  const [tab, setTab] = useState<Tab>('library');
  const [library, setLibrary] = useState<SceneLibraryEntry[] | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [crsChoice, setCrsChoice] = useState('EPSG:2056');
  const [customCrs, setCustomCrs] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const folderPickerRef = useRef<HTMLInputElement | null>(null);
  const acquisitionFrameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!props.visible) return;
    setError('');
    setLoading(null);
    if (props.initialFiles?.length) {
      setFiles(props.initialFiles);
      setTab('files');
    }
    void refreshLibrary();
  }, [props.visible, props.initialFiles]);


  useEffect(() => {
    if (!props.visible) return;
    const onAcquired = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== acquisitionFrameRef.current?.contentWindow) return;
      if (event.data?.type !== 'building-data-acquired' || !Array.isArray(event.data.houses) || !event.data.houses.length) return;
      setLoading('acquire');
      setError('');
      void fetch('/api/scenes/acquired', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ houses: event.data.houses })
      }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || payload.detail || 'Could not prepare acquired scenes.');
        setLibrary(payload.scenes);
        setLibraryError('');
        if (payload.failures?.length) {
          setError(payload.failures.map((failure: { house: string; error: string }) => `${failure.house}: ${failure.error}`).join('; '));
        }
        setTab('library');
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setLoading(null));
    };
    window.addEventListener('message', onAcquired);
    return () => window.removeEventListener('message', onAcquired);
  }, [props.visible]);

  const collections = useMemo(() => {
    const grouped = new Map<string, SceneLibraryEntry[]>();
    for (const entry of library ?? []) {
      const list = grouped.get(entry.collection) ?? [];
      list.push(entry);
      grouped.set(entry.collection, list);
    }
    return [...grouped.entries()];
  }, [library]);

  const pointFile = useMemo(() => pickPointFile(files), [files]);
  const demFile = useMemo(() => pickDemFile(files), [files]);
  const filesHaveManifest = useMemo(() => hasSceneManifest(files), [files]);
  const effectiveCrs = crsChoice === 'custom' ? customCrs.trim() : crsChoice;
  const crsValid = effectiveCrs === '' || isKnownCrs(effectiveCrs);

  if (!props.visible) return null;

  return (
    <Modal title="Open data" className={tab === 'acquire' ? 'acquisitionDialog' : ''} onClose={props.onClose}>
        <header className="dialogHeader">
          <h2>Open data</h2>
          <button className="dialogClose" onClick={props.onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>

        <nav className="dialogTabs">
          <button aria-pressed={tab === 'acquire'} className={tab === 'acquire' ? 'active' : ''} onClick={() => setTab('acquire')}>
            <MapIcon size={15} />
            Acquire from map
          </button>
          <button aria-pressed={tab === 'library'} className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
            <Library size={15} />
            Scene library
          </button>
          <button aria-pressed={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            <FileUp size={15} />
            Your files
          </button>
        </nav>

        {tab === 'acquire' && (
          <div className="acquisitionBody">
            <iframe ref={acquisitionFrameRef} title="Select houses or an area to acquire" src="/acquire" />
            {loading === 'acquire' && <p className="dialogHint">Preparing point clouds for the scene library…</p>}
            {error && <p className="dialogError" role="alert">{error}</p>}
          </div>
        )}

        {tab === 'library' && (
          <div className="dialogBody">
            <p className="dialogHint">
              Open an acquired house or a portable scene bundle from your local scene library.
              Each house keeps its own annotations.
            </p>
            {libraryError && <p className="dialogError" role="alert">{libraryError}</p>}
            {error && <p className="dialogError" role="alert">{error}</p>}
            {library === null && !libraryError && <p className="dialogHint" role="status">Loading your scene library…</p>}
            {library && !library.length && !libraryError && (
              <div className="libraryEmpty">
                <h3>Start your first scene</h3>
                <p>Choose a building on the map, or open a point cloud from your computer.</p>
                <div className="emptyActions">
                  <button className="primaryButton" onClick={() => setTab('acquire')}>Acquire a building</button>
                  <button onClick={() => setTab('files')}>Open local files</button>
                </div>
              </div>
            )}
            <div className="sceneList">
              {collections.map(([collection, entries]) => (
                <section key={collection}>
                  <h3>{collection}</h3>
                  {entries.map((entry) => (
                    <button
                      key={entry.id}
                      className="sceneRow"
                      disabled={loading !== null}
                      onClick={() => void openLibraryEntry(entry)}
                    >
                      <span className="sceneRowName">
                        {entry.hasAnnotations ? '✓ ' : ''}
                        {entry.name}
                      </span>
                      <span className="sceneRowMeta">
                        {entry.crs ?? 'local'}
                      </span>
                      {loading === entry.id && <span className="sceneRowMeta">loading…</span>}
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}

        {tab === 'files' && (
          <div className="dialogBody">
            <div
              className={`dropZone${dragOver ? ' over' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                setFiles([...event.dataTransfer.files]);
                setError('');
              }}
            >
              <p>Drop a scene folder, or a point cloud (+ optional DEM GeoTIFF)</p>
              <p className="dialogHint">.las · .ply · .xyz · .csv points — .tif DEM — or a scene.json bundle</p>
              <div className="dropZoneActions">
                <button onClick={() => filePickerRef.current?.click()}>
                  <FileUp size={14} /> Pick files
                </button>
                <button onClick={() => folderPickerRef.current?.click()}>
                  <FolderOpen size={14} /> Pick folder
                </button>
              </div>
              <input
                ref={filePickerRef}
                hidden
                multiple
                type="file"
                onChange={(event) => {
                  setFiles([...(event.currentTarget.files ?? [])]);
                  setError('');
                }}
              />
              <input
                ref={folderPickerRef}
                hidden
                type="file"
                // @ts-expect-error webkitdirectory is non-standard but universally supported
                webkitdirectory=""
                onChange={(event) => {
                  setFiles([...(event.currentTarget.files ?? [])]);
                  setError('');
                }}
              />
            </div>

            {files.length > 0 && (
              <div className="fileSummary">
                {filesHaveManifest ? (
                  <p>
                    Scene bundle detected (<code>scene.json</code>) — CRS and DEM come from the manifest.
                  </p>
                ) : (
                  <>
                    <p>
                      Points: <strong>{pointFile?.name ?? 'none found'}</strong>
                      {demFile ? (
                        <>
                          {' '}
                          · DEM: <strong>{demFile.name}</strong>
                        </>
                      ) : (
                        ' · no DEM'
                      )}
                    </p>
                    <label className="crsRow">
                      <span>Coordinate system</span>
                      <select value={crsChoice} onChange={(event) => setCrsChoice(event.currentTarget.value)}>
                        {CRS_PRESETS.map((preset) => (
                          <option key={preset.label} value={preset.value}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {crsChoice === 'custom' && (
                      <input
                        className="crsInput"
                        placeholder="EPSG:32633 or +proj=… string"
                        value={customCrs}
                        onChange={(event) => setCustomCrs(event.currentTarget.value)}
                      />
                    )}
                    {!crsValid && <p className="dialogError" role="alert">Unknown CRS — use a bundled EPSG code, EPSG UTM code, or a proj4 string.</p>}
                    {effectiveCrs === '' && <p className="dialogHint">Without a georeference the Google 3D Earth layer stays off.</p>}
                  </>
                )}
              </div>
            )}

            {error && <p className="dialogError" role="alert">{error}</p>}
            <div className="dialogActions">
              <button
                className="primaryButton"
                disabled={loading !== null || !files.length || (!filesHaveManifest && (!pointFile || !crsValid))}
                onClick={() => void openPickedFiles()}
              >
                {loading === 'files' ? 'Loading…' : 'Load scene'}
              </button>
            </div>
          </div>
        )}

    </Modal>
  );

  async function refreshLibrary() {
    try {
      const response = await fetch('/api/scenes');
      if (!response.ok) throw new Error(`scene library unavailable (${response.status})`);
      const payload = (await response.json()) as { scenes: SceneLibraryEntry[] };
      setLibrary(payload.scenes);
      setLibraryError('');
    } catch {
      // Static deployments have no library API; the Files tab still works.
      setLibrary([]);
      setLibraryError('The scene library needs the local Python application server. Open point clouds or scene folders via "Your files" instead.');
      setTab((current) => (current === 'library' ? 'files' : current));
    }
  }

  async function openLibraryEntry(entry: SceneLibraryEntry) {
    setLoading(entry.id);
    setError('');
    try {
      const bundle = await loadSceneBundle(sourceFromLibrary(entry));
      props.onLoadBundle(bundle);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  async function openPickedFiles() {
    setLoading('files');
    setError('');
    try {
      const label = files.length === 1 ? files[0].name : 'picked files';
      const source = sourceFromFiles(files, label);
      const bundle = filesHaveManifest
        ? await loadSceneBundle(source)
        : await loadLooseScene(source, {
            pointsPath: pointFile!.name,
            demPath: demFile?.name,
            crs: effectiveCrs || undefined
          });
      props.onLoadBundle(bundle);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }
}
