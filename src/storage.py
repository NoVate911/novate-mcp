"""Постоянное хранилище проектов: локальный режим или S3 поверх локальной /data.

S3 никогда не монтируется как файловая система. Инструменты и shell работают с
обычной POSIX /data, а этот слой переносит только изменившиеся файлы.
"""

from __future__ import annotations

import fnmatch
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Mapping, Protocol
from urllib.parse import urlparse

FileState = tuple[int, int]
Snapshot = dict[str, FileState]

MANDATORY_EXCLUDES = (
    "node_modules", ".git", ".cache", "tmp", "__pycache__",
    "*.pyc", "*.log", ".backup-now", ".s3-sync-needed", ".novate-*",
)


class StorageError(RuntimeError):
    """Безопасная для показа ошибка storage без credentials."""


class S3Client(Protocol):
    def head_bucket(self, **kwargs): ...
    def list_objects_v2(self, **kwargs): ...
    def put_object(self, **kwargs): ...
    def delete_object(self, **kwargs): ...
    def delete_objects(self, **kwargs): ...
    def upload_file(self, filename: str, bucket: str, key: str): ...
    def download_file(self, bucket: str, key: str, filename: str): ...
    def copy_object(self, **kwargs): ...


@dataclass(frozen=True)
class SyncResult:
    uploaded: int = 0
    deleted: int = 0
    downloaded: int = 0
    conflicts: int = 0

    def describe(self) -> str:
        return (
            f"загружено: {self.uploaded}, удалено: {self.deleted}, "
            f"скачано: {self.downloaded}, сохранено локальных конфликтов: {self.conflicts}"
        )


class Storage:
    enabled = False

    def __init__(self, root: Path, excludes: tuple[str, ...] = MANDATORY_EXCLUDES):
        self.root = root.resolve()
        self.excludes = excludes
        self._lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True)

    def is_excluded(self, rel: str) -> bool:
        value = rel.replace("\\", "/").strip("/")
        parts = PurePosixPath(value).parts
        for pattern in self.excludes:
            pattern = pattern.strip().strip("/")
            if not pattern:
                continue
            if "/" not in pattern and not any(c in pattern for c in "*?["):
                if pattern in parts:
                    return True
            elif (
                fnmatch.fnmatch(value, pattern)
                or any(fnmatch.fnmatch(part, pattern) for part in parts)
                or any(fnmatch.fnmatch("/".join(parts[index:]), pattern)
                       for index in range(len(parts)))
            ):
                return True
        return False

    def relative(self, path: Path) -> str:
        resolved = path.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise StorageError("путь выходит за пределы /data")
        return resolved.relative_to(self.root).as_posix()

    def snapshot(self) -> Snapshot:
        result: Snapshot = {}
        if not self.root.is_dir():
            return result
        for path in self.root.rglob("*"):
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                rel = path.relative_to(self.root).as_posix()
                if self.is_excluded(rel):
                    continue
                stat = path.stat()
                result[rel] = (stat.st_size, stat.st_mtime_ns)
            except OSError:
                continue
        return result

    def put_file(self, path: Path) -> None:
        return None

    def delete_path(self, rel: str, is_directory: bool) -> None:
        return None

    def move_path(self, src: str, dst: str, is_directory: bool) -> None:
        return None

    def sync_changes(self, before: Snapshot) -> SyncResult:
        return SyncResult()

    def fetch_if_missing(self, rel: str) -> bool:
        return False

    def startup_merge(self) -> SyncResult:
        return SyncResult()


class LocalStorage(Storage):
    """Текущее поведение: /data на bind mount, без внешней синхронизации."""


