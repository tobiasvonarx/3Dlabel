"""Local API and built React frontend, independent of any pipeline application."""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import tempfile
from threading import Lock

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .library import SceneLibrary

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MAX_BODY = 50_000_000


class AcquiredScenes(BaseModel):
    houses: list[str] = Field(min_length=1, max_length=10000)


def create_app(data_dir: Path | None = None, *, acquisition_store=None, enable_acquisition: bool = True) -> FastAPI:
    app = FastAPI(title="3Dlabel")
    root = (data_dir or Path(os.getenv("DATA_DIR", str(PROJECT_ROOT / "data")))).absolute()
    scenes_root = root / "scenes"
    scenes_root.mkdir(parents=True, exist_ok=True)
    roots = [scenes_root] + [Path(p).absolute() for p in os.getenv("LABEL3D_SCENE_ROOTS", "").split(os.pathsep) if p]
    library = SceneLibrary(roots)
    app.state.library = library
    save_lock = Lock()
    export_lock = Lock()

    if enable_acquisition:
        from building_data.api import mount_acquisition
        from building_data.store import AcquisitionStore
        acquisition_store = acquisition_store or AcquisitionStore(root / "acquisition", workers=int(os.getenv("WORKERS", "4")))
        mount_acquisition(app, acquisition_store)

    @app.middleware("http")
    async def same_origin_writes(request: Request, call_next):
        # Local service: browser writes must originate from this application.
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin:
                from urllib.parse import urlsplit
                if urlsplit(origin).netloc != request.headers.get("host"):
                    return JSONResponse({"error": "Cross-origin writes are not allowed"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def invalid_value(_request, error):
        return JSONResponse({"error": str(error)}, status_code=400)

    @app.exception_handler(OSError)
    async def inaccessible_file(_request, _error):
        return JSONResponse({"error": "Scene file is missing or inaccessible"}, status_code=404)

    @app.get("/api/config")
    def config():
        return {"googleCloudApiKey": os.getenv("GOOGLE_CLOUD_API_KEY", "")}

    @app.get("/api/health")
    def health():
        return {"status": "ok", "application": "3Dlabel"}

    @app.get("/api/scenes")
    def scenes():
        return {"scenes": library.list()}

    @app.post("/api/scenes/save")
    async def save(request: Request):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                raise HTTPException(413, "Save exceeds 50 MB")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("Save requires a JSON object")
        from starlette.concurrency import run_in_threadpool
        def write():
            with save_lock:
                return library.save(payload)
        return await run_in_threadpool(write)

    @app.post("/api/scenes/acquired")
    def acquired(payload: AcquiredScenes):
        if acquisition_store is None:
            raise HTTPException(503, "Acquisition is unavailable")
        result = []
        failures = []
        if any(not re.fullmatch(r"[A-Za-z0-9_-]+", house_id) for house_id in payload.houses):
            raise ValueError("Invalid house id")
        with export_lock:
            if any(path.is_symlink() for path in [scenes_root, *scenes_root.parents]):
                raise ValueError("Scene storage cannot contain symlink directories")
            acquired_root = scenes_root / "acquired"
            if acquired_root.is_symlink():
                raise ValueError("Acquired scene root cannot be a symlink")
            acquired_root.mkdir(exist_ok=True)
            for house_id in dict.fromkeys(payload.houses):
                try:
                    destination = acquired_root / house_id
                    if destination.is_symlink():
                        raise ValueError("Scene directory cannot be a symlink")
                    if not (destination / "scene.json").exists():
                        temporary = Path(tempfile.mkdtemp(prefix=".acquiring-", dir=acquired_root))
                        try:
                            acquisition_store.export_scene(house_id, temporary)
                            if not (temporary / "scene.json").is_file():
                                raise ValueError("Acquisition did not produce a scene manifest")
                            temporary.rename(destination)
                        finally:
                            if temporary.exists():
                                shutil.rmtree(temporary)
                            Path(str(temporary) + ".lock").unlink(missing_ok=True)
                    else:
                        # Shared export only backfills missing terrain in existing
                        # acquired bundles. Serialize its manifest update with saves.
                        with save_lock:
                            acquisition_store.export_scene(house_id, destination)
                    result.append(f"0/acquired/{house_id}")
                except (ValueError, OSError) as error:
                    failures.append({"house": house_id, "error": str(error)})
        return {"ids": result, "scenes": library.list(), "failures": failures}

    @app.get("/api/scenes/files/{asset_path:path}")
    def asset(asset_path: str):
        # Scene ids may contain nested collection paths, as may bundle assets.
        # Find the deepest existing scene prefix, then validate against manifest.
        components = asset_path.split("/")
        for index in range(len(components) - 1, 1, -1):
            scene_id = "/".join(components[:index])
            filename = "/".join(components[index:])
            try:
                with library.directory(scene_id) as fd:
                    library.manifest(fd)
            except (OSError, ValueError):
                continue
            data = library.asset(scene_id, filename)
            return Response(data, media_type=mimetypes.guess_type(filename)[0] or "application/octet-stream", headers={"Cache-Control": "no-store"})
        raise HTTPException(404, "Scene not found")

    dist = PROJECT_ROOT / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    else:
        @app.get("/")
        def missing_build():
            return Response("Build the frontend with pnpm install && pnpm run build, then restart label3d.", status_code=503)
    return app


def main():
    from building_data.runtime import launch
    launch("label3d.server:create_app", default_port=5003)
