from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from fastmcp import Client


class McpHttpSessionE2E(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.mcp_port = self._free_port()
        self.health_port = self._free_port()
        env = os.environ.copy()
        env.update({
            "MCP_TOKEN": "e2e-secret-token",
            "MCP_DATA_DIR": str(self.root / "projects"),
            "CONFIG_DIR": str(self.root / "config"),
            "S3_ENABLED": "false",
            "MCP_PORT": str(self.mcp_port),
            "MCP_HEALTH_PORT": str(self.health_port),
            "DOMAIN": "localhost",
        })
        self.process = subprocess.Popen(
            [sys.executable, "src/server.py"], cwd=Path(__file__).resolve().parents[1],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.process.poll() is not None:
                self.fail(f"MCP process exited with {self.process.returncode}")
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.health_port}/health/live", timeout=.5,
                ) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                time.sleep(.1)
        else:
            self.fail("MCP liveness did not become ready")

    def tearDown(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.temp.cleanup()

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def test_authenticated_session_lists_and_calls_tools(self):
        async def scenario() -> None:
            async with Client(
                f"http://127.0.0.1:{self.mcp_port}/mcp/",
                auth="e2e-secret-token",
            ) as client:
                tools = await client.list_tools()
                names = {tool.name for tool in tools}
                self.assertIn("write_file", names)
                self.assertIn("read_file", names)
                await client.call_tool("write_file", {
                    "path": "e2e/session.txt", "content": "session-ok",
                })
                result = await client.call_tool("read_file", {"path": "e2e/session.txt"})
                self.assertIn("session-ok", str(result))
        asyncio.run(scenario())
        self.assertEqual((self.root / "projects/e2e/session.txt").read_text(), "session-ok")

    def test_rejects_missing_bearer_token(self):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.mcp_port}/mcp/",
            data=b'{}', method="POST", headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=3)
        self.assertIn(raised.exception.code, {401, 403})


if __name__ == "__main__":
    unittest.main()
