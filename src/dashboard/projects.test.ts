import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionCodec } from "./session.ts";

const root = mkdtempSync(join(tmpdir(), "novate-project-access-"));
const projects = join(root, "projects");
const config = join(root, "config");
const backups = join(root, "backups");
const port = 21000 + Math.floor(Math.random() * 10000);
let child: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  mkdirSync(join(projects, "site"), { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(projects, "site", "index.html"), "<h1>protected-project</h1>");
  child = Bun.spawn([process.execPath, "index.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      DASHBOARD_PORT: String(port),
      MCP_DATA_DIR: projects,
      CONFIG_DIR: config,
      BACKUP_DIR: backups,
      S3_STATUS_FILE: join(root, "s3-status.json"),
      SESSION_SECRET: "s".repeat(64),
      TG_CLIENT_ID: "test-client",
      TG_CLIENT_SECRET: "test-secret",
      ALLOWED_TG_USERS: "42",
      DOMAIN: "localhost",
      S3_ENABLED: "false",
      MONITOR_INTERVAL_SECONDS: "3600",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.ok) return;
    } catch { /* retry */ }
    await Bun.sleep(50);
  }
  throw new Error("dashboard did not start");
});

afterAll(() => {
  child?.kill();
  rmSync(root, { recursive: true, force: true });
});

test("unauthenticated project request starts OIDC and keeps return path", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/projects/site/`, { redirect: "manual" });
  expect([302, 303]).toContain(response.status);
  expect(response.headers.get("location")).toContain("/auth/telegram?next=%2Fprojects%2Fsite%2F");
});

test("valid dashboard session can read project and traversal stays blocked", async () => {
  const codec = createSessionCodec(() => "s".repeat(64));
  const cookie = codec.packSigned({ uid: "42", name: "Tester", ts: Math.floor(Date.now() / 1000) });
  const response = await fetch(`http://127.0.0.1:${port}/projects/site/`, {
    headers: { Cookie: `dash_auth=${cookie}` },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("protected-project");
  expect(response.headers.get("cache-control")).toContain("private");
  const missing = await fetch(`http://127.0.0.1:${port}/projects/not-found`, {
    headers: { Cookie: `dash_auth=${cookie}` }, redirect: "manual",
  });
  expect(missing.status).toBe(404);
});


test("unauthenticated project deletion is redirected to login", async () => {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/delete-project`, {
    method: "POST", redirect: "manual",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ project: "site" }),
  });
  expect([302, 303]).toContain(response.status);
  expect(response.headers.get("location")).toBe("/login");
});

test("authenticated user can delete one top-level project and trigger S3 sync", async () => {
  const target = join(projects, "delete-me");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "file.txt"), "remove");
  const codec = createSessionCodec(() => "s".repeat(64));
  const cookie = codec.packSigned({ uid: "42", name: "Tester", ts: Math.floor(Date.now() / 1000) });
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/delete-project`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: `dash_auth=${cookie}`,
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ project: "delete-me" }),
  });
  expect([302, 303]).toContain(response.status);
  expect(response.headers.get("location")).toContain("/?deleted=delete-me");
  expect(Bun.file(join(target, "file.txt")).size).toBe(0);
  const action = await Bun.file(join(config, "s3-action.json")).json();
  expect(action.action).toBe("sync");
  expect(action.project).toBe("delete-me");
  expect(action.requested_by).toBe("42");
});

test("project deletion rejects cross-origin and traversal requests", async () => {
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "keep");
  const codec = createSessionCodec(() => "s".repeat(64));
  const cookie = codec.packSigned({ uid: "42", name: "Tester", ts: Math.floor(Date.now() / 1000) });
  const origin = `http://127.0.0.1:${port}`;
  const crossOrigin = await fetch(`${origin}/delete-project`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: `dash_auth=${cookie}`, Origin: "https://attacker.invalid", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ project: "site" }),
  });
  expect(crossOrigin.headers.get("location")).toContain("error=project-origin");
  const traversal = await fetch(`${origin}/delete-project`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: `dash_auth=${cookie}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ project: "../outside" }),
  });
  expect(traversal.headers.get("location")).toContain("error=project-delete");
  expect(await Bun.file(join(outside, "keep.txt")).text()).toBe("keep");
});