class S3StorageCore(Storage):
    enabled = True

    def __init__(
        self,
        root: Path,
        *,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        region: str,
        prefix: str = "projects/",
        excludes: tuple[str, ...] = MANDATORY_EXCLUDES,
        client: S3Client | None = None,
    ):
        super().__init__(root, excludes)
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise StorageError("S3_ENDPOINT должен быть полным http(s)-адресом")
        if parsed.username or parsed.password:
            raise StorageError("S3_ENDPOINT не должен содержать credentials")
        clean_prefix = prefix.replace("\\", "/").strip("/")
        if not clean_prefix or any(part in {".", ".."} for part in clean_prefix.split("/")):
            raise StorageError("S3_PREFIX должен быть непустым безопасным префиксом")
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.region = region
        self.prefix = clean_prefix + "/"
        if client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as exc:
                raise StorageError("для S3 не установлен boto3") from exc
            client = boto3.client(
                "s3",
                endpoint_url=self.endpoint,
                aws_access_key_id=access_key,
                aws_secret_access_key=secret_key,
                region_name=region,
                config=Config(
                    signature_version="s3v4",
                    retries={"max_attempts": 4, "mode": "standard"},
                    connect_timeout=10,
                    read_timeout=90,
                    s3={"addressing_style": "path"},
                ),
            )
        self.client = client

    def _error_code(self, exc: Exception) -> str:
        try:
            code = exc.response.get("Error", {}).get("Code")  # type: ignore[attr-defined]
            if code:
                return str(code)
        except Exception:
            pass
        return type(exc).__name__

    def _call(self, action: str, func, *args, **kwargs):
        try:
            return func(*args, **kwargs)
        except StorageError:
            raise
        except Exception as exc:
            raise StorageError(f"{action}: ошибка S3 ({self._error_code(exc)})") from exc

    def key(self, rel: str) -> str:
        value = rel.replace("\\", "/").strip("/")
        parts = PurePosixPath(value).parts
        if not value or any(part in {"", ".", ".."} for part in parts):
            raise StorageError("некорректный относительный путь S3")
        return self.prefix + "/".join(parts)

    def rel_from_key(self, key: str) -> str | None:
        if not key.startswith(self.prefix):
            return None
        rel = key[len(self.prefix):].strip("/")
        if not rel or any(part in {".", ".."} for part in PurePosixPath(rel).parts):
            return None
        return rel

    def _local_path(self, rel: str) -> Path:
        parts = PurePosixPath(rel).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise StorageError("небезопасный путь объекта S3")
        target = self.root.joinpath(*parts)
        parent = target.parent.resolve()
        if parent != self.root and self.root not in parent.parents:
            raise StorageError("путь объекта S3 выходит за пределы /data")
        return target

    def _objects(self, prefix: str | None = None) -> list[dict]:
        result: list[dict] = []
        token: str | None = None
        while True:
            args: dict = {"Bucket": self.bucket, "Prefix": prefix or self.prefix, "MaxKeys": 1000}
            if token:
                args["ContinuationToken"] = token
            page = self._call("получение списка объектов", self.client.list_objects_v2, **args)
            result.extend(page.get("Contents", []))
            if not page.get("IsTruncated"):
                return result
            token = page.get("NextContinuationToken")
            if not token:
                raise StorageError("S3 вернул неполный список без continuation token")

    def validate(self) -> None:
        with self._lock:
            self._call("проверка bucket", self.client.head_bucket, Bucket=self.bucket)
            self._call(
                "проверка списка объектов", self.client.list_objects_v2,
                Bucket=self.bucket, Prefix=self.prefix, MaxKeys=1,
            )
            key = self.prefix + f".novate-healthcheck-{uuid.uuid4().hex}"
            self._call("проверка записи", self.client.put_object, Bucket=self.bucket, Key=key, Body=b"")
            self._call("проверка удаления", self.client.delete_object, Bucket=self.bucket, Key=key)

    def put_file(self, path: Path) -> None:
        rel = self.relative(path)
        if self.is_excluded(rel) or path.is_symlink() or not path.is_file():
            return
        with self._lock:
            self._call("загрузка файла", self.client.upload_file, str(path), self.bucket, self.key(rel))

    def _delete_keys(self, keys: list[str]) -> int:
        deleted = 0
        for start in range(0, len(keys), 1000):
            chunk = keys[start:start + 1000]
            if not chunk:
                continue
            self._call(
                "удаление объектов", self.client.delete_objects,
                Bucket=self.bucket, Delete={"Objects": [{"Key": key} for key in chunk], "Quiet": True},
            )
            deleted += len(chunk)
        return deleted

    def delete_path(self, rel: str, is_directory: bool) -> None:
        if self.is_excluded(rel):
            return
        with self._lock:
            if is_directory:
                keys = [obj["Key"] for obj in self._objects(self.key(rel) + "/")]
                self._delete_keys(keys)
            else:
                self._call("удаление файла", self.client.delete_object, Bucket=self.bucket, Key=self.key(rel))

    def move_path(self, src: str, dst: str, is_directory: bool) -> None:
        src_excluded, dst_excluded = self.is_excluded(src), self.is_excluded(dst)
        with self._lock:
            if src_excluded and dst_excluded:
                return
            if src_excluded:
                target = self._local_path(dst)
                paths = target.rglob("*") if is_directory else [target]
                for path in paths:
                    if path.is_file() and not path.is_symlink():
                        self.put_file(path)
                return
            if dst_excluded:
                self.delete_path(src, is_directory)
                return
            if is_directory:
                old_prefix = self.key(src) + "/"
                objects = self._objects(old_prefix)
                copied: list[str] = []
                try:
                    for obj in objects:
                        suffix = obj["Key"][len(old_prefix):]
                        new_key = self.key(dst) + "/" + suffix
                        self._call(
                            "копирование объекта", self.client.copy_object,
                            Bucket=self.bucket, Key=new_key,
                            CopySource={"Bucket": self.bucket, "Key": obj["Key"]},
                        )
                        copied.append(new_key)
                    self._delete_keys([obj["Key"] for obj in objects])
                except StorageError:
                    # Best effort rollback: исходники удаляются только после всех copy.
                    try:
                        self._delete_keys(copied)
                    except StorageError:
                        pass
                    raise
            else:
                new_key = self.key(dst)
                self._call(
                    "копирование файла", self.client.copy_object,
                    Bucket=self.bucket, Key=new_key,
                    CopySource={"Bucket": self.bucket, "Key": self.key(src)},
                )
                try:
                    self._call("удаление исходного файла", self.client.delete_object,
                               Bucket=self.bucket, Key=self.key(src))
                except StorageError:
                    try:
                        self._call("откат копирования", self.client.delete_object,
                                   Bucket=self.bucket, Key=new_key)
                    except StorageError:
                        pass
                    raise

    def sync_changes(self, before: Snapshot) -> SyncResult:
        with self._lock:
            after = self.snapshot()
            changed = [rel for rel, state in after.items() if before.get(rel) != state]
            removed = [rel for rel in before if rel not in after]
            for rel in changed:
                self.put_file(self._local_path(rel))
            self._delete_keys([self.key(rel) for rel in removed])
            return SyncResult(uploaded=len(changed), deleted=len(removed))

    def fetch_if_missing(self, rel: str) -> bool:
        if self.is_excluded(rel):
            return False
        key = self.key(rel)
        remote = {obj["Key"] for obj in self._objects(key)}
        if key not in remote:
            return False
        target = self._local_path(rel)
        if target.exists():
            return target.is_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + f".novate-{uuid.uuid4().hex}.tmp")
        try:
            self._call("скачивание файла", self.client.download_file,
                       self.bucket, key, str(temp))
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        return True

    def startup_merge(self, progress=None) -> SyncResult:
        """Безопасное объединение без удаления локальных файлов и с прогрессом."""
        with self._lock:
            remote = {
                rel: obj for obj in self._objects()
                if (rel := self.rel_from_key(str(obj.get("Key", ""))))
                and not self.is_excluded(rel)
            }
            local = self.snapshot()
            total = max(len(remote) + len(local), 1)
            processed = downloaded = conflicts = uploaded = 0
            if progress:
                progress("merge", processed, total)
            for rel, obj in remote.items():
                target = self._local_path(rel)
                if target.exists() or target.is_symlink():
                    conflicts += 1
                    # Локальная рабочая копия приоритетна и остаётся доступной агентам.
                    if target.is_file() and not target.is_symlink():
                        self.put_file(target)
                        uploaded += 1
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temp = target.with_name(target.name + f".novate-{uuid.uuid4().hex}.tmp")
                    try:
                        self._call("восстановление файла", self.client.download_file,
                                   self.bucket, obj["Key"], str(temp))
                        os.replace(temp, target)
                        downloaded += 1
                    finally:
                        temp.unlink(missing_ok=True)
                processed += 1
                if progress:
                    progress("merge", processed, total)
            for rel in local:
                if rel not in remote:
                    self.put_file(self._local_path(rel))
                    uploaded += 1
                processed += 1
                if progress:
                    progress("merge", processed, total)
            return SyncResult(uploaded=uploaded, downloaded=downloaded, conflicts=conflicts)



