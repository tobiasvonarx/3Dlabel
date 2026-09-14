"""Portable scene library with descriptor-relative, symlink-safe file access."""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
import re
import stat
from pathlib import Path
import uuid
from urllib.parse import quote

SCHEMA = "label3d-scene-v1"


def parts(value: str) -> list[str]:
    result = value.split("/")
    if not value or any(p in ("", ".", "..") or "\\" in p or "\x00" in p for p in result):
        raise ValueError("Invalid relative path")
    return result


class SceneLibrary:
    def __init__(self, roots: list[Path]):
        self.roots = [p.absolute() for p in roots]

    @contextmanager
    def directory(self, scene_id: str):
        components = parts(scene_id)
        if len(components) < 2 or not components[0].isdigit():
            raise ValueError("Invalid scene id")
        index = int(components[0])
        if index >= len(self.roots):
            raise ValueError("Invalid scene root")
        # Open each component independently. O_NOFOLLOW rejects symlinks even if
        # another local process replaces a directory between validation and use.
        fd = os.open(self.roots[index].anchor, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for component in [*self.roots[index].parts[1:], *components[1:]]:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            yield fd
        finally:
            os.close(fd)

    @staticmethod
    def read(fd: int, filename: str) -> bytes:
        components = parts(filename)
        current = os.dup(fd)
        try:
            for component in components[:-1]:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                os.close(current)
                current = next_fd
            file_fd = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
            with os.fdopen(file_fd, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("Scene assets must be regular files")
                return stream.read()
        finally:
            os.close(current)

    @staticmethod
    def write(fd: int, filename: str, content: str):
        # Replacing an existing link is never allowed, including dangling links.
        try:
            existing = os.stat(filename, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode):
                raise ValueError("Scene output must be a regular file")
        except FileNotFoundError:
            pass
        temporary = f".label3d-{uuid.uuid4().hex}.tmp"
        temp_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(temp_fd, "w", encoding="utf-8") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, filename, src_dir_fd=fd, dst_dir_fd=fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass

    def manifest(self, fd: int) -> dict:
        manifest = json.loads(self.read(fd, "scene.json"))
        if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
            raise ValueError("Not a label3d-scene-v1 bundle")
        return manifest

    def list(self) -> list[dict]:
        scenes = []
        for index, root in enumerate(self.roots):
            if root.is_symlink() or not root.is_dir():
                continue
            for directory, dirs, files in os.walk(root, followlinks=False):
                relative = Path(directory).relative_to(root)
                dirs[:] = [name for name in dirs if not name.startswith(".")]
                if len(relative.parts) >= 5:
                    dirs[:] = []
                if "scene.json" not in files or not relative.parts:
                    continue
                dirs[:] = []
                scene_id = f"{index}/{relative.as_posix()}"
                try:
                    with self.directory(scene_id) as fd:
                        manifest = self.manifest(fd)
                        has_annotations = False
                        if manifest.get("annotations"):
                            try:
                                annotation = json.loads(self.read(fd, manifest["annotations"]))
                                has_annotations = bool(annotation.get("vertices"))
                            except (OSError, ValueError, TypeError, AttributeError):
                                pass
                        scenes.append({
                            "id": scene_id,
                            "name": str(manifest.get("name", relative.name)),
                            "collection": str(manifest.get("collection", relative.parent.name or root.name)),
                            "crs": manifest.get("crs"),
                            "hasAnnotations": has_annotations,
                            "earthAlignment": manifest.get("earth_alignment"),
                            "baseUrl": f"/api/scenes/files/{quote(scene_id, safe='/')}",
                        })
                except (OSError, ValueError, TypeError):
                    continue
        def natural_key(entry):
            return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", f'{entry["collection"]}/{entry["name"]}')]
        return sorted(scenes, key=natural_key)

    def asset(self, scene_id: str, filename: str) -> bytes:
        with self.directory(scene_id) as fd:
            manifest = self.manifest(fd)
            allowed = {"scene.json", "annotations.json", "mesh.ply"}
            allowed.update(v for k, v in manifest.items() if k in {"points", "dem", "building_outline", "annotations"} and isinstance(v, str))
            if filename not in allowed:
                raise ValueError("File is not part of this scene bundle")
            return self.read(fd, filename)

    def save(self, payload: dict) -> dict:
        scene_id = str(payload.get("id", ""))
        with self.directory(scene_id) as fd:
            manifest = self.manifest(fd)
            annotation = payload.get("annotationJson")
            mesh = payload.get("meshPly")
            alignment = payload.get("earthAlignment")
            if annotation is not None:
                if not isinstance(annotation, str) or not annotation.strip():
                    raise ValueError("annotationJson must be nonempty JSON text")
                if not isinstance(json.loads(annotation), dict):
                    raise ValueError("Annotations must be a JSON object")
            if mesh is not None and not isinstance(mesh, str):
                raise ValueError("meshPly must be text or null")
            if alignment is not None:
                if not isinstance(alignment, dict) or not all(type(alignment.get(key)) in (float, int) and math.isfinite(alignment[key]) for key in ("de", "dn", "dh")):
                    raise ValueError("Earth alignment must contain finite de, dn, dh numbers")
            # Validate all output targets before changing any files.
            for filename in ("scene.json", "annotations.json", "mesh.ply"):
                try:
                    if not stat.S_ISREG(os.stat(filename, dir_fd=fd, follow_symlinks=False).st_mode):
                        raise ValueError("Scene outputs must be regular files")
                except FileNotFoundError:
                    pass
            written = []
            if annotation is not None:
                self.write(fd, "annotations.json", annotation)
                manifest["annotations"] = "annotations.json"
                written.append("annotations.json")
            if isinstance(mesh, str) and mesh.strip():
                self.write(fd, "mesh.ply", mesh)
                written.append("mesh.ply")
            elif "meshPly" in payload and mesh is None:
                try:
                    os.unlink("mesh.ply", dir_fd=fd)
                except FileNotFoundError:
                    pass
                written.append("mesh.ply:removed")
            if alignment is not None:
                manifest["earth_alignment"] = {key: alignment[key] for key in ("de", "dn", "dh")}
                written.append("earth_alignment")
            if annotation is not None or alignment is not None:
                self.write(fd, "scene.json", json.dumps(manifest, indent=2) + "\n")
            return {"sceneDir": scene_id, "written": written}
