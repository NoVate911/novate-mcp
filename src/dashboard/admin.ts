import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const AUDIT_FILE = `${CONFIG_DIR}/audit.jsonl`;
const TOKENS_FILE = `${CONFIG_DIR}/mcp-tokens.json`;

type JsonObject = Record<string, unknown>;
export type AuditEvent = { time: string; actor: string; action: string; target: string; result: string; detail?: string };
export type ManagedToken = { id: string; name: string; role: "reader" | "editor" | "operator"; token: string; createdAt: string; createdBy: string };

export function readJson(path: string): JsonObject {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as JsonObject : {};
  } catch { return {}; }
}

function atomicJson(path: string, data: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function appendAudit(actor: string, action: string, target: string, result = "ok", detail = ""): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const event: AuditEvent = { time: new Date().toISOString(), actor, action, target, result, ...(detail ? { detail } : {}) };
  appendFileSync(AUDIT_FILE, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
}

export function auditEvents(limit = 200): AuditEvent[] {
  try {
    return readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse()
      .map((line) => JSON.parse(line) as AuditEvent);
  } catch { return []; }
}

export function managedTokens(): ManagedToken[] {
  const data = readJson(TOKENS_FILE);
  return Array.isArray(data.tokens) ? data.tokens.filter((item): item is ManagedToken => Boolean(item && typeof item === "object")) : [];
}

export function createManagedToken(name: string, role: ManagedToken["role"], actor: string): ManagedToken {
  const item: ManagedToken = {
    id: randomBytes(8).toString("hex"), name: name.trim().slice(0, 80), role,
    token: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString(), createdBy: actor,
  };
  atomicJson(TOKENS_FILE, { tokens: [...managedTokens(), item] });
  appendAudit(actor, "token.create", item.name, "ok", role);
  return item;
}

export function revokeManagedToken(id: string, actor: string): boolean {
  const before = managedTokens();
  const removed = before.find((item) => item.id === id);
  if (!removed) return false;
  atomicJson(TOKENS_FILE, { tokens: before.filter((item) => item.id !== id) });
  appendAudit(actor, "token.revoke", removed.name);
  return true;
}

export function hostStatus(): JsonObject { return readJson(`${CONFIG_DIR}/host-status.json`); }
export function deployHistory(): JsonObject[] {
  const data = readJson(`${CONFIG_DIR}/deploy-history.json`);
  return Array.isArray(data.items) ? data.items.slice(0, 100) as JsonObject[] : [];
}
export function preflightStatus(): JsonObject { return readJson(`${CONFIG_DIR}/preflight-status.json`); }
