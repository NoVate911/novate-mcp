/**
 * Настройки панели (TypeScript-порт логики src/settings.py).
 * Держи в синхроне со settings.py!
 *
 * Приоритет значений:
 *   1. Переопределение из панели (/config/overrides.json) — если задано
 *   2. Переменные окружения из .env — значения по умолчанию
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const FILE = `${CONFIG_DIR}/overrides.json`;

export const DEFAULTS: Record<string, string> = {
  DOMAIN: "",
  PROJECTS_DIR: "./projects",
  MCP_TOKEN: "",
  SESSION_SECRET: "",
  TG_CLIENT_ID: "",
  TG_CLIENT_SECRET: "",
  ALLOWED_TG_USERS: "",
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  BACKUP_INTERVAL_HOURS: "24",
  BACKUP_KEEP: "7",
  BACKUP_PASSWORD: "",
  BACKUP_RESTORE_DRILL: "true",
  MONITOR_INTERVAL_SECONDS: "60",
  MONITOR_BACKUP_HEARTBEAT_SECONDS: "180",
  MONITOR_S3_PENDING_LIMIT: "100",
  MONITOR_DISK_FREE_PERCENT: "10",
};

export function readOverrides(): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** Эффективное значение: переопределение панели, иначе .env, иначе дефолт. */
export function get(key: string): string {
  const overrides = readOverrides();
  if (key in overrides && typeof overrides[key] === "string") return overrides[key].trim();
  return process.env[key] ?? DEFAULTS[key] ?? "";
}

/** Откуда взято текущее значение. */
export function source(key: string): "panel" | "env" {
  const overrides = readOverrides();
  return key in overrides && typeof overrides[key] === "string" ? "panel" : "env";
}

export function setOverride(key: string, value: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const data = readOverrides();
  data[key] = value.trim();
  writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

export function clearOverride(key: string): void {
  const data = readOverrides();
  if (key in data) {
    delete data[key];
    writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
  }
}
