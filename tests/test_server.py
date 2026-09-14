import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from label3d.server import create_app


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.delenv("LABEL3D_SCENE_ROOTS", raising=False)
    scene = tmp_path / "scenes" / "collection" / "house"
    scene.mkdir(parents=True)
    (scene / "scene.json").write_text(json.dumps({"schema": "label3d-scene-v1", "name": "House", "points": "points.xyz", "custom": {"preserve": True}}))
    (scene / "points.xyz").write_text("0 0 0\n1 1 1\n")
    client = TestClient(create_app(tmp_path, enable_acquisition=False))
    return client, scene, tmp_path


def test_save_reload_preserves_manifest_and_wip(setup):
    client, scene, _ = setup
    initial = client.get("/api/scenes").json()["scenes"][0]
    assert initial["hasAnnotations"] is False
    assert client.get(initial["baseUrl"] + "/points.xyz").text == "0 0 0\n1 1 1\n"
    annotations = {"vertices": [{"id": "v1"}], "faces": [], "edges": []}
    response = client.post("/api/scenes/save", json={"id": initial["id"], "annotationJson": json.dumps(annotations), "meshPly": "ply\n", "earthAlignment": {"de": 1, "dn": 2, "dh": 3}})
    assert response.status_code == 200
    manifest = json.loads((scene / "scene.json").read_text())
    assert manifest["custom"] == {"preserve": True}
    assert manifest["earth_alignment"] == {"de": 1, "dn": 2, "dh": 3}
    assert client.get(initial["baseUrl"] + "/annotations.json").json() == annotations
    assert client.get("/api/scenes").json()["scenes"][0]["hasAnnotations"] is True
    assert client.post("/api/scenes/save", json={"id": initial["id"], "meshPly": None}).status_code == 200
    assert not (scene / "mesh.ply").exists()
    assert (scene / "annotations.json").exists()


@pytest.mark.parametrize("scene_id", ["0/../escape", "0/collection/../../escape", "99/collection/house", "0//house", "0/collection\\house", "/etc"])
def test_rejects_traversal(setup, scene_id):
    client, _, _ = setup
    assert client.post("/api/scenes/save", json={"id": scene_id, "annotationJson": "{}"}).status_code == 400


@pytest.mark.parametrize("target", ["annotations.json", "mesh.ply", "scene.json"])
def test_rejects_output_symlinks_without_modifying_outside(setup, target):
    client, scene, root = setup
    outside = root / "outside.json"
    outside.write_text((scene / "scene.json").read_text() if target == "scene.json" else "outside")
    before = outside.read_bytes()
    (scene / target).unlink(missing_ok=True)
    (scene / target).symlink_to(outside)
    response = client.post("/api/scenes/save", json={"id": "0/collection/house", "annotationJson": "{}", "meshPly": None})
    assert response.status_code in (400, 404)
    assert outside.read_bytes() == before


def test_rejects_directory_and_input_symlinks(setup):
    client, scene, root = setup
    (root / "scenes" / "linked").symlink_to(scene, target_is_directory=True)
    assert len(client.get("/api/scenes").json()["scenes"]) == 1
    assert client.post("/api/scenes/save", json={"id": "0/linked", "annotationJson": "{}"}).status_code == 404
    (scene / "points.xyz").unlink()
    (scene / "points.xyz").symlink_to(root / "outside.txt")
    (root / "outside.txt").write_text("private")
    assert client.get("/api/scenes/files/0/collection/house/points.xyz").status_code == 404
    (scene / "private.txt").write_text("private")
    assert client.get("/api/scenes/files/0/collection/house/private.txt").status_code == 400


def test_rejects_bad_json_without_partial_save(setup):
    client, scene, _ = setup
    response = client.post("/api/scenes/save", json={"id": "0/collection/house", "annotationJson": "broken", "meshPly": "ply\n"})
    assert response.status_code == 400
    assert not (scene / "mesh.ply").exists()


def test_cross_origin_write_is_rejected(setup):
    client, _, _ = setup
    assert client.post("/api/scenes/save", json={}, headers={"Origin": "https://unrelated.example"}).status_code == 403


def test_acquisition_materializes_each_house_and_keeps_annotations(tmp_path, monkeypatch):
    monkeypatch.delenv("LABEL3D_SCENE_ROOTS", raising=False)
    class Store:
        calls = []
        def export_scene(self, house_id, scene_dir):
            self.calls.append(house_id)
            if (scene_dir / "scene.json").exists():
                return scene_dir / "scene.json"
            (scene_dir / "scene.json").write_text(json.dumps({"schema": "label3d-scene-v1", "name": house_id, "points": "points.xyz"}))
            (scene_dir / "points.xyz").write_text("0 0 0")
    store = Store()
    client = TestClient(create_app(tmp_path, enable_acquisition=False, acquisition_store=store))
    result = client.post("/api/scenes/acquired", json={"houses": ["house-1", "house-2"]})
    assert result.status_code == 200
    assert len(result.json()["scenes"]) == 2
    saved = client.post("/api/scenes/save", json={"id": "0/acquired/house-1", "annotationJson": '{"vertices":[1]}'})
    assert saved.status_code == 200
    assert client.post("/api/scenes/acquired", json={"houses": ["house-1", "house-2"]}).status_code == 200
    assert store.calls == ["house-1", "house-2", "house-1", "house-2"]
    assert client.get("/api/scenes").json()["scenes"][0]["hasAnnotations"] is True


def test_rejects_symlink_in_configured_root_ancestor(tmp_path, monkeypatch):
    monkeypatch.delenv("LABEL3D_SCENE_ROOTS", raising=False)
    real = tmp_path / "real"
    scene = real / "scenes" / "house"
    scene.mkdir(parents=True)
    (scene / "scene.json").write_text('{"schema":"label3d-scene-v1","points":"points.xyz"}')
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    client = TestClient(create_app(linked, enable_acquisition=False))
    assert client.get("/api/scenes").json()["scenes"] == []
    assert client.post("/api/scenes/save", json={"id": "0/house", "annotationJson": "{}"}).status_code == 404


def test_failed_house_does_not_hide_other_acquired_scenes(tmp_path, monkeypatch):
    monkeypatch.delenv("LABEL3D_SCENE_ROOTS", raising=False)
    class Store:
        def export_scene(self, house_id, scene_dir):
            if house_id == "bad-house":
                raise ValueError("No points in selected building")
            (scene_dir / "scene.json").write_text('{"schema":"label3d-scene-v1","points":"points.xyz"}')
    client = TestClient(create_app(tmp_path, enable_acquisition=False, acquisition_store=Store()))
    response = client.post("/api/scenes/acquired", json={"houses": ["bad-house", "good-house"]})
    assert response.status_code == 200
    assert response.json()["ids"] == ["0/acquired/good-house"]
    assert response.json()["failures"][0]["house"] == "bad-house"
    assert not list((tmp_path / "scenes" / "acquired").glob(".acquiring-*"))
