import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { readJson } from "./admin.ts";
import * as settings from "./settings.ts";
import { esc } from "./ui.ts";

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const BACKUP_DIR = process.env.BACKUP_DIR || "/backups";
const DATA_DIR = process.env.MCP_DATA_DIR || "/data";
const S3_STATUS_FILE = process.env.S3_STATUS_FILE || "/storage-state/status.json";
const ALERT_STATE_FILE = `${CONFIG_DIR}/monitor-alerts.json`;
const HISTORY_FILE = `${CONFIG_DIR}/monitor-history.json`;
const STARTED_AT = Date.now();

type JsonObject = Record<string, unknown>;
export type MonitorProblem = { id: string; title: string; detail: string };
export type MonitorEvent = { time: string; state: "error" | "recovered"; id: string; title: string; detail: string };
export type MonitorSnapshot = {
  time: string;
  disk: { freePercent: number; freeBytes: number; totalBytes: number };
  s3: JsonObject;
  backup: JsonObject;
  heartbeat: JsonObject;
  restoreDrill: JsonObject;
  problems: MonitorProblem[];
};

function numberSetting(key: string, fallback: number): number {
  const value = Number(settings.get(key) || process.env[key] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function monitoringSnapshot(now = Date.now()): MonitorSnapshot {
  const s3 = readJson(S3_STATUS_FILE);
  const backup = readJson(`${BACKUP_DIR}/last-backup.json`);
  const heartbeat = readJson(`${BACKUP_DIR}/.backup-heartbeat.json`);
  const restoreDrill = readJson(`${BACKUP_DIR}/.restore-drill.json`);
  let totalBytes = 0, freeBytes = 0;
  try {
    const disk = statfsSync(DATA_DIR);
    totalBytes = Number(disk.blocks) * Number(disk.bsize);
    freeBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch { /* reported below */ }
  const freePercent = totalBytes ? Math.round(freeBytes / totalBytes * 1000) / 10 : 0;
  const problems: MonitorProblem[] = [];
  const s3Enabled = settings.s3Enabled();
  if (s3Enabled && (s3.connection === "error" || (s3.startup as JsonObject | undefined)?.state === "error")) {
    problems.push({ id: "s3-error", title: "Ошибка S3", detail: String(s3.last_error || "startup reconciliation failed") });
  }
  const pending = Number(s3.pending || 0);
  const pendingLimit = numberSetting("MONITOR_S3_PENDING_LIMIT", 100);
  if (s3Enabled && pending > pendingLimit) {
    problems.push({ id: "s3-pending", title: "Очередь S3 растёт", detail: `${pending} операций, лимит ${pendingLimit}` });
  }
  const heartbeatAt = Number(heartbeat.updated || 0) * 1000;
  const heartbeatLimit = numberSetting("MONITOR_BACKUP_HEARTBEAT_SECONDS", 180) * 1000;
  if (now - STARTED_AT > heartbeatLimit && (!heartbeatAt || now - heartbeatAt > heartbeatLimit)) {
    problems.push({ id: "backup-heartbeat", title: "Backup-сервис не отвечает", detail: heartbeatAt ? `heartbeat старше ${Math.round((now - heartbeatAt) / 1000)} с` : "heartbeat отсутствует" });
  }
  if (restoreDrill.state === "error") {
    problems.push({ id: "restore-drill", title: "Проверка восстановления не пройдена", detail: String(restoreDrill.error || "unknown error") });
  }
  const diskLimit = numberSetting("MONITOR_DISK_FREE_PERCENT", 10);
  if (totalBytes && freePercent < diskLimit) {
    problems.push({ id: "disk-space", title: "Заканчивается место на диске", detail: `свободно ${freePercent}%, порог ${diskLimit}%` });
  }
  return { time: new Date(now).toISOString(), disk: { freePercent, freeBytes, totalBytes }, s3, backup, heartbeat, restoreDrill, problems };
}

export function monitoringHistory(): MonitorEvent[] {
  const data = readJson(HISTORY_FILE);
  return Array.isArray(data.events) ? data.events.slice(0, 200) as MonitorEvent[] : [];
}

function persist(path: string, data: unknown): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function startMonitoring(notify: (text: string) => void): void {
  const tick = (): void => {
    try {
      const current = monitoringSnapshot();
      const previousData = readJson(ALERT_STATE_FILE);
      const previous = new Set(Array.isArray(previousData.active) ? previousData.active.map(String) : []);
      const active = new Set(current.problems.map((item) => item.id));
      const events = monitoringHistory();
      for (const problem of current.problems) {
        if (previous.has(problem.id)) continue;
        events.unshift({ time: current.time, state: "error", ...problem });
        notify(`🚨 <b>${esc(problem.title)}</b>\n\n${esc(problem.detail)}`);
      }
      for (const id of previous) {
        if (active.has(id)) continue;
        const title = id.replaceAll("-", " ");
        events.unshift({ time: current.time, state: "recovered", id, title, detail: "Состояние нормализовалось" });
        notify(`✅ <b>Состояние восстановлено</b>\n\n${esc(title)}`);
      }
      persist(ALERT_STATE_FILE, { active: [...active], updated_at: current.time });
      persist(HISTORY_FILE, { events: events.slice(0, 200) });
    } catch (error) { console.error("monitor tick failed:", error); }
  };
  const interval = Math.max(30, numberSetting("MONITOR_INTERVAL_SECONDS", 60)) * 1000;
  setTimeout(tick, 5000);
  setInterval(tick, interval);
}
