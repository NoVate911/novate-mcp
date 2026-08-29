from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path

from storage import LocalStorage, S3Storage, StorageError, create_storage


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.fail: str | None = None

    def _check(self, operation: str) -> None:
        if self.fail == operation:
            raise PermissionError(operation)

    def head_bucket(self, **kwargs): self._check("head"); return {}
    def put_object(self, **kwargs):
        self._check("put"); self.objects[kwargs["Key"]] = bytes(kwargs.get("Body", b"")); return {}
    def delete_object(self, **kwargs):
        self._check("delete"); self.objects.pop(kwargs["Key"], None); return {}
    def upload_file(self, filename, bucket, key):
        self._check("upload"); self.objects[key] = Path(filename).read_bytes()
    def download_file(self, bucket, key, filename):
        self._check("download"); Path(filename).write_bytes(self.objects[key])
    def copy_object(self, **kwargs):
        self._check("copy"); self.objects[kwargs["Key"]] = self.objects[kwargs["CopySource"]["Key"]]; return {}
    def delete_objects(self, **kwargs):
        self._check("delete")
        for item in kwargs["Delete"]["Objects"]: self.objects.pop(item["Key"], None)
        return {}
    def list_objects_v2(self, **kwargs):
        self._check("list")
        keys = sorted(key for key in self.objects if key.startswith(kwargs.get("Prefix", "")))
        start = int(kwargs.get("ContinuationToken", "0")); limit = kwargs.get("MaxKeys", 1000)
        page = keys[start:start + limit]
        result = {"Contents": [{"Key": key, "Size": len(self.objects[key])} for key in page],
                  "IsTruncated": start + limit < len(keys)}
        if result["IsTruncated"]: result["NextContinuationToken"] = str(start + limit)
        return result


