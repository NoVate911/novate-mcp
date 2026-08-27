/**
 * Настройки панели (TypeScript-порт логики src/settings.py).
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
  DASH_TOKEN: "",
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
  const ov = readOverrides()[key];
  if (typeof ov === "string" && ov.trim()) return ov.trim();
  return process.env[key] ?? DEFAULTS[key] ?? "";
}

/** Откуда взято текущее значение. */
export function source(key: string): "panel" | "env" {
  const ov = readOverrides()[key];
  return typeof ov === "string" && ov.trim() ? "panel" : "env";
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
