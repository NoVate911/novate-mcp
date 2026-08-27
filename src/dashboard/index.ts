/**
 * NoVate MCP — панель управления проектами.
 * TypeScript + Bun: лёгкий HTTP-сервер без фреймворков.
 *
 * Маршруты:
 *   GET  /                — список проектов + статистика (нужен вход)
 *   GET  /browse/<путь>   — просмотр папки (нужен вход)
 *   GET  /download/<путь> — скачивание файла (нужен вход)
 *   GET  /settings        — настройки (нужен вход)
 *   POST /settings        — сохранить/сбросить переопределение (нужен вход)
 *   GET  /login, POST /login, GET /logout
 *   GET  /static/client.js — клиентский JS (собирается bun build при сборке образа)
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, statSync, statfsSync } from "node:fs";
import os from "node:os";
import { basename, resolve } from "node:path";
import * as settings from "./settings.ts";
import { esc, fmtTime, header, humanSize, loginPage, mask, shell } from "./ui.ts";

const DATA_DIR = resolve(process.env.MCP_DATA_DIR || "/data");
const COOKIE_NAME = "dash_auth";
const COOKIE_TTL = 7 * 24 * 3600;

// Редактируемые в панели настройки
const EDITABLE = [
  { key: "DASH_TOKEN", label: "Токен входа в панель",
    hint: "Применяется сразу. Текущие сессии разлогинятся.", secret: true },
  { key: "MCP_TOKEN", label: "Токен MCP-доступа (Bearer)",
    hint: "Нужен перезапуск: docker compose restart mcp. Затем обнови токен в своём MCP-клиенте.",
    secret: true },
  { key: "DOMAIN", label: "Домен сервера",
    hint: "Ссылки в панели — сразу. HTTPS-домен Caddy меняется через .env + install.sh.",
    secret: false },
];

// Только для просмотра
const INFO_ONLY = [
  { key: "PROJECTS_DIR", label: "Папка проектов",
    hint: "Меняется только в .env на сервере, затем bash install.sh." },
];

// ---------- безопасность ----------

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function tokenOk(input: string): boolean {
  // Сравниваем хэши, чтобы длина токена не утекала через timing
  return timingSafeEqual(sha256(input), sha256(settings.get("DASH_TOKEN")));
}

function sign(ts: string): string {
  return createHmac("sha256", settings.get("DASH_TOKEN")).update(ts).digest("hex");
}

function cookieOf(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return "";
}

function authed(req: Request): boolean {
  const cookie = cookieOf(req, COOKIE_NAME);
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return false;
  const ts = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > COOKIE_TTL) return false;
  return timingSafeEqual(sha256(sig), sha256(sign(ts)));
}

/** Пути строго внутри DATA_DIR (защита от ../). */
function safePath(rel: string): string | null {
  const target = resolve(DATA_DIR, rel.replace(/^\/+/, ""));
  if (target !== DATA_DIR && !target.startsWith(DATA_DIR + "/")) return null;
  return target;
}

// ---------- helpers ответов ----------

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...extra } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

// ---------- данные ----------

function walk(dir: string): { files: number; size: number; latest: number } {
  let files = 0, size = 0, latest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files, size, latest };
  }
  for (const e of entries) {
    const p = dir + "/" + e.name;
    try {
      if (e.isDirectory()) {
        const sub = walk(p);
        files += sub.files; size += sub.size;
        latest = Math.max(latest, sub.latest);
      } else if (e.isFile()) {
        const st = statSync(p);
        files++; size += st.size;
        latest = Math.max(latest, st.mtimeMs);
      }
    } catch { /* пропускаем недоступное */ }
  }
  return { files, size, latest };
}

// ---------- страницы ----------