def s3(root: Path, fake: FakeS3) -> S3Storage:
    return S3Storage(root, endpoint="https://s3.regru.cloud", access_key="access",
                     secret_key="secret", bucket="bucket", region="ru-1",
                     prefix="projects/", client=fake,
                     state_dir=root.parent / (root.name + "-state"),
                     reconcile_interval=30)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.fake = FakeS3()

    def tearDown(self):
        shutil.rmtree(self.root.parent / (self.root.name + "-state"), ignore_errors=True)
        self.tmp.cleanup()

    def test_local_mode_and_excludes(self):
        storage = create_storage(self.root, {"S3_ENABLED": "false"})
        self.assertIsInstance(storage, LocalStorage)
        (self.root / "app/node_modules/pkg").mkdir(parents=True)
        (self.root / "app/node_modules/pkg/a.js").write_text("x")
        (self.root / "app/main.py").write_text("ok")
        self.assertEqual(set(storage.snapshot()), {"app/main.py"})
        custom = LocalStorage(self.root, storage.excludes + ("dist/**",))
        (self.root / "app/dist/assets").mkdir(parents=True)
        (self.root / "app/dist/assets/bundle.js").write_text("built")
        self.assertNotIn("app/dist/assets/bundle.js", custom.snapshot())

    def test_validation_and_prefix(self):
        env = {"S3_ENABLED": "true"}
        with self.assertRaisesRegex(StorageError, "S3_ENDPOINT"):
            create_storage(self.root, env, client=self.fake)
        storage = s3(self.root, self.fake)
        self.assertEqual(storage.key("landing/index.html"), "projects/landing/index.html")
        with self.assertRaises(StorageError): storage.key("../secret")
        storage.validate()
        self.assertFalse(any("healthcheck" in key for key in self.fake.objects))

    def test_put_delete_recursive_move_and_error(self):
        storage = s3(self.root, self.fake)
        folder = self.root / "site/src"; folder.mkdir(parents=True)
        file = folder / "app.js"; file.write_bytes(b"hello")
        storage.put_file(file)
        self.assertEqual(self.fake.objects["projects/site/src/app.js"], b"hello")
        shutil.move(self.root / "site", self.root / "renamed")
        storage.move_path("site", "renamed", True)
        self.assertNotIn("projects/site/src/app.js", self.fake.objects)
        self.assertEqual(self.fake.objects["projects/renamed/src/app.js"], b"hello")
        storage.delete_path("renamed", True)
        self.assertFalse(self.fake.objects)
        file = self.root / "failed.txt"; file.write_text("not secret")
        self.fake.fail = "upload"
        with self.assertRaises(StorageError) as raised: storage.put_file(file)
        self.assertNotIn("secret", str(raised.exception).lower())

    def test_durable_outbox_survives_restart(self):
        storage = s3(self.root, self.fake)
        file = self.root / "queued.txt"; file.write_text("queued")
        self.fake.fail = "upload"
        with self.assertRaises(StorageError): storage.put_file(file)
        state = json.loads(storage.state_file.read_text())
        self.assertEqual(len(state["outbox"]), 1)
        self.fake.fail = None
        restarted = s3(self.root, self.fake)
        restarted.flush_outbox(force=True, raise_errors=True)
        self.assertEqual(self.fake.objects["projects/queued.txt"], b"queued")
        self.assertEqual(json.loads(restarted.state_file.read_text())["outbox"], [])
        status = json.loads(restarted.status_file.read_text())
        self.assertEqual(status["pending"], 0)
        self.assertEqual(status["connection"], "ok")

    def test_pending_delete_is_not_resurrected_on_restart(self):
        storage = s3(self.root, self.fake)
        file = self.root / "gone.txt"; file.write_text("gone")
        storage.put_file(file); file.unlink()
        self.fake.fail = "delete"
        with self.assertRaises(StorageError): storage.delete_path("gone.txt", False)
        self.fake.fail = None
        s3(self.root, self.fake).startup_merge()
        self.assertFalse(file.exists())
        self.assertNotIn("projects/gone.txt", self.fake.objects)

    def test_periodic_reconcile_repairs_and_recovers(self):
        storage = s3(self.root, self.fake)
        file = self.root / "app.txt"; file.write_text("v1")
        storage.put_file(file)
        file.write_text("version-two")
        result = storage.reconcile_now()
        self.assertGreaterEqual(result.uploaded, 1)
        self.assertEqual(self.fake.objects["projects/app.txt"], b"version-two")
        self.fake.objects["projects/from-cloud.txt"] = b"cloud"
        result = storage.reconcile_now()
        self.assertGreaterEqual(result.downloaded, 1)
        self.assertEqual((self.root / "from-cloud.txt").read_bytes(), b"cloud")
        file.unlink()
        result = storage.reconcile_now()
        self.assertGreaterEqual(result.deleted, 1)
        self.assertNotIn("projects/app.txt", self.fake.objects)

    def test_shell_delta_upload_and_delete(self):
        storage = s3(self.root, self.fake)
        before = storage.snapshot()
        (self.root / "test/src").mkdir(parents=True)
        (self.root / "test/src/index.js").write_text("hello")
        result = storage.sync_changes(before)
        self.assertEqual(result.uploaded, 1)
        self.assertIn("projects/test/src/index.js", self.fake.objects)
        before = storage.snapshot()
        (self.root / "test/src/index.js").unlink()
        result = storage.sync_changes(before)
        self.assertEqual(result.deleted, 1)
        self.assertNotIn("projects/test/src/index.js", self.fake.objects)

    def test_restart_and_safe_existing_local_merge(self):
        self.fake.objects["projects/cloud/index.html"] = b"cloud"
        self.fake.objects["projects/shared.txt"] = b"remote"
        (self.root / "local").mkdir(); (self.root / "local/file.txt").write_text("local")
        (self.root / "shared.txt").write_text("keep-local")
        storage = s3(self.root, self.fake)
        progress_events = []
        original_write_status = storage._write_status

        def capture_status(**updates):
            startup = updates.get("startup") or {}
            if startup.get("state") == "running":
                progress_events.append((startup.get("phase"), startup.get("current"), startup.get("total")))
            return original_write_status(**updates)

        storage._write_status = capture_status
        result = storage.startup_merge()
        self.assertTrue(any(phase == "merge" for phase, _, _ in progress_events))
        self.assertTrue(any(phase == "reconcile" for phase, _, _ in progress_events))
        self.assertEqual((self.root / "cloud/index.html").read_bytes(), b"cloud")
        self.assertEqual((self.root / "shared.txt").read_text(), "keep-local")
        self.assertEqual(self.fake.objects["projects/shared.txt"], b"keep-local")
        self.assertEqual(self.fake.objects["projects/local/file.txt"], b"local")
        self.assertGreaterEqual(result.conflicts, 1)
        shutil.rmtree(self.root / "cloud")
        (self.root / "shared.txt").unlink(); shutil.rmtree(self.root / "local")
        s3(self.root, self.fake).startup_merge()
        self.assertTrue((self.root / "cloud/index.html").is_file())