class S3Storage(S3StorageCore):
    """S3 backend с постоянным outbox, manifest и периодической сверкой."""

    def __init__(self, *args, state_dir: Path | None = None,
                 reconcile_interval: int = 600, **kwargs):
        super().__init__(*args, **kwargs)
        self.state_dir = (state_dir or (self.root / ".novate-state")).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.state_dir.chmod(0o700)
        except OSError:
            pass
        self.state_file = self.state_dir / "s3-state.json"
        self.status_file = self.state_dir / "status.json"
        self.reconcile_interval = max(int(reconcile_interval), 30)
        self._state = self._load_state()
        self._write_status(connection="initializing")

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _load_state(self) -> dict:
        if not self.state_file.exists():
            return {"version": 1, "outbox": [], "manifest": {}}
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            if (not isinstance(data, dict) or data.get("version") != 1
                    or not isinstance(data.get("outbox", []), list)
                    or not isinstance(data.get("manifest", {}), dict)):
                raise ValueError("invalid schema")
            data.setdefault("outbox", [])
            data.setdefault("manifest", {})
            return data
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise StorageError(
                "постоянное состояние S3 повреждено; проверь /storage-state/s3-state.json"
            ) from exc

    @staticmethod
    def _atomic_json(path: Path, data: dict) -> None:
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            temp.chmod(0o600)
        except OSError:
            pass
        os.replace(temp, path)

    def _save_state(self) -> None:
        self._atomic_json(self.state_file, self._state)

    def _write_status(self, **updates) -> None:
        try:
            current = json.loads(self.status_file.read_text(encoding="utf-8"))
            if not isinstance(current, dict):
                current = {}
        except Exception:
            current = {}
        current.update({
            "enabled": True,
            "endpoint": self.endpoint,
            "bucket": self.bucket,
            "region": self.region,
            "prefix": self.prefix,
            "pending": len(self._state.get("outbox", [])),
            "updated_at": self._now(),
        })
        current.update(updates)
        self._atomic_json(self.status_file, current)

    def _queue(self, action: str, path: str, *, is_directory: bool = False,
               destination: str = "", persist: bool = True) -> str:
        normalized = path.replace("\\", "/").strip("/")
        outbox = self._state["outbox"]
        # Последнее желаемое состояние заменяет прежний PUT/DELETE того же пути.
        outbox[:] = [entry for entry in outbox if not (
            entry.get("path") == normalized and entry.get("action") in {"put", "delete"}
        )]
        entry = {
            "id": uuid.uuid4().hex,
            "action": action,
            "path": normalized,
            "destination": destination.replace("\\", "/").strip("/"),
            "is_directory": bool(is_directory),
            "attempts": 0,
            "next_retry": 0.0,
            "created_at": self._now(),
            "last_error": "",
        }
        outbox.append(entry)
        if persist:
            self._save_state()
            self._write_status()
        return entry["id"]

    def _entry(self, entry_id: str) -> dict | None:
        return next((entry for entry in self._state["outbox"]
                     if entry.get("id") == entry_id), None)

    def _complete(self, entry_id: str) -> None:
        self._state["outbox"] = [entry for entry in self._state["outbox"]
                                 if entry.get("id") != entry_id]
        self._save_state()
        self._write_status(connection="ok", last_success=self._now(), last_error="")

    def _failed(self, entry_id: str, exc: StorageError) -> None:
        entry = self._entry(entry_id)
        if entry is not None:
            entry["attempts"] = int(entry.get("attempts", 0)) + 1
            entry["last_error"] = str(exc)
            entry["next_retry"] = time.time() + min(
                30 * (2 ** min(entry["attempts"] - 1, 7)), 3600
            )
            self._save_state()
        self._write_status(connection="error", last_error=str(exc))

    def _manifest_set(self, rel: str) -> None:
        path = self._local_path(rel)
        if not path.is_file() or path.is_symlink():
            return
        stat = path.stat()
        self._state["manifest"][rel] = {
            "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
        }

    def _manifest_remove(self, rel: str, is_directory: bool) -> None:
        manifest = self._state["manifest"]
        if is_directory:
            prefix = rel.rstrip("/") + "/"
            for key in list(manifest):
                if key == rel or key.startswith(prefix):
                    manifest.pop(key, None)
        else:
            manifest.pop(rel, None)

    def _record_tree(self, rel: str) -> None:
        target = self._local_path(rel)
        if target.is_file():
            self._manifest_set(rel)
        elif target.is_dir():
            for path in target.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    child = path.relative_to(self.root).as_posix()
                    if not self.is_excluded(child):
                        self._manifest_set(child)

    def validate(self) -> None:
        try:
            super().validate()
            self._write_status(connection="ok", last_check=self._now(), last_error="")
        except StorageError as exc:
            self._write_status(connection="error", last_check=self._now(), last_error=str(exc))
            raise

    def put_file(self, path: Path) -> None:
        rel = self.relative(path)
        if self.is_excluded(rel) or path.is_symlink() or not path.is_file():
            return
        with self._lock:
            entry_id = self._queue("put", rel)
            try:
                super().put_file(path)
                self._manifest_set(rel)
                self._complete(entry_id)
            except StorageError as exc:
                self._failed(entry_id, exc)
                raise

    def delete_path(self, rel: str, is_directory: bool) -> None:
        if self.is_excluded(rel):
            return
        with self._lock:
            entry_id = self._queue("delete", rel, is_directory=is_directory)
            try:
                super().delete_path(rel, is_directory)
                self._manifest_remove(rel, is_directory)
                self._complete(entry_id)
            except StorageError as exc:
                self._failed(entry_id, exc)
                raise

    def move_path(self, src: str, dst: str, is_directory: bool) -> None:
        with self._lock:
            entry_id = self._queue("move", src, is_directory=is_directory, destination=dst)
            try:
                super().move_path(src, dst, is_directory)
                self._manifest_remove(src, is_directory)
                self._record_tree(dst)
                self._complete(entry_id)
            except StorageError as exc:
                self._failed(entry_id, exc)
                raise

    def sync_changes(self, before: Snapshot) -> SyncResult:
        with self._lock:
            after = self.snapshot()
            changed = [rel for rel, state in after.items() if before.get(rel) != state]
            removed = [rel for rel in before if rel not in after]
            ids = [self._queue("put", rel, persist=False) for rel in changed]
            ids += [self._queue("delete", rel, persist=False) for rel in removed]
            self._save_state()
            self._write_status()
            self.flush_outbox(force=True, only_ids=set(ids), raise_errors=True)
            return SyncResult(uploaded=len(changed), deleted=len(removed))

    def _put_tree_now(self, rel: str) -> None:
        target = self._local_path(rel)
        paths = target.rglob("*") if target.is_dir() else [target]
        for path in paths:
            if path.is_file() and not path.is_symlink():
                child = path.relative_to(self.root).as_posix()
                if not self.is_excluded(child):
                    super().put_file(path)
                    self._manifest_set(child)

    def _execute_entry(self, entry: dict) -> None:
        action = entry["action"]
        rel = entry["path"]
        target = self._local_path(rel)
        if action == "put":
            if target.is_file() and not target.is_symlink():
                super().put_file(target)
                self._manifest_set(rel)
            else:
                super().delete_path(rel, False)
                self._manifest_remove(rel, False)
        elif action == "delete":
            # Если server откатил локальное удаление, локальная версия снова истинна.
            if target.exists() and not target.is_symlink():
                self._put_tree_now(rel)
            else:
                super().delete_path(rel, bool(entry.get("is_directory")))
                self._manifest_remove(rel, bool(entry.get("is_directory")))
        elif action == "move":
            dst = entry.get("destination", "")
            destination = self._local_path(dst)
            # Retry сводит S3 к текущему локальному состоянию, даже если server
            # уже откатил локальный rename после первой ошибки.
            if destination.exists() and not destination.is_symlink():
                self._put_tree_now(dst)
                super().delete_path(rel, bool(entry.get("is_directory")))
                self._manifest_remove(rel, bool(entry.get("is_directory")))
            elif target.exists() and not target.is_symlink():
                self._put_tree_now(rel)
                super().delete_path(dst, bool(entry.get("is_directory")))
            else:
                super().delete_path(rel, bool(entry.get("is_directory")))
                super().delete_path(dst, bool(entry.get("is_directory")))
        else:
            raise StorageError("неизвестная операция в S3 outbox")

    def flush_outbox(self, *, force: bool = False, only_ids: set[str] | None = None,
                     raise_errors: bool = False, progress=None) -> int:
        completed = 0
        first_error: StorageError | None = None
        with self._lock:
            entries = list(self._state["outbox"])
            progress_total = max(len(entries), 1)
            if progress is not None:
                progress("outbox", 0, progress_total)
            progress_current = 0
            for entry in entries:
                if only_ids is not None and entry.get("id") not in only_ids:
                    continue
                if not force and float(entry.get("next_retry", 0)) > time.time():
                    continue
                try:
                    self._execute_entry(entry)
                    self._state["outbox"] = [item for item in self._state["outbox"]
                                             if item.get("id") != entry.get("id")]
                    completed += 1
                except StorageError as exc:
                    current = self._entry(str(entry.get("id", "")))
                    if current is not None:
                        current["attempts"] = int(current.get("attempts", 0)) + 1
                        current["last_error"] = str(exc)
                        current["next_retry"] = time.time() + min(
                            30 * (2 ** min(current["attempts"] - 1, 7)), 3600
                        )
                    first_error = first_error or exc
                progress_current += 1
                if progress is not None:
                    progress("outbox", progress_current, progress_total)
            self._save_state()
            if first_error is None:
                self._write_status(connection="ok", last_success=self._now(), last_error="")
            else:
                self._write_status(connection="error", last_error=str(first_error))
            if first_error is not None and raise_errors:
                raise first_error
        return completed

    def recover_missing(self) -> SyncResult:
        downloaded = 0
        with self._lock:
            for obj in self._objects():
                rel = self.rel_from_key(str(obj.get("Key", "")))
                if not rel or self.is_excluded(rel):
                    continue
                target = self._local_path(rel)
                if not target.exists() and super().fetch_if_missing(rel):
                    self._manifest_set(rel)
                    downloaded += 1
            self._save_state()
            self._write_status(connection="ok", last_success=self._now(), last_error="")
        return SyncResult(downloaded=downloaded)

    def reconcile_now(self, progress=None) -> SyncResult:
        """Сверяет local manifest и S3, сообщая прогресс для startup/deploy."""
        with self._lock:
            local = self.snapshot()
            manifest = self._state["manifest"]
            remote = {
                rel: obj for obj in self._objects()
                if (rel := self.rel_from_key(str(obj.get("Key", ""))))
                and not self.is_excluded(rel)
            }
            progress_total = max(len(local) + len(manifest) + len(remote), 1)
            progress_current = 0

            def advance() -> None:
                nonlocal progress_current
                progress_current += 1
                if progress is not None:
                    progress("reconcile", progress_current, progress_total)

            if progress is not None:
                progress("reconcile", 0, progress_total)
            queued_put = queued_delete = downloaded = 0
            for rel, state in local.items():
                saved = manifest.get(rel, {})
                if (saved.get("size"), saved.get("mtime_ns")) != state or rel not in remote:
                    self._queue("put", rel, persist=False)
                    queued_put += 1
                advance()
            for rel in list(manifest):
                if rel not in local:
                    self._queue("delete", rel, persist=False)
                    queued_delete += 1
                advance()
            # Новый объект, добавленный непосредственно в bucket, безопасно
            # восстанавливается только если локального пути и manifest ещё нет.
            for rel in remote:
                if rel not in local and rel not in manifest:
                    if super().fetch_if_missing(rel):
                        self._manifest_set(rel)
                        downloaded += 1
                advance()
            # Журнал целиком фиксируется до первой сетевой операции.
            self._save_state()
            self._write_status()
            self.flush_outbox(force=True, raise_errors=True, progress=progress)
            self._save_state()
            now = self._now()
            self._write_status(
                connection="ok", last_reconcile=now, last_success=now, last_error="",
                next_reconcile=time.time() + self.reconcile_interval,
                last_result={"uploaded": queued_put, "deleted": queued_delete,
                             "downloaded": downloaded},
            )
            return SyncResult(uploaded=queued_put, deleted=queued_delete,
                              downloaded=downloaded)

    def startup_merge(self) -> SyncResult:
        """Фоновая startup-сверка с безопасным статусом и прогрессом."""
        started = self._now()
        last_report = 0.0
        progress_state = {"current": 0, "total": 1}

        def report(phase: str, current: int, total: int) -> None:
            nonlocal last_report
            progress_state.update(current=current, total=max(total, 1))
            now = time.monotonic()
            if current == 0 or current >= total or now - last_report >= 0.5:
                last_report = now
                self._write_status(connection="initializing", startup={
                    "state": "running", "phase": phase, "current": current,
                    "total": max(total, 1), "started_at": started,
                })

        self._write_status(connection="initializing", last_error="", startup={
            "state": "running", "phase": "outbox", "current": 0,
            "total": 1, "started_at": started,
        })
        try:
            # Сначала применяем журнал прошлого запуска, чтобы ожидающий DELETE
            # не был восстановлен обратно из ещё не очищенного S3.
            self.flush_outbox(force=True, raise_errors=True, progress=report)
            result = super().startup_merge(progress=report)
            self._write_status(connection="initializing", startup={
                "state": "running", "phase": "reconcile",
                "current": progress_state["total"], "total": progress_state["total"],
                "started_at": started,
            })
            reconciled = self.reconcile_now(progress=report)
            combined = SyncResult(
                uploaded=result.uploaded + reconciled.uploaded,
                deleted=reconciled.deleted,
                downloaded=result.downloaded + reconciled.downloaded,
                conflicts=result.conflicts,
            )
            finished = self._now()
            # Финальный startup status сериализуется тем же lock, что и записи
            # инструментов: параллельный put_file не сможет вернуть state=running.
            with self._lock:
                self._write_status(connection="ok", last_success=finished, last_error="", startup={
                    "state": "complete", "phase": "complete",
                    "current": progress_state["total"], "total": progress_state["total"],
                    "started_at": started, "finished_at": finished,
                    "result": {"uploaded": combined.uploaded, "deleted": combined.deleted,
                               "downloaded": combined.downloaded, "conflicts": combined.conflicts},
                })
            return combined
        except Exception as exc:
            safe = str(exc) if isinstance(exc, StorageError) else type(exc).__name__
            with self._lock:
                self._write_status(connection="error", last_error=safe, startup={
                    "state": "error", "phase": "error",
                    "current": progress_state["current"], "total": progress_state["total"],
                    "started_at": started, "finished_at": self._now(), "error": safe,
                })
            raise


    def maintenance_loop(self, action_file: Path) -> None:
        """Retry outbox, периодическая сверка и команды из dashboard."""
        try:
            last_action = action_file.stat().st_mtime_ns
        except OSError:
            last_action = 0
        next_reconcile = time.time() + self.reconcile_interval
        while True:
            try:
                self.flush_outbox()
                try:
                    current_action = action_file.stat().st_mtime_ns
                except OSError:
                    current_action = 0
                if current_action > last_action:
                    last_action = current_action
                    payload = json.loads(action_file.read_text(encoding="utf-8"))
                    action = payload.get("action")
                    if action == "check":
                        self.validate()
                    elif action == "sync":
                        self.reconcile_now()
                    elif action == "recover":
                        result = self.recover_missing()
                        self._write_status(last_action="recover", last_result={
                            "uploaded": 0, "deleted": 0, "downloaded": result.downloaded,
                        })
                    else:
                        raise StorageError("неизвестная команда dashboard")
                if time.time() >= next_reconcile:
                    self.reconcile_now()
                    next_reconcile = time.time() + self.reconcile_interval
            except (StorageError, OSError, ValueError, json.JSONDecodeError) as exc:
                safe = str(exc) if isinstance(exc, StorageError) else type(exc).__name__
                self._write_status(connection="error", last_error=safe)
            time.sleep(5)