function indexPage(): string {
  const domain = settings.get("DOMAIN");
  const cards: string[] = [];
  let totalSize = 0, totalFiles = 0;
  let names: string[] = [];
  try {
    names = readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* пусто */ }

  names.forEach((name, i) => {
    const st = walk(DATA_DIR + "/" + name);
    totalSize += st.size; totalFiles += st.files;
    const pub = domain
      ? `<a class="tag" href="` + "https://" + esc(domain) + `/projects/${encodeURIComponent(name)}/" target="_blank" rel="noopener">открыть сайт ↗</a>`
      : "";
    cards.push(
      `<div class="card rise" style="animation-delay:${120 + i * 70}ms">`
      + `<a class="main" href="/browse/${encodeURIComponent(name)}">`
      + `<div class="name">📁 ${esc(name)}</div>`
      + `<div class="meta">${st.files} файлов · ${humanSize(st.size)} · изменён ${fmtTime(st.latest)}</div>`
      + `</a><div>${pub}<span class="tag">${humanSize(st.size)}</span></div></div>`,
    );
  });

  let diskFree = "—";
  try {
    const fs = statfsSync(DATA_DIR);
    diskFree = humanSize(fs.bfree * fs.bsize);
  } catch { /* неизвестно */ }

  const up = os.uptime();
  const uptime = `${Math.floor(up / 86400)} дн ${Math.floor((up % 86400) / 3600)} ч`;

  const stats =
    `<div class="stats">`
    + `<div class="stat rise" style="animation-delay:0ms"><small>Проектов</small><b data-count="${names.length}">0</b></div>`
    + `<div class="stat rise" style="animation-delay:60ms"><small>Файлов всего</small><b data-count="${totalFiles}">0</b></div>`
    + `<div class="stat rise" style="animation-delay:120ms"><small>Занято проектами</small><b>${humanSize(totalSize)}</b></div>`
    + `<div class="stat rise" style="animation-delay:180ms"><small>Свободно на диске</small><b>${diskFree}</b></div>`
    + `<div class="stat rise" style="animation-delay:240ms"><small>Аптайм сервера</small><b>${uptime}</b></div>`
    + `</div>`;

  const body = cards.length
    ? cards.join("")
    : `<div class="empty rise">Проектов пока нет.<br>Попроси своего ИИ-агента что-нибудь создать!</div>`;

  return shell("NoVate MCP — проекты",
    header("projects") + `<div class="wrap">${stats}${body}</div>`);
}

function browsePage(rel: string): Response {
  const target = safePath(rel);
  if (!target) return redirect("/");
  let entries;
  try {
    if (!statSync(target).isDirectory()) return redirect("/");
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return redirect("/");
  }

  const parts = rel.split("/").filter(Boolean);
  const crumbs = [`<a href="/">Проекты</a>`];
  let acc = "";
  for (const part of parts) {
    acc = acc ? acc + "/" + part : part;
    crumbs.push(`<a href="/browse/${encodeURIComponent(acc)}">${esc(part)}</a>`);
  }

  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
  );

  const rows = entries.map((e) => {
    const childRel = rel ? rel + "/" + e.name : e.name;
    const q = encodeURIComponent(childRel);
    if (e.isDirectory()) {
      return `<tr><td>📁 <a href="/browse/${q}">${esc(e.name)}</a></td><td>—</td><td><span class="hint">папка</span></td></tr>`;
    }
    let size = "—";
    try { size = humanSize(statSync(target + "/" + e.name).size); } catch { /* — */ }
    return `<tr><td>📄 ${esc(e.name)}</td><td>${size}</td>`
      + `<td><a class="btn" href="/download/${q}">Скачать</a></td></tr>`;
  });

  const table = rows.length
    ? rows.join("")
    : `<tr><td colspan="3" style="text-align:center;color:var(--muted)">пусто</td></tr>`;

  return html(shell("NoVate MCP — файлы",
    header("") + `<div class="wrap rise">`
    + `<div class="crumb">${crumbs.join(" / ")}</div>`
    + `<div class="panel"><table><thead><tr><th>Имя</th><th>Размер</th><th></th></tr></thead>`
    + `<tbody>${table}</tbody></table></div></div>`));
}

