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
      // Caddy отдаёт Referrer-Policy: no-referrer, поэтому браузер шлёт Origin: null.
      // Именно этот случай раньше ломал удаление проекта.
      Origin: "null",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ project: "delete-me", csrf: codec.csrfToken("42") }),
  });
  expect([302, 303]).toContain(response.status);
  expect(response.headers.get("location")).toContain("/?deleted=delete-me");
  expect(Bun.file(join(target, "file.txt")).size).toBe(0);
  const action = await Bun.file(join(config, "s3-action.json")).json();
  expect(action.action).toBe("sync");
  expect(action.project).toBe("delete-me");
  expect(action.requested_by).toBe("42");
});

test("project deletion rejects forged, cross-origin and traversal requests", async () => {
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "keep");
  const codec = createSessionCodec(() => "s".repeat(64));
  const cookie = codec.packSigned({ uid: "42", name: "Tester", ts: Math.floor(Date.now() / 1000) });
  const csrf = codec.csrfToken("42");
  const origin = `http://127.0.0.1:${port}`;
  const form = (extra: Record<string, string>) => ({
    method: "POST", redirect: "manual" as const,
    headers: {
      Cookie: `dash_auth=${cookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...extra,
    },
  });

  // Без CSRF-токена запрос отклоняется даже с валидной сессией.
  const noToken = await fetch(`${origin}/delete-project`, {
    ...form({ Origin: origin }),
    body: new URLSearchParams({ project: "site" }),
  });
  expect(noToken.status).toBe(403);

  // Токен другого пользователя не подходит.
  const wrongToken = await fetch(`${origin}/delete-project`, {
    ...form({ Origin: origin }),
    body: new URLSearchParams({ project: "site", csrf: codec.csrfToken("999") }),
  });
  expect(wrongToken.status).toBe(403);

  // Явно чужой Origin отклоняется даже с валидным токеном.
  const crossOrigin = await fetch(`${origin}/delete-project`, {
    ...form({ Origin: "ht" + "tps://attacker.invalid" }),
    body: new URLSearchParams({ project: "site", csrf }),
  });
  expect(crossOrigin.status).toBe(403);

  // Обход каталога блокируется уже после успешной CSRF-проверки.
  const traversal = await fetch(`${origin}/delete-project`, {
    ...form({ Origin: origin }),
    body: new URLSearchParams({ project: "../outside", csrf }),
  });
  expect(traversal.headers.get("location")).toContain("error=project-delete");

  expect(await Bun.file(join(outside, "keep.txt")).text()).toBe("keep");
  expect(await Bun.file(join(projects, "site", "index.html")).text()).toContain("protected-project");
});