def create_storage(
    root: Path,
    environ: Mapping[str, str] | None = None,
    *,
    client: S3Client | None = None,
    validate: bool = True,
    restore: bool = True,
) -> Storage:
    env = environ if environ is not None else os.environ
    enabled = env.get("S3_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        return LocalStorage(root)
    required = ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "S3_REGION")
    missing = [name for name in required if not env.get(name, "").strip()]
    if missing:
        raise StorageError("S3 включён, но не заданы: " + ", ".join(missing))
    extra = tuple(item.strip() for item in env.get("S3_EXCLUDE", "").split(",") if item.strip())
    try:
        reconcile_interval = int(env.get("S3_RECONCILE_INTERVAL", "600") or "600")
    except ValueError as exc:
        raise StorageError("S3_RECONCILE_INTERVAL должен быть целым числом секунд") from exc
    storage = S3Storage(
        root,
        endpoint=env["S3_ENDPOINT"].strip(),
        access_key=env["S3_ACCESS_KEY"].strip(),
        secret_key=env["S3_SECRET_KEY"].strip(),
        bucket=env["S3_BUCKET"].strip(),
        region=env["S3_REGION"].strip(),
        prefix=env.get("S3_PREFIX", "projects/").strip() or "projects/",
        excludes=tuple(dict.fromkeys(MANDATORY_EXCLUDES + extra)),
        client=client,
        state_dir=Path(env.get("S3_STATE_DIR", "/storage-state")),
        reconcile_interval=reconcile_interval,
    )
    if validate:
        storage.validate()
    if restore:
        result = storage.startup_merge()
        print(f"[storage] S3 startup merge: {result.describe()}", flush=True)
    return storage