function settingsPage(url: URL): string {
  let flash = "";
  if (url.searchParams.has("saved")) {
    flash = `<div class="note ok rise">Сохранено: значение из панели теперь имеет приоритет над .env.</div>`;
  } else if (url.searchParams.has("reset")) {
    flash = `<div class="note ok rise">Переопределение сброшено — снова действует значение из .env.</div>`;
  }

  const rows: string[] = [];
  for (const item of EDITABLE) {
    const effective = settings.get(item.key);
    const src = settings.source(item.key);
    const shown = item.secret ? mask(effective) : esc(effective || "(не задан)");
    const badge = src === "panel"
      ? `<span class="badge panel">панель</span>`
      : `<span class="badge env">.env</span>`;
    const resetBtn = src === "panel"
      ? `<button class="btn gray" form="reset-${esc(item.key)}">По умолчанию</button>`
      : "";
    rows.push(
      `<tr><td style="width:210px"><b>${esc(item.key)}</b>`
      + `<div class="hint">${esc(item.label)}</div></td>`
      + `<td><span class="val">${shown}</span> ${badge}`
      + `<form class="inline" method="post" action="/settings">`
      + `<input type="hidden" name="key" value="${esc(item.key)}">`
      + `<input type="text" name="value" placeholder="Новое значение (пусто — не менять)">`
      + `<button class="btn" type="submit" name="action" value="save">Сохранить</button>${resetBtn}</form>`
      + `<form id="reset-${esc(item.key)}" method="post" action="/settings">`
      + `<input type="hidden" name="key" value="${esc(item.key)}">`
      + `<input type="hidden" name="action" value="reset"></form>`
      + `<div class="hint">${esc(item.hint)}</div></td></tr>`,
    );
  }
  for (const item of INFO_ONLY) {
    const effective = settings.get(item.key);
    rows.push(
      `<tr><td style="width:210px"><b>${esc(item.key)}</b>`
      + `<div class="hint">${esc(item.label)}</div></td>`
      + `<td><span class="val">${esc(effective || "(не задан)")}</span> <span class="badge env">.env</span>`
      + `<div class="hint">${esc(item.hint)}</div></td></tr>`,
    );
  }

  const noteBlock =
    `<div class="note rise">Приоритет: <b>переопределение в панели</b> &gt; <b>.env</b> (значения по умолчанию). `
    + `Кнопка «По умолчанию» удаляет переопределение. `
    + `Изменение MCP_TOKEN вступает в силу после <span class="val">docker compose restart mcp</span>.</div>`;

  return shell("NoVate MCP — настройки",
    header("settings") + `<div class="wrap">${flash}${noteBlock}`
    + `<div class="panel rise"><table><tbody>${rows.join("")}</tbody></table></div></div>`);
}

// ---------- роутер ----------

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Публичное
  if (method === "GET" && path === "/static/client.js") {
    const f = Bun.file(import.meta.dir + "/public/client.js");
    if (await f.exists()) {
      return new Response(f, {
        headers: { "Content-Type": "text/javascript; charset=utf-8",
                   "Cache-Control": "public, max-age=3600" },
      });
    }
    return new Response("// client.js не собран: выполни bun build client.ts --outdir public", {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }
  if (method === "GET" && path === "/login") return html(loginPage(false));
  if (method === "POST" && path === "/login") {
    const form = await req.formData();
    const token = String(form.get("token") || "");
    if (!tokenOk(token)) return html(loginPage(true), 403);
    const ts = String(Math.floor(Date.now() / 1000));
    return redirect("/", {
      "Set-Cookie": `${COOKIE_NAME}=${ts}.${sign(ts)}; Max-Age=${COOKIE_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  }
  if (path === "/logout") {
    return redirect("/login", {
      "Set-Cookie": `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  // Дальше — только после входа
  if (!authed(req)) return redirect("/login");

  if (method === "GET" && path === "/") return html(indexPage());

  if (method === "GET" && path.startsWith("/browse/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/browse/".length)); } catch { return redirect("/"); }
    return browsePage(rel);
  }

  if (method === "GET" && path.startsWith("/download/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/download/".length)); } catch { return redirect("/"); }
    const target = safePath(rel);
    if (!target) return redirect("/");
    try {
      if (!statSync(target).isFile()) return redirect("/");
    } catch {
      return redirect("/");
    }
    const name = basename(target);
    return new Response(Bun.file(target), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          `attachment; filename="${name.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  }

  if (method === "GET" && path === "/settings") return html(settingsPage(url));

  if (method === "POST" && path === "/settings") {
    const form = await req.formData();
    const key = String(form.get("key") || "");
    const action = String(form.get("action") || "");
    if (!EDITABLE.some((e) => e.key === key)) return redirect("/settings");
    if (action === "reset") {
      settings.clearOverride(key);
      return redirect("/settings?reset=1");
    }
    const value = String(form.get("value") || "").trim();
    if (value) settings.setOverride(key, value);
    return redirect("/settings?saved=1");
  }

  return redirect("/");
}

// ---------- запуск ----------

if (!settings.get("DASH_TOKEN")) {
  throw new Error("DASH_TOKEN is not set! Проверь файл .env");
}

Bun.serve({
  port: 8001,
  async fetch(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (err) {
      console.error(err);
      return html(shell("NoVate MCP — ошибка",
        header("") + `<div class="wrap"><div class="empty rise">Внутренняя ошибка панели.</div></div>`), 500);
    }
  },
});

console.log("NoVate MCP dashboard: http://0.0.0.0:8001");
