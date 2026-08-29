import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import backup


class BackupRestoreE2ETests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.projects = root / "projects"
        self.config = root / "config"
        self.archives = root / "backups"
        for path in (self.projects, self.config, self.archives):
            path.mkdir()

        backup.DATA_DIR = self.projects
        backup.CONFIG_DIR = self.config
        backup.BACKUP_DIR = self.archives
        backup.TRIGGER_FILE = self.config / "backup-now"
        backup.MCP_TRIGGER_FILE = self.projects / ".backup-now"
        backup.RESTORE_FILE = self.config / "restore-now"
        backup.S3_SYNC_TRIGGER = self.projects / ".s3-sync-needed"
        backup.STATE_FILE = self.archives / "last-backup.json"
        backup.HEARTBEAT_FILE = self.archives / ".backup-heartbeat.json"

        self.values = {
            "BACKUP_PASSWORD": "",
            "BACKUP_KEEP": "10",
            "BACKUP_INTERVAL_HOURS": "24",
            "TG_BOT_TOKEN": "",
            "TG_CHAT_ID": "",
        }
        self.get_setting = mock.patch.object(
            backup.settings, "get", side_effect=lambda key: self.values.get(key, "")
        )
        self.telegram = mock.patch.object(backup, "send_to_telegram", return_value="skipped")
        self.notification = mock.patch.object(backup, "tg_text")
        self.get_setting.start(); self.telegram.start(); self.notification.start()

    def tearDown(self):
        mock.patch.stopall()
        self.tmp.cleanup()

    def seed_projects(self):
        (self.projects / "alpha" / "nested").mkdir(parents=True)
        (self.projects / "alpha" / "index.html").write_text("version one", encoding="utf-8")
        (self.projects / "alpha" / "nested" / "data.txt").write_text("important", encoding="utf-8")
        (self.config / "overrides.json").write_text('{"BACKUP_KEEP":"10"}', encoding="utf-8")

    def assert_round_trip(self, encrypted: bool):
        self.seed_projects()
        if encrypted:
            self.values["BACKUP_PASSWORD"] = "e2e-test-password"

        backup.run_backup("e2e test")
        status = json.loads(backup.STATE_FILE.read_text(encoding="utf-8"))
        archive = self.archives / status["file"]
        self.assertTrue(archive.is_file())
        self.assertEqual(archive.name.endswith(".enc"), encrypted)

        (self.projects / "alpha" / "index.html").write_text("corrupted", encoding="utf-8")
        (self.projects / "alpha" / "nested" / "data.txt").unlink()
        backup.do_restore(archive.name)

        self.assertEqual((self.projects / "alpha" / "index.html").read_text(encoding="utf-8"), "version one")
        self.assertEqual((self.projects / "alpha" / "nested" / "data.txt").read_text(encoding="utf-8"), "important")
        restored = json.loads(backup.STATE_FILE.read_text(encoding="utf-8"))
        self.assertTrue(restored["restore"].startswith("ok:"))
        self.assertTrue(any("-pre-restore.tar.gz" in p.name for p in self.archives.iterdir()))

    def test_plain_backup_restore_round_trip(self):
        self.assert_round_trip(encrypted=False)

    @unittest.skipUnless(os.system("openssl version >/dev/null 2>&1") == 0, "openssl is required")
    def test_encrypted_backup_restore_round_trip(self):
        self.assert_round_trip(encrypted=True)

    def test_stale_warning_is_sent_once_until_recovery(self):
        sent = []
        with mock.patch.object(backup, "tg_text", side_effect=sent.append), \
             mock.patch.object(backup, "stale_after_seconds", return_value=3_600):
            alerted = backup.check_stale_backup(now=10_000, last_success=1_000, started_at=1_000, alerted=False)
            self.assertTrue(alerted)
            self.assertEqual(len(sent), 1)
            alerted = backup.check_stale_backup(now=10_100, last_success=1_000, started_at=1_000, alerted=alerted)
            self.assertEqual(len(sent), 1)
            recovered = backup.check_stale_backup(now=10_100, last_success=10_000, started_at=1_000, alerted=alerted)
            self.assertFalse(recovered)


if __name__ == "__main__":
    unittest.main()