class SlowFakeS3(FakeS3):
    def __init__(self):
        super().__init__()
        self.upload_started = threading.Event()
        self.release_upload = threading.Event()
        self.slow_once = True

    def upload_file(self, filename, bucket, key):
        if self.slow_once:
            self.slow_once = False
            self.upload_started.set()
            if not self.release_upload.wait(5):
                raise TimeoutError("test upload gate")
        super().upload_file(filename, bucket, key)


class ConcurrentReconciliationTests(unittest.TestCase):
    def test_write_during_startup_reconciliation_is_serialized_and_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = SlowFakeS3()
            fake.objects["projects/shared.txt"] = b"remote"
            (root / "shared.txt").write_text("local-wins")
            storage = s3(root, fake)
            errors = []
            reconcile = threading.Thread(target=lambda: storage.startup_merge(), daemon=True)
            reconcile.start()
            self.assertTrue(fake.upload_started.wait(2), "startup merge did not reach upload")
            (root / "parallel.txt").write_text("parallel-write")
            writer = threading.Thread(
                target=lambda: self._write(storage, root / "parallel.txt", errors), daemon=True,
            )
            writer.start()
            self.assertTrue(writer.is_alive(), "write should wait on reconciliation lock")
            fake.release_upload.set()
            reconcile.join(5); writer.join(5)
            self.assertFalse(reconcile.is_alive())
            self.assertFalse(writer.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(fake.objects["projects/shared.txt"], b"local-wins")
            self.assertEqual(fake.objects["projects/parallel.txt"], b"parallel-write")
            status = json.loads(storage.status_file.read_text())
            self.assertEqual(status["startup"]["state"], "complete")

    @staticmethod
    def _write(storage, path, errors):
        try:
            storage.put_file(path)
        except Exception as exc:
            errors.append(exc)


class McpToolIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.import_root = tempfile.TemporaryDirectory()
        os.environ.update({"MCP_TOKEN": "test-token", "MCP_DATA_DIR": cls.import_root.name,
                           "CONFIG_DIR": cls.import_root.name, "S3_ENABLED": "false"})
        global server
        import server

    @classmethod
    def tearDownClass(cls): cls.import_root.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.fake = FakeS3(); self.storage = s3(self.root, self.fake)
        server.DATA_DIR = self.root; server.STORAGE = self.storage
        server.TASKS_DIR = self.root.parent / (self.root.name + "-tasks")
        server._tasks.clear(); server._task_sync.clear()

    def tearDown(self):
        shutil.rmtree(server.TASKS_DIR, ignore_errors=True); self.tmp.cleanup()

    def test_local_tool_regression(self):
        server.STORAGE = LocalStorage(self.root)
        server.write_file("local/index.html", "local")
        self.assertEqual(server.read_file("local/index.html"), "local")
        self.assertIn("[FILE] local/index.html", server.list_files())
        server.move_file("local/index.html", "local/app.html")
        self.assertIn("local/app.html", server.list_files())
        server.delete_file("local")
        self.assertEqual(server.list_files(), "(пусто)")

    def test_file_tools_and_path_traversal(self):
        server.write_file("test/index.html", "hello")
        self.assertEqual(server.read_file("test/index.html"), "hello")
        self.assertIn("[FILE] test/index.html", server.list_files())
        self.assertIn("test/index.html:1", server.search_in_files("hello"))
        server.move_file("test", "moved")
        self.assertIn("projects/moved/index.html", self.fake.objects)
        server.delete_file("moved")
        self.assertNotIn("projects/moved/index.html", self.fake.objects)
        with self.assertRaises(ValueError): server.write_file("../escape", "x")
        self.fake.objects["projects/remote.txt"] = b"remote"
        self.assertEqual(server.read_file("remote.txt"), "remote")
        self.fake.fail = "delete"
        with self.assertRaises(RuntimeError): server.delete_file("remote.txt")
        self.assertTrue((self.root / "remote.txt").is_file())

    def test_run_command_and_background(self):
        out = server.run_command("mkdir -p shell/src && printf hello > shell/src/index.js")
        self.assertIn("exit code: 0", out)
        self.assertEqual(self.fake.objects["projects/shell/src/index.js"], b"hello")
        server.run_command("rm shell/src/index.js")
        self.assertNotIn("projects/shell/src/index.js", self.fake.objects)
        answer = server.run_background("mkdir -p bg && printf done > bg/result.txt")
        task_id = answer.split()[1]
        for _ in range(100):
            status = server.poll_task(task_id)
            if "завершена" in status and "S3:" in status: break
            time.sleep(0.03)
        else: self.fail(status)
        self.assertEqual(self.fake.objects["projects/bg/result.txt"], b"done")


if __name__ == "__main__": unittest.main()
