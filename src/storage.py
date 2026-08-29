"""Постоянное хранилище проектов: локальный режим или S3 поверх локальной /data.

S3 никогда не монтируется как файловая система. Инструменты и shell работают с
обычной POSIX /data, а этот слой переносит только изменившиеся файлы.
"""

from __future__ import annotations

import fnmatch
import os
import threading
import uuid
from dataclasses import dataclass
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


class S3Storage(Storage):
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
            for rel in removed:
                self._call("удаление файла", self.client.delete_object,
                           Bucket=self.bucket, Key=self.key(rel))
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

    def startup_merge(self) -> SyncResult:
        """Безопасное объединение: ничего локального не удаляем и не перезаписываем."""
        with self._lock:
            remote = {
                rel: obj for obj in self._objects()
                if (rel := self.rel_from_key(str(obj.get("Key", ""))))
                and not self.is_excluded(rel)
            }
            downloaded = conflicts = uploaded = 0
            for rel, obj in remote.items():
                target = self._local_path(rel)
                if target.exists() or target.is_symlink():
                    conflicts += 1
                    # Локальная рабочая копия имеет приоритет при конфликте:
                    # это также восстанавливает S3 после ранее неудачного PUT.
                    if target.is_file() and not target.is_symlink():
                        self.put_file(target)
                        uploaded += 1
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(target.name + f".novate-{uuid.uuid4().hex}.tmp")
                try:
                    self._call("восстановление файла", self.client.download_file,
                               self.bucket, obj["Key"], str(temp))
                    os.replace(temp, target)
                    downloaded += 1
                finally:
                    temp.unlink(missing_ok=True)
            for rel in self.snapshot():
                if rel not in remote:
                    self.put_file(self._local_path(rel))
                    uploaded += 1
            return SyncResult(uploaded=uploaded, downloaded=downloaded, conflicts=conflicts)


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
    )
    if validate:
        storage.validate()
    if restore:
        result = storage.startup_merge()
        print(f"[storage] S3 startup merge: {result.describe()}", flush=True)
    return storage
