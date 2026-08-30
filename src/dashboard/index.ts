/**
 * NoVate MCP — панель управления проектами.
 * TypeScript + Bun: лёгкий HTTP-сервер без фреймворков.
 *
 * Маршруты:
 *   GET  /                  — список проектов + статистика (нужен вход)
 *   GET  /browse/<путь>     — просмотр папки (нужен вход)
 *   GET  /download/<путь>   — скачивание файла (нужен вход)
 *   GET  /download-project/<имя> — архивирование и скачивание проекта (нужен вход)
 *   GET  /backups           — бэкапы: статус, архивы, запуск вручную (нужен вход)
 *   POST /backup-now        — запустить бэкап вне расписания (нужен вход)
 *   POST /backup-upload     — загрузить и проверить локальный бэкап (нужен вход)
 *   POST /restore           — восстановить проекты из архива (нужен вход)
 *   GET  /backup-file/<имя> — скачивание архива бэкапа (нужен вход)
 *   GET  /settings          — настройки (нужен вход)
 *   GET  /monitoring        — состояние сервисов и история алертов
 *   GET  /projects/<путь>   — защищённая публикация проекта
 *   POST /settings          — сохранить/сбросить переопределение (нужен вход)
 *   POST /s3-action         — проверить/синхронизировать/восстановить S3
 *   GET  /login             — страница входа (кнопка «Войти через Telegram»)
 *   GET  /auth/telegram     — старт входа: редирект на Telegram OIDC
 *   GET  /auth/callback     — callback Telegram OIDC (code -> id_token -> сессия)
 *   GET  /logout
 *   GET  /static/client.js  — клиентский JS (собирается bun build при сборке образа)
 */

import {
  createHash, createPublicKey, randomBytes, verify as cryptoVerify,
} from "node:crypto";
import {
  copyFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, statfsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as settings from "./settings.ts";
import { createSessionCodec } from "./session.ts";
import { monitoringHistory, monitoringSnapshot, startMonitoring } from "./monitor.ts";
import { loadVersionsInfo, versionCanBeDeployed } from "./versions.ts";
import { appendAudit, auditEvents, createManagedToken, deployHistory, hostStatus, managedTokens, preflightStatus, readJson, revokeManagedToken } from "./admin.ts";
import { esc, fmtTime, header, humanSize, loginPage, mask, shell, toast } from "./ui.ts";

const DATA_DIR = resolve(process.env.MCP_DATA_DIR || "/data");
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const S3_STATUS_FILE = process.env.S3_STATUS_FILE || "/storage-state/status.json";
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || "/backups");
const COOKIE_NAME = "dash_auth";
const COOKIE_TTL = 7 * 24 * 3600;
const STATE_COOKIE = "oauth_state";
const STATE_TTL = 600;
const MAX_BACKUP_UPLOAD_BYTES = 512 * 1024 * 1024;
const BACKUP_NAME_RE = /^novate-backup-\d{8}-\d{6}(?:-pre-restore)?\.tar\.gz(?:\.enc)?$/;

// Telegram OpenID Connect (https://core.telegram.org/widgets/login)
const TG_AUTH_URL = "https://oauth.telegram.org/auth";
const TG_TOKEN_URL = "https://oauth.telegram.org/token";
const TG_JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
const TG_ISSUER = "https://oauth.telegram.org";

// Редактируемые в панели настройки
type SettingMode = "text" | "external-secret" | "generated-secret";
type SettingSection = "telegram" | "access" | "backups" | "storage" | "versions";
type EditableSetting = {
  key: string; label: string; hint: string; mode: SettingMode; section: SettingSection;
};

const SETTING_SECTIONS: Array<{ id: SettingSection; label: string; description: string }> = [
  { id: "telegram", label: "Telegram", description: "Вход через Telegram и отправка бэкапов в чат." },
  { id: "access", label: "Доступ и безопасность", description: "Сессии панели и токен MCP-доступа." },
  { id: "backups", label: "Бэкапы", description: "Расписание, хранение и шифрование резервных копий." },
  { id: "storage", label: "S3-хранилище", description: "Состояние постоянного хранилища проектов. Изменяется только через .env." },
  { id: "versions", label: "Версии", description: "Установленная версия, доступные релизы и безопасное обновление." },
];

const EDITABLE: EditableSetting[] = [
  { key: "ALLOWED_TG_USERS", label: "Telegram ID с доступом в панель",
    hint: "Редактируйте весь список через запятую: можно дописывать новые ID и удалять старые. Применяется сразу.",
    mode: "text", section: "telegram" },
  { key: "TG_CLIENT_ID", label: "Telegram OIDC Client ID",
    hint: "ID OIDC-приложения из @BotFather. Применяется сразу.", mode: "text", section: "telegram" },
  { key: "TG_CLIENT_SECRET", label: "Telegram OIDC Client Secret",
    hint: "Выдаётся @BotFather, поэтому локально не генерируется. Поле пустое, пока секрет не заменяется.",
    mode: "external-secret", section: "telegram" },
  { key: "SESSION_SECRET", label: "Секрет сессий панели",
    hint: "Генерируется панелью. После замены все текущие сессии завершаются.",
    mode: "generated-secret", section: "access" },
  { key: "MCP_TOKEN", label: "Токен MCP-доступа (Bearer)",
    hint: "Генерируется панелью. MCP-сервис автоматически перечитает токен и перезапустит свой процесс.",
    mode: "generated-secret", section: "access" },
  { key: "TG_BOT_TOKEN", label: "Токен Telegram-бота",
    hint: "Выдаётся @BotFather, поэтому локально не генерируется. Применяется в течение минуты.",
    mode: "external-secret", section: "telegram" },
  { key: "TG_CHAT_ID", label: "ID чата для бэкапов",
    hint: "Можно отредактировать текущее значение или очистить поле. Применяется в течение минуты.",
    mode: "text", section: "telegram" },
  { key: "BACKUP_INTERVAL_HOURS", label: "Интервал бэкапов, часов",
    hint: "Как часто делать бэкап. Применяется в течение минуты.", mode: "text", section: "backups" },
  { key: "BACKUP_KEEP", label: "Локальных копий бэкапов",
    hint: "Столько последних архивов хранится на сервере.", mode: "text", section: "backups" },
  { key: "BACKUP_PASSWORD", label: "Пароль шифрования бэкапов (AES-256)",
    hint: "Генерируется панелью и применяется в течение минуты. Сохраните копию: без неё .enc не расшифровать.",
    mode: "generated-secret", section: "backups" },
];

// ---------- безопасность ----------

const sessionCodec = createSessionCodec(() => settings.get("SESSION_SECRET"));
const packSigned = sessionCodec.packSigned;
const unpackSigned = sessionCodec.unpackSigned;

// Используется также для OAuth state/challenge, которые не являются session cookie.
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieStr(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
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

/** Список Telegram ID, которым разрешён вход в панель. */
function allowedUsers(): Set<string> {
  return new Set(
    settings.get("ALLOWED_TG_USERS").split(/[\s,;]+/).filter(Boolean),
  );
}

type Session = { uid: string; name: string };

/** Сессия из cookie: подпись + срок + allowlist проверяются на каждый запрос. */
function sessionOf(req: Request): Session | null {
  const data = unpackSigned(cookieOf(req, COOKIE_NAME), COOKIE_TTL);
  if (!data || typeof data.uid !== "string") return null;
  if (!allowedUsers().has(data.uid)) return null;
  return { uid: data.uid, name: typeof data.name === "string" ? data.name : "" };
}

function safeReturnTo(value: unknown): string {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/projects/") && !path.startsWith("//") ? path : "/";
}

// ---------- уведомления в Telegram ----------

function tgEsc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Неблокирующее HTML-уведомление в Telegram. Динамические значения передавать через tgEsc(). */
function tgNotify(text: string): void {
  const token = settings.get("TG_BOT_TOKEN");
  const chatId = settings.get("TG_CHAT_ID");
  if (!token || !chatId) return;
  fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch((err) => console.error("tgNotify failed:", err));
}

// ---------- Telegram OIDC ----------

function redirectUri(): string {
  return `https://${settings.get("DOMAIN")}/auth/callback`;
}

type Jwk = {
  kty: string; kid?: string; alg?: string; use?: string;
  n?: string; e?: string; x?: string; y?: string; crv?: string;
};

let jwksCache: { keys: Jwk[]; at: number } | null = null;

async function jwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(TG_JWKS_URL);
  if (!res.ok) throw new Error(`JWKS: HTTP ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: data.keys || [], at: Date.now() };
  return jwksCache.keys;
}

/** Проверка подписи (по JWKS) и claims id_token от Telegram. */
async function verifyIdToken(jwt: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      console.error("id_token: ожидалось 3 части JWT");
      return null;
    }
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
      alg?: string; kid?: string;
    };
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const keys = await jwks();
    const jwk = keys.find((k) => k.kid === head.kid)
      || (keys.length === 1 ? keys[0] : undefined);
    if (!jwk) {
      console.error(`id_token: ключ kid=${head.kid} не найден в JWKS (${keys.length} шт.)`);
      return null;
    }
    const key = createPublicKey({ format: "jwk", key: jwk as JsonWebKey });
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = Buffer.from(parts[2], "base64url");
    let ok: boolean;
    if (head.alg === "RS256") {
      ok = cryptoVerify("RSA-SHA256", signed, key, signature);
    } else if (head.alg === "ES256" || head.alg === "ES256K") {
      ok = cryptoVerify("SHA256", signed, { key, dsaEncoding: "ieee-p1363" }, signature);
    } else if (head.alg === "EdDSA") {
      ok = cryptoVerify(null, signed, key, signature);
    } else {
      console.error(`id_token: неподдержанный alg=${head.alg}`);
      return null;
    }
    if (!ok) {
      console.error("id_token: подпись не прошла проверку");
      return null;
    }
    if (payload.iss !== TG_ISSUER) {
      console.error(`id_token: iss=${String(payload.iss)} — ожидался ${TG_ISSUER}`);
      return null;
    }
    const cid = settings.get("TG_CLIENT_ID");
    const aud = payload.aud;
    // aud (и sub) Telegram может прислать числом, а не строкой — приводим к строке
    const audOk = String(aud) === cid
      || (Array.isArray(aud) && aud.map(String).includes(cid));
    if (!audOk) {
      console.error(`id_token: aud=${JSON.stringify(aud)} не совпал с TG_CLIENT_ID (${cid})`);
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
      console.error("id_token: токен истёк (exp)");
      return null;
    }
    return payload;
  } catch (err) {
    console.error("id_token: исключение при проверке:", err);
    return null;
  }
}

/** Обмен authorization code на токены (Basic auth + PKCE verifier). */
async function exchangeCode(code: string, verifier: string): Promise<Record<string, unknown> | null> {
  try {
    const cid = settings.get("TG_CLIENT_ID");
    const secret = settings.get("TG_CLIENT_SECRET");
    const res = await fetch(TG_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(cid + ":" + secret).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: cid,
        code_verifier: verifier,
      }),
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.error("Telegram token endpoint: HTTP " + res.status + ", не JSON: " + text.slice(0, 200));
      return null;
    }
    // ВАЖНО: Telegram отвечает HTTP 200 даже на ошибки — смотрим поле error
    if (!res.ok || typeof data.error === "string") {
      console.error("Telegram token endpoint: HTTP " + res.status + " — " + text.slice(0, 300));
      return null;
    }
    return data;
  } catch (err) {
    console.error("Telegram token exchange failed:", err);
    return null;
  }
}

/** Пути строго внутри DATA_DIR (защита от ../). */
function isSameOriginPost(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const protocol = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol.replace(":", "");
  if (!origin || !host) return false;
  return origin === `${protocol}://${host}`;
}

function safePath(rel: string): string | null {
  const target = resolve(DATA_DIR, rel.replace(/^\/+/, ""));
  if (target !== DATA_DIR && !target.startsWith(DATA_DIR + "/")) return null;
  return target;
}

// ---------- helpers ответов ----------

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...extra } });
}

/** Редирект с несколькими Set-Cookie. */
function redirectCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
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

function indexPage(url: URL, user: string): string {
  const domain = settings.get("DOMAIN");
  let notification = "";
  if (url.searchParams.has("deleted")) {
    notification = toast(`Проект «${url.searchParams.get("deleted") || ""}» удалён. S3-сверка запущена.`, "success");
  } else if (url.searchParams.get("error") === "project-delete") {
    notification = toast("Не удалось удалить проект. Проверьте, что он существует и является обычной папкой.", "error");
  } else if (url.searchParams.get("error") === "project-origin") {
    notification = toast("Запрос удаления отклонён проверкой источника.", "error");
  } else if (url.searchParams.get("error") === "project-archive") {
    notification = toast("Не удалось начать скачивание проекта.", "error");
  }
  const cards: string[] = [];
  let totalSize = 0;
  let names: string[] = [];
  try {
    names = readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* пусто */ }

  names.forEach((name, i) => {
    const projectDir = DATA_DIR + "/" + name;
    const st = walk(projectDir);
    totalSize += st.size;
    let hasIndex = false;
    try { hasIndex = statSync(projectDir + "/index.html").isFile(); } catch { /* нет index.html */ }
    const openSite = domain && hasIndex
      ? `<a class="tag" href="` + "https://" + esc(domain) + `/projects/${encodeURIComponent(name)}/" target="_blank" rel="noopener">Открыть сайт ↗</a>`
      : "";
    const download = `<a class="tag" href="/download-project/${encodeURIComponent(name)}">Скачать</a>`;
    const remove = `<form class="project-delete-form" method="post" action="/delete-project" data-delete-project="${esc(name)}">`
      + `<input type="hidden" name="project" value="${esc(name)}">`
      + `<button class="project-delete-button" type="submit" title="Удалить проект" aria-label="Удалить проект ${esc(name)}">`
      + `<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z"/></svg>`
      + `</button></form>`;
    cards.push(
      `<div class="card rise" data-filter-item data-name="${esc(name.toLocaleLowerCase("ru"))}" `
      + `data-modified="${st.latest}" data-size="${st.size}" data-files="${st.files}" `
      + `data-kind="${hasIndex ? "site" : "project"}" style="animation-delay:${120 + i * 70}ms">`
      + `<a class="main" href="/browse/${encodeURIComponent(name)}">`
      + `<div class="name">📁 ${esc(name)}</div>`
      + `<div class="meta">${humanSize(st.size)} · изменён ${fmtTime(st.latest)}</div>`
      + `</a><div class="card-actions">${openSite}${download}${remove}</div></div>`,
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
    + `<div class="stat rise"><small>Занято проектами</small><b>${humanSize(totalSize)}</b></div>`
    + `<div class="stat rise"><small>Свободно на диске</small><b>${diskFree}</b></div>`
    + `<div class="stat rise"><small>Аптайм сервера</small><b>${uptime}</b></div></div>`;

  const filters = `<div class="filters rise" data-filter-controls>`
    + `<input type="search" placeholder="Поиск проектов…" aria-label="Поиск проектов" data-filter-search>`
    + `<select aria-label="Показывать" data-filter-kind>`
    + `<option value="all">Все проекты</option><option value="site">Только сайты</option>`
    + `<option value="project">Без index.html</option></select>`
    + `<select aria-label="Период изменения" data-filter-period>`
    + `<option value="all">За всё время</option><option value="1">За сутки</option>`
    + `<option value="7">За 7 дней</option><option value="30">За 30 дней</option></select>`
    + `<select aria-label="Сортировка" data-filter-sort>`
    + `<option value="name">По названию</option><option value="modified">По дате изменения</option>`
    + `<option value="size">По размеру</option><option value="files">По числу файлов</option></select>`
    + `<select aria-label="Порядок" data-filter-order>`
    + `<option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></div>`;

  const body = cards.length
    ? `<div data-filter-root>${filters}<div data-filter-list>${cards.join("")}</div>`
      + `<div class="empty filter-empty" data-filter-empty hidden>Ничего не найдено.</div></div>`
    : `<div class="empty rise">Проектов пока нет.<br>Попроси своего ИИ-агента что-нибудь создать!</div>`;

  return shell("NoVate MCP — проекты",
    header("projects", user) + notification + `<div class="wrap">${stats}${body}</div>`);
}

function browsePage(rel: string, user: string): Response {
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

  const rows = entries.map((entry) => {
    const childRel = rel ? rel + "/" + entry.name : entry.name;
    const q = encodeURIComponent(childRel);
    let size = 0, modified = 0;
    const childPath = target + "/" + entry.name;
    try {
      const stat = statSync(childPath);
      size = stat.size;
      modified = stat.mtimeMs;
      if (entry.isDirectory()) {
        const nested = walk(childPath);
        size = nested.size;
        modified = Math.max(modified, nested.latest);
      }
    } catch { /* недоступно */ }
    const kind = entry.isDirectory() ? "folder" : "file";
    const nameCell = entry.isDirectory()
      ? `📁 <a href="/browse/${q}">${esc(entry.name)}</a>`
      : `📄 ${esc(entry.name)}`;
    const action = entry.isDirectory()
      ? `<a class="btn" href="/download-folder/${q}">Скачать</a>`
      : `<a class="btn" href="/download/${q}">Скачать</a>`;
    return `<tr data-filter-item data-name="${esc(entry.name.toLocaleLowerCase("ru"))}" `
      + `data-kind="${kind}" data-size="${size}" data-modified="${modified}">`
      + `<td>${nameCell}</td><td>${humanSize(size)}</td>`
      + `<td>${esc(fmtTime(modified))}</td><td>${entry.isDirectory() ? "Папка" : "Файл"}</td>`
      + `<td>${action}</td></tr>`;
  });

  const filters = `<div class="filters" data-filter-controls>`
    + `<input type="search" placeholder="Поиск файлов и папок…" aria-label="Поиск файлов и папок" data-filter-search>`
    + `<select aria-label="Тип" data-filter-kind><option value="all">Все типы</option>`
    + `<option value="folder">Папки</option><option value="file">Файлы</option></select>`
    + `<select aria-label="Период изменения" data-filter-period><option value="all">За всё время</option>`
    + `<option value="1">За сутки</option><option value="7">За 7 дней</option>`
    + `<option value="30">За 30 дней</option></select>`
    + `<select aria-label="Сортировка" data-filter-sort><option value="name">По названию</option>`
    + `<option value="modified">По дате изменения</option><option value="size">По размеру</option>`
    + `<option value="kind">По типу</option></select>`
    + `<select aria-label="Порядок" data-filter-order><option value="asc">По возрастанию</option>`
    + `<option value="desc">По убыванию</option></select></div>`;
  const table = rows.length ? rows.join("") : "";

  return html(shell("NoVate MCP — файлы",
    header("", user) + `<div class="wrap rise" data-filter-root>`
    + `<div class="crumb">${crumbs.join(" / ")}</div>${filters}`
    + `<div class="panel"><table><thead><tr><th>Имя</th><th>Размер</th>`
    + `<th>Изменён</th><th>Тип</th><th></th></tr></thead>`
    + `<tbody data-filter-list>${table}</tbody></table>`
    + `<div class="empty filter-empty" data-filter-empty${rows.length ? " hidden" : ""}>`
    + `${rows.length ? "Ничего не найдено." : "Папка пуста."}</div></div></div>`));
}

// ---------- архивы проектов и проверка бэкапов ----------

type ProcessResult = { code: number; stdout: string; stderr: string };

async function runProcess(args: string[]): Promise<ProcessResult> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function streamDirectoryZip(directory: string, downloadName: string): Response {
  // ZIP содержит центральный каталог с размерами каждого файла и нативно открывается
  // проводником Windows. Уровень -1 ускоряет упаковку больших проектов.
  const packed = Bun.spawn([
    "zip", "-r", "-1", "-q", "-", basename(directory),
  ], { cwd: dirname(directory), stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(packed.stderr).text();
  void Promise.all([packed.exited, stderr]).then(([code, message]) => {
    if (code !== 0) console.error("Потоковая ZIP-архивация папки завершилась с ошибкой:", message);
  });
  return new Response(packed.stdout, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition":
        `attachment; filename="${downloadName.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function validateBackupArchive(upload: string, encrypted: boolean): Promise<string | null> {
  const workDir = mkdtempSync(join(os.tmpdir(), "novate-backup-check-"));
  const archive = encrypted ? join(workDir, "backup.tar.gz") : upload;
  try {
    if (encrypted) {
      const password = settings.get("BACKUP_PASSWORD");
      if (!password) return "Для проверки зашифрованного бэкапа сначала задайте BACKUP_PASSWORD.";
      const decrypted = await runProcess([
        "openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2",
        "-pass", "pass:" + password, "-in", upload, "-out", archive,
      ]);
      if (decrypted.code !== 0) return "Не удалось расшифровать бэкап текущим BACKUP_PASSWORD.";
    }

    const listed = await runProcess(["tar", "-tzf", archive]);
    if (listed.code !== 0) return "Файл не является корректным tar.gz-архивом.";
    const names = listed.stdout.split("\n").filter(Boolean);
    if (!names.length) return "Архив пуст.";
    let hasProjects = false;
    for (const raw of names) {
      const name = raw.replace(/^\.\//, "");
      const parts = name.split("/");
      if (name.startsWith("/") || parts.includes("..")) return "Архив содержит небезопасные пути.";
      if (name === "projects" || name === "projects/" || name.startsWith("projects/")) {
        hasProjects = true;
        continue;
      }
      if (name === "dashboard-data/overrides.json") continue;
      return "Структура архива не соответствует бэкапу NoVate MCP.";
    }
    if (!hasProjects) return "В архиве отсутствует корневая папка projects/.";

    const verbose = await runProcess(["tar", "-tvzf", archive]);
    if (verbose.code !== 0) return "Не удалось проверить содержимое архива.";
    for (const line of verbose.stdout.split("\n").filter(Boolean)) {
      const type = line[0];
      if (type !== "-" && type !== "d") {
        return "Архив содержит ссылки или специальные файлы и отклонён из соображений безопасности.";
      }
    }
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------- бэкапы ----------

type BackupStatus = {
  time?: string; file?: string; size?: number; files?: number;
  telegram?: string; reason?: string; error?: string;
  restore?: string; encrypted?: boolean;
};

function backupStatus(): BackupStatus | null {
  try {
    return JSON.parse(readFileSync(BACKUP_DIR + "/last-backup.json", "utf8")) as BackupStatus;
  } catch {
    return null;
  }
}

function backupsPage(url: URL, user: string): string {
  let flash = "";
  if (url.searchParams.has("verified")) {
    flash = toast("Целостность бэкапа проверена: архив безопасно читается и распаковывается.", "success");
  } else if (url.searchParams.has("verify-error")) {
    flash = toast("Проверка целостности бэкапа завершилась ошибкой.", "error");
  } else if (url.searchParams.has("started")) {
    flash = toast("Бэкап запущен — архив появится в списке и Telegram в течение минуты.", "success");
  } else if (url.searchParams.has("restore")) {
    flash = toast("Восстановление запущено. Перед ним создаётся страховочный бэкап.", "success");
  } else if (url.searchParams.has("uploaded")) {
    flash = toast("Бэкап проверен и загружен.", "success");
  } else if (url.searchParams.has("upload-error")) {
    flash = toast(url.searchParams.get("upload-error") || "Не удалось загрузить бэкап.", "error");
  }
  const confirmName = url.searchParams.get("confirm") || "";
  if (confirmName && /^[\w.-]+\.tar\.gz(\.enc)?$/.test(confirmName)) {
    flash += `<div class="note rise" style="border-left-color:#ff5a6e">`
      + `<b>Восстановить проекты из архива ${esc(confirmName)}?</b><br>`
      + `Текущее содержимое проектов будет перезаписано. Перед этим автоматически `
      + `создаётся страховочный бэкап. Настройки панели (overrides.json) не восстанавливаются.`
      + `<form method="post" action="/restore" style="margin-top:12px">`
      + `<input type="hidden" name="file" value="${esc(confirmName)}">`
      + `<button class="btn" type="submit">Да, восстановить</button> `
      + `<a class="btn gray" href="/backups">Отмена</a></form></div>`;
  }

  const st = backupStatus();
  let statusHtml: string;
  if (st?.error) {
    const attemptTime = st.time
      ? `<div class="settings-guide-points"><span>Последняя попытка: ${esc(fmtTime(Date.parse(st.time)))}</span></div>`
      : "";
    statusHtml = `<section class="settings-guide backup-guide backup-guide-error rise">`
      + `<div class="settings-guide-icon" aria-hidden="true">!</div>`
      + `<div class="settings-guide-copy"><span class="settings-guide-kicker">Резервное копирование</span>`
      + `<h1>Не удалось создать резервную копию</h1>`
      + `<p>${esc(st.error)}</p>${attemptTime}</div></section>`;
  } else if (st?.time) {
    const telegramLine = st.telegram === "ok"
      ? "Отправлено в Telegram"
      : st.telegram === "skipped"
        ? "Telegram не настроен — копия сохранена на сервере"
        : st.telegram && st.telegram.startsWith("error")
          ? `Ошибка Telegram: ${esc(st.telegram.slice(7).trim())}`
          : "Статус Telegram неизвестен";
    const intervalH = Number(settings.get("BACKUP_INTERVAL_HOURS")) || 24;
    const next = Date.parse(st.time) + intervalH * 3600_000;
    const nextPoint = Number.isFinite(next)
      ? `<span>Следующая копия: ${esc(fmtTime(next))}</span>`
      : "";
    const restorePoint = st.restore
      ? `<span>Восстановление: ${esc(st.restore)}</span>`
      : "";
    statusHtml = `<section class="settings-guide backup-guide rise">`
      + `<div class="settings-guide-icon" aria-hidden="true">▣</div>`
      + `<div class="settings-guide-copy"><span class="settings-guide-kicker">Резервное копирование</span>`
      + `<h1>Последняя копия готова</h1>`
      + `<p>Архив <b>${esc(st.file || "—")}</b> создан ${esc(fmtTime(Date.parse(st.time)))} `
      + `и доступен для скачивания или восстановления.</p>`
      + `<div class="settings-guide-points"><span>${humanSize(st.size || 0)}</span>`
      + `<span>${st.encrypted ? "Защищено AES-256" : "Без шифрования"}</span>`
      + `<span>${telegramLine}</span>${nextPoint}${restorePoint}</div></div></section>`;
  } else {
    statusHtml = `<section class="settings-guide backup-guide rise">`
      + `<div class="settings-guide-icon" aria-hidden="true">▣</div>`
      + `<div class="settings-guide-copy"><span class="settings-guide-kicker">Резервное копирование</span>`
      + `<h1>Сохраните проекты в надёжной копии</h1>`
      + `<p>Сервис создаст первый архив автоматически по расписанию. При необходимости `
      + `запустите копирование вручную или загрузите готовый бэкап.</p>`
      + `<div class="settings-guide-points"><span>Автоматическое создание по расписанию</span>`
      + `<span>Шифрование настраивается в панели</span>`
      + `<span>Готовый архив можно отправлять в Telegram</span></div></div></section>`;
  }

  const projectOptions = readdirSync(DATA_DIR, { withFileTypes: true }).filter((item) => item.isDirectory())
    .map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join("");
  const verifications = readJson(`${CONFIG_DIR}/backup-verifications.json`);
  let rows = "";
  try {
    rows = readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".tar.gz") || f.endsWith(".tar.gz.enc"))
      .map((f) => {
        let size = 0, mtime = 0;
        try {
          const s = statSync(`${BACKUP_DIR}/${f}`);
          size = s.size; mtime = s.mtimeMs;
        } catch { /* пропускаем */ }
        return { name: f, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) =>
        `<tr><td>🗄 ${esc(f.name)}<br><span class="muted">${(verifications[f.name] as Record<string, unknown> | undefined)?.state === "ok" ? "Целостность проверена" : "Не проверен вручную"}</span></td><td>${humanSize(f.size)}</td><td>${esc(fmtTime(f.mtime))}</td>`
        + `<td><a class="btn" href="/backup-file/${encodeURIComponent(f.name)}">Скачать</a> `
        + `<form class="inline-form" method="post" action="/backup-verify"><input type="hidden" name="file" value="${esc(f.name)}"><button class="btn gray" type="submit">Проверить</button></form>`
        + `<form class="inline-form" method="post" action="/restore"><input type="hidden" name="file" value="${esc(f.name)}"><select name="project"><option value="">Все проекты</option>${projectOptions}</select><button class="btn gray" type="submit">Восстановить</button></form></td></tr>`,
      )
      .join("");
    if (!rows) rows = `<tr><td colspan="4" style="text-align:center;color:var(--muted)">архивов пока нет</td></tr>`;
  } catch {
    rows = `<tr><td colspan="4" style="text-align:center;color:var(--muted)">папка бэкапов недоступна</td></tr>`;
  }

  return shell("NoVate MCP — бэкапы",
    header("backups", user) + flash + `<div class="wrap">${statusHtml}`
    + `<div class="backup-actions rise"><form method="post" action="/backup-now">`
    + `<button class="btn" type="submit">Сделать бэкап сейчас</button></form>`
    + `<form method="post" action="/backup-upload" enctype="multipart/form-data" class="upload-form">`
    + `<label class="btn gray upload-button" for="backup-upload">`
    + `<span data-upload-text>Загрузить бэкап</span>`
    + `<input id="backup-upload" type="file" name="backup" accept=".tar.gz,.tar.gz.enc,.enc" `
    + `data-auto-submit-file required></label></form></div>`
    + `<div class="panel rise" style="margin-top:24px"><table>`
    + `<thead><tr><th>Архив</th><th>Размер</th><th>Дата</th><th></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div></div>`);
}

type GeneratedSecret = { key: string; value: string };

function generatedSecretToast(secret: GeneratedSecret): string {
  const suffix = secret.key.startsWith("MCP_TOKEN")
    ? " MCP-сервис автоматически применит его в течение нескольких секунд."
    : secret.key === "SESSION_SECRET"
      ? " Текущая сессия завершится после перехода на другую страницу."
      : " Сохраните значение: оно понадобится для расшифровки бэкапов.";
  return `<div class="toast-stack"><div class="toast toast-success" data-toast data-toast-duration="15000" style="--toast-duration:15s" role="status">`
    + `<span><b>${esc(secret.key)} создан.</b>${esc(suffix)}`
    + `<code class="generated-secret" data-generated-secret>${esc(secret.value)}</code>`
    + `<button class="btn secret-copy" type="button" data-copy-secret>Копировать</button></span>`
    + `<button class="toast-close" type="button" aria-label="Закрыть">×</button></div></div>`;
}

function tokenManagementHtml(): string {
  const rows = managedTokens().map((item) => `<tr><td><b>${esc(item.name)}</b></td><td>${esc(item.role)}</td>`
    + `<td>${esc(fmtTime(Date.parse(item.createdAt)))}</td><td><form method="post" action="/token-revoke">`
    + `<input type="hidden" name="id" value="${esc(item.id)}"><button class="btn gray" type="submit">Отозвать</button></form></td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">Дополнительных токенов нет</td></tr>`;
  return `<div class="settings-group"><div class="settings-group-head"><div><span class="settings-group-kicker">Ограниченные токены</span>`
    + `<h3>Роли MCP-доступа</h3><p>Reader читает данные, editor также изменяет файлы, operator запускает команды, удаление и бэкапы.</p></div></div>`
    + `<form class="version-form" method="post" action="/token-create"><label>Название</label><input name="name" maxlength="80" required>`
    + `<label>Роль</label><select name="role"><option value="reader">Reader</option><option value="editor">Editor</option><option value="operator">Operator</option></select>`
    + `<button class="btn" type="submit">Создать токен</button></form><div class="panel"><table><thead><tr><th>Название</th><th>Роль</th><th>Создан</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function deployOperationsHtml(): string {
  const host = hostStatus();
  const runner = host.runner && typeof host.runner === "object" ? host.runner as Record<string, unknown> : {};
  const runnerOk = runner.active === "active" && runner.enabled === "enabled";
  const preflight = preflightStatus();
  const history = deployHistory().map((item) => `<tr><td>${esc(String(item.version || "—"))}</td><td>${esc(String(item.state || "—"))}</td>`
    + `<td>${esc(fmtTime(Date.parse(String(item.finishedAt || item.requestedAt || ""))))}</td><td>${item.log ? `<a href="/deploy-log/${encodeURIComponent(String(item.log))}">Открыть лог</a>` : "—"}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">Обновлений пока не было</td></tr>`;
  return `<div class="settings-group"><div class="settings-group-head"><div><span class="settings-group-kicker">Диагностика</span><h3>Хостовый runner</h3>`
    + `<p>${runnerOk ? "Runner установлен, включён и готов принимать запросы." : "Runner не подтверждён. Запустите актуальный install.sh и проверьте systemd-unit."}</p></div></div>`
    + `<div class="version-deploy-status ${runnerOk ? "success" : "error"}"><i></i><div><b>${runnerOk ? "Runner готов" : "Runner недоступен"}</b><p>Статус обновлён ${esc(fmtTime(Date.parse(String(host.updatedAt || ""))))}</p></div></div>`
    + `<form class="version-form" method="post" action="/version-preflight"><label>Версия для проверки</label><input name="version" placeholder="26.8.1.786" required>`
    + `<button class="btn gray" type="submit">Проверить релиз</button></form>`
    + (preflight.state ? `<p class="muted"><b>${esc(String(preflight.version || ""))}:</b> ${esc(String(preflight.message || preflight.state))}</p>` : "")
    + `</div><div class="settings-group"><div class="settings-group-head"><div><span class="settings-group-kicker">История deploy</span><h3>Последние операции</h3></div></div>`
    + `<div class="panel"><table><thead><tr><th>Версия</th><th>Результат</th><th>Время</th><th>Журнал</th></tr></thead><tbody>${history}</tbody></table></div></div>`;
}

function operationsMonitoringHtml(): string {
  const host = hostStatus();
  const containers = Array.isArray(host.containers) ? host.containers as Array<Record<string, unknown>> : [];
  const containerRows = containers.map((item) => `<tr><td><b>${esc(String(item.name || "—"))}</b></td><td>${esc(String(item.state || "unknown"))}</td>`
    + `<td>${esc(String(item.health || "—"))}</td><td>${esc(String(item.image || "—"))}</td><td>${esc(String(item.restarts || 0))}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted">Хостовый collector ещё не передал данные. Запустите актуальный install.sh.</td></tr>`;
  const auditRows = auditEvents(100).map((item) => `<tr><td>${esc(fmtTime(Date.parse(item.time)))}</td><td>${esc(item.actor)}</td><td>${esc(item.action)}</td><td>${esc(item.target)}</td><td>${esc(item.result)}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted">Событий пока нет</td></tr>`;
  return `<div class="settings-group"><div class="settings-group-head"><div><span class="settings-group-kicker">Контейнеры</span><h3>Состояние сервисов</h3></div></div>`
    + `<div class="panel"><table><thead><tr><th>Сервис</th><th>Состояние</th><th>Healthcheck</th><th>Образ</th><th>Рестарты</th></tr></thead><tbody>${containerRows}</tbody></table></div></div>`
    + `<div class="settings-group"><div class="settings-group-head"><div><span class="settings-group-kicker">Аудит</span><h3>Последние действия</h3></div></div>`
    + `<div class="panel"><table><thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Объект</th><th>Результат</th></tr></thead><tbody>${auditRows}</tbody></table></div></div>`;
}

function monitoringPage(user: string): string {
  const data = monitoringSnapshot();
  const drill = data.restoreDrill;
  const state = data.problems.length ? "Есть предупреждения" : "Все системы работают";
  const cards = [
    ["Общее состояние", state, data.problems.length ? "error" : "ok"],
    ["Свободно на диске", `${data.disk.freePercent}%`, data.disk.freePercent < 10 ? "error" : "ok"],
    ["Очередь S3", String(data.s3.pending || 0), data.s3.connection === "error" ? "error" : "ok"],
    ["Restore drill", drill.state === "ok" ? "Проверка пройдена" : drill.state === "error" ? "Ошибка" : "Нет данных", drill.state === "error" ? "error" : "ok"],
  ].map(([label, value, kind]) => `<div class="monitor-card ${kind}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");
  const problems = data.problems.length
    ? data.problems.map((item) => `<div class="monitor-problem"><b>${esc(item.title)}</b><span>${esc(item.detail)}</span></div>`).join("")
    : `<div class="empty compact">Активных предупреждений нет.</div>`;
  const events = monitoringHistory().map((item) => `<tr><td>${esc(fmtTime(Date.parse(item.time)))}</td>`
    + `<td><span class="storage-state ${item.state === "error" ? "error" : "ok"}"><i></i>${item.state === "error" ? "Ошибка" : "Восстановлено"}</span></td>`
    + `<td><b>${esc(item.title)}</b><br><span class="muted">${esc(item.detail)}</span></td></tr>`).join("")
    || `<tr><td colspan="3" class="muted">Событий пока нет</td></tr>`;
  return shell("NoVate MCP — мониторинг", header("monitoring", user)
    + `<div class="wrap"><section class="settings-guide rise"><div class="settings-guide-icon">◉</div>`
    + `<div class="settings-guide-copy"><span class="settings-guide-kicker">Мониторинг</span><h1>${esc(state)}</h1>`
    + `<p>Панель контролирует S3, heartbeat бэкапов, restore drill и свободное место. Новые ошибки и восстановления отправляются в Telegram.</p></div></section>`
    + `<div class="monitor-grid rise">${cards}</div><div class="monitor-problems rise">${problems}</div>`
    + `<div class="panel rise"><table><thead><tr><th>Время</th><th>Состояние</th><th>Событие</th></tr></thead><tbody>${events}</tbody></table></div>`
    + operationsMonitoringHtml() + `</div>`);
}

function settingsPage(url: URL, user: string, generated?: GeneratedSecret): string {
  let flash = generated ? generatedSecretToast(generated) : "";
  if (!generated && url.searchParams.has("saved")) {
    flash = toast("Настройка сохранена.", "success");
  } else if (!generated && url.searchParams.has("reset")) {
    flash = toast("Переопределение сброшено — снова действует значение из .env.", "success");
  } else if (!generated && url.searchParams.has("s3-action")) {
    flash = toast("Команда S3 принята. Статус обновится в течение нескольких секунд.", "success");
  } else if (!generated && url.searchParams.has("version-requested")) {
    flash = toast("Обновление принято. Хостовый deploy-runner выполнит проверяемый deploy с rollback.", "success");
  } else if (!generated && url.searchParams.has("version-error")) {
    const reason = url.searchParams.get("version-error") || "request";
    const messages: Record<string, string> = {
      origin: "Запрос отклонён: источник страницы не совпал с доменом панели.",
      version: "Релиз не найден среди опубликованных GitHub Releases.",
      runner: "Хостовый deploy-runner не работает. Запустите актуальный install.sh и проверьте systemd.",
      preflight: "Сначала выполните предварительную проверку выбранной версии.",
      busy: "Другой запрос на обновление уже ожидает обработки runner.",
      permission: "Панель не может записать deploy-запрос: проверьте права dashboard-data.",
      request: "Не удалось создать запрос на обновление. Проверьте диагностику runner.",
    };
    flash = toast(messages[reason] || messages.request, "error");
  } else if (!generated && url.searchParams.has("preflight-requested")) {
    flash = toast("Предварительная проверка поставлена в очередь. Результат появится в течение 30 секунд.", "success");
  }

  const rows: Record<SettingSection, string[]> = {
    telegram: [], access: [], backups: [], storage: [], versions: [],
  };
  for (const item of EDITABLE) {
    const effective = settings.get(item.key);
    const src = settings.source(item.key);
    const badge = src === "panel"
      ? `<span class="badge panel">панель</span>`
      : `<span class="badge env">.env</span>`;
    const resetBtn = src === "panel"
      ? `<button class="btn gray" form="reset-${esc(item.key)}">По умолчанию</button>`
      : "";

    let editor: string;
    if (item.mode === "generated-secret") {
      editor = `<form class="inline" method="post" action="/settings">`
        + `<input type="hidden" name="key" value="${esc(item.key)}">`
        + `<button class="btn" type="submit" name="action" value="generate">Сгенерировать новый</button>`
        + `${resetBtn}</form>`;
    } else {
      const inputType = item.mode === "external-secret" ? "password" : "text";
      const value = item.mode === "text" ? ` value="${esc(effective)}"` : "";
      const placeholder = item.mode === "external-secret"
        ? "Вставьте новый секрет"
        : "Отредактируйте текущее значение";
      editor = `<form class="inline" method="post" action="/settings">`
        + `<input type="hidden" name="key" value="${esc(item.key)}">`
        + `<input type="${inputType}" name="value"${value} placeholder="${placeholder}">`
        + `<button class="btn" type="submit" name="action" value="save">Сохранить</button>${resetBtn}</form>`;
    }

    rows[item.section].push(
      `<tr><td style="width:210px"><div class="setting-name"><b>${esc(item.key)}</b>${badge}</div>`
      + `<div class="hint">${esc(item.label)}</div></td>`
      + `<td>${editor}`
      + `<form id="reset-${esc(item.key)}" method="post" action="/settings">`
      + `<input type="hidden" name="key" value="${esc(item.key)}">`
      + `<input type="hidden" name="action" value="reset"></form>`
      + `<div class="hint">${esc(item.hint)}</div></td></tr>`,
    );
  }

  const s3Enabled = ["1", "true", "yes", "on"].includes(
    (process.env.S3_ENABLED || "false").trim().toLowerCase(),
  );
  let s3Endpoint = process.env.S3_ENDPOINT || "—";
  try {
    const parsed = new URL(s3Endpoint);
    parsed.username = ""; parsed.password = "";
    s3Endpoint = parsed.toString().replace(/\/$/, "");
  } catch { /* показываем исходное не-секретное значение */ }
  const s3Info: Array<[string, string]> = [
    ["S3_ENABLED", s3Enabled ? "Включено" : "Выключено — используется локальный режим"],
    ["S3_ENDPOINT", s3Endpoint],
    ["S3_BUCKET", process.env.S3_BUCKET || "—"],
    ["S3_REGION", process.env.S3_REGION || "—"],
    ["S3_PREFIX", process.env.S3_PREFIX || "projects/"],
    ["S3_ACCESS_KEY", process.env.S3_ACCESS_KEY ? mask(process.env.S3_ACCESS_KEY) : "—"],
    ["S3_SECRET_KEY", process.env.S3_SECRET_KEY ? "Настроен" : "Не задан"],
    ["S3_EXCLUDE", process.env.S3_EXCLUDE || "Только встроенные исключения"],
  ];
  const s3ConfigRows = s3Info.map(([key, value]) =>
    `<tr><td style="width:210px"><div class="setting-name"><b>${esc(key)}</b>`
    + `<span class="badge env">.env</span></div></td><td>${esc(value)}</td></tr>`,
  ).join("");

  let s3Status: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(S3_STATUS_FILE, "utf8"));
    if (parsed && typeof parsed === "object") s3Status = parsed;
  } catch { /* MCP ещё не создал status.json или S3 выключен */ }
  if (!s3Enabled) s3Status = {};
  const statusResult = s3Status.last_result && typeof s3Status.last_result === "object"
    ? s3Status.last_result as Record<string, unknown> : {};
  const startup = s3Status.startup && typeof s3Status.startup === "object"
    ? s3Status.startup as Record<string, unknown> : {};
  const startupState = String(startup.state || "idle");
  const startupCurrent = Math.max(0, Number(startup.current || 0));
  const startupTotal = Math.max(1, Number(startup.total || 1));
  const startupPercent = Math.min(100, Math.round(startupCurrent / startupTotal * 100));
  const phaseLabels: Record<string, string> = {
    outbox: "Обработка очереди", merge: "Сверка локальных и S3-файлов",
    reconcile: "Финальная проверка", complete: "Синхронизация завершена",
    error: "Ошибка синхронизации",
  };
  const startupPhase = phaseLabels[String(startup.phase || "")] || "Ожидание запуска";
  const connection = !s3Enabled ? "Отключено"
    : startupState === "running" ? "Фоновая синхронизация"
    : startupState === "error" || s3Status.connection === "error" ? "Ошибка"
    : s3Status.connection === "ok" ? "Подключено" : "Запускается";
  const statusTime = (value: unknown): string => {
    if (typeof value !== "string" || !value) return "—";
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? fmtTime(parsed) : value;
  };
  const runtimeInfo: Array<[string, string]> = [
    ["Фоновая сверка", startupState === "running"
      ? `${startupPhase}: ${startupCurrent}/${startupTotal} (${startupPercent}%)`
      : startupPhase],
    ["Операций в очереди", String(s3Status.pending ?? 0)],
    ["Статус обновлён", statusTime(s3Status.updated_at)],
    ["Последняя успешная операция", statusTime(s3Status.last_success)],
    ["Последняя полная сверка", statusTime(s3Status.last_reconcile)],
    ["Последний результат", `PUT: ${statusResult.uploaded ?? 0}, DELETE: ${statusResult.deleted ?? 0}, `
      + `скачано: ${statusResult.downloaded ?? 0}`],
    ["Последняя ошибка", String(s3Status.last_error || "—")],
  ];
  const connectionClass = connection === "Подключено" ? "ok"
    : connection === "Ошибка" ? "error" : connection === "Отключено" ? "off" : "wait";
  const startupProgress = s3Enabled ? `<div class="storage-progress" data-storage-progress>`
    + `<div class="storage-progress-head"><span data-storage-phase>${esc(startupPhase)}</span>`
    + `<b data-storage-count>${startupCurrent}/${startupTotal} · ${startupPercent}%</b></div>`
    + `<div class="storage-progress-track"><i data-storage-bar style="width:${startupPercent}%"></i></div></div>` : "";
  const s3RuntimeRows = `<tr><td style="width:210px"><div class="setting-name"><b>Состояние</b></div></td>`
    + `<td><span class="storage-state ${connectionClass}"><i></i>${esc(connection)}</span></td></tr>`
    + runtimeInfo.map(([key, value]) =>
      `<tr><td style="width:210px"><div class="setting-name"><b>${esc(key)}</b></div></td>`
      + `<td>${esc(value)}</td></tr>`,
    ).join("");

  const noteBlock =
    `<section class="settings-guide rise">`
    + `<div class="settings-guide-icon" aria-hidden="true">⚙</div>`
    + `<div class="settings-guide-copy"><span class="settings-guide-kicker">Центр управления</span>`
    + `<h1>Настройте сервисы под свою работу</h1>`
    + `<p>Параметры разделены по назначению. Изменяемые значения сохраняются в панели, `
    + `а системные параметры с бейджем <b>.env</b> управляются только через файл окружения.</p>`
    + `<div class="settings-guide-points"><span>Изменения применяются автоматически</span>`
    + `<span>Секреты не отображаются открыто</span>`
    + `<span>«По умолчанию» возвращает значение из .env</span></div></div></section>`;

  const requestedTab = url.searchParams.get("tab") as SettingSection | null;
  const activeTab = SETTING_SECTIONS.some((section) => section.id === requestedTab)
    ? requestedTab as SettingSection
    : "telegram";
  const tabs = `<div class="settings-tabs rise" role="tablist" aria-label="Разделы настроек">`
    + SETTING_SECTIONS.map((section) =>
      `<button type="button" role="tab" data-settings-tab="${section.id}" `
      + `aria-controls="settings-${section.id}" aria-selected="${section.id === activeTab}">`
      + `${esc(section.label)}</button>`,
    ).join("") + `</div>`;
  const storageContent =
    `<div class="settings-group"><div class="settings-group-head"><div>`
    + `<span class="settings-group-kicker">Конфигурация</span><h3>Параметры подключения</h3>`
    + `<p>Значения только для чтения. Изменяются в .env и применяются после пересоздания контейнеров.</p>`
    + `</div></div><div class="panel"><table><tbody>${s3ConfigRows}</tbody></table></div></div>`
    + `<div class="settings-group"><div class="settings-group-head"><div>`
    + `<span class="settings-group-kicker">Мониторинг</span><h3>Состояние и синхронизация</h3>`
    + `<p>Текущий статус MCP, постоянной очереди и последней сверки рабочей копии с S3.</p>`
    + `</div></div>${startupProgress}<div class="panel"><table><tbody>${s3RuntimeRows}</tbody></table></div></div>`
    + `<div class="settings-group"><div class="settings-group-head"><div>`
    + `<span class="settings-group-kicker">Ручное управление</span><h3>Операции с хранилищем</h3>`
    + `<p>Каждое действие выполняет отдельную задачу и не меняет параметры подключения.</p>`
    + `</div></div>`
    + (s3Enabled
      ? `<div class="s3-actions-grid">`
        + `<article class="s3-action-card"><div class="s3-action-icon">◉</div><h4>Проверка подключения</h4>`
        + `<p>Проверит endpoint, ключи, bucket и права на чтение, запись и удаление.</p>`
        + `<form method="post" action="/s3-action"><button class="btn gray" name="action" value="check">Проверить подключение</button></form></article>`
        + `<article class="s3-action-card featured"><div class="s3-action-icon">↻</div><h4>Полная синхронизация</h4>`
        + `<p>Обработает очередь и сразу сверит локальную рабочую копию с объектами S3.</p>`
        + `<form method="post" action="/s3-action"><button class="btn" name="action" value="sync">Синхронизировать сейчас</button></form></article>`
        + `<article class="s3-action-card"><div class="s3-action-icon">↓</div><h4>Восстановление файлов</h4>`
        + `<p>Скачает только отсутствующие локально файлы, не перезаписывая существующие.</p>`
        + `<form method="post" action="/s3-action"><button class="btn gray" name="action" value="recover">Восстановить отсутствующие</button></form></article>`
        + `</div>`
      : `<div class="s3-disabled"><b>S3-хранилище отключено</b>`
        + `<p>Установите S3_ENABLED=true и заполните обязательные параметры в .env, чтобы открыть ручные операции.</p></div>`)
    + `</div>`;
  let deployStatus: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(`${CONFIG_DIR}/deploy-status.json`, "utf8"));
    if (parsed && typeof parsed === "object") deployStatus = parsed;
  } catch { /* deploy ещё не запускался */ }
  const installed = (process.env.NOVATE_VERSION || "latest").trim() || "latest";
  const deployState = String(deployStatus.state || "idle");
  const deployMessage = String(deployStatus.message || "Обновления из панели ещё не запускались.");
  const deployVersion = String(deployStatus.version || "");
  const deployUpdated = statusTime(deployStatus.updated_at);
  const versionContent = `<div class="version-shell" data-versions-root data-installed="${esc(installed)}">`
    + `<div class="version-grid">`
    + `<article class="version-card"><span>Текущая версия</span><b>${esc(installed)}</b>`
    + `<p>${installed === "latest" ? "Показывает канал обновлений: при следующем развёртывании будет выбран свежий образ из main." : "Показывает релиз NoVate MCP, который сейчас запущен на сервере."}</p></article>`
    + `<article class="version-card" data-version-summary><span>Последняя доступная версия</span>`
    + `<b data-version-latest>Проверяем GitHub Releases…</b><p data-version-message>Сверяем текущую установку с опубликованными релизами.</p></article>`
    + `</div>`
    + `<div class="settings-group"><div class="settings-group-head"><div>`
    + `<span class="settings-group-kicker">Обновление</span><h3>Выберите опубликованный релиз</h3>`
    + `<p>Панель создаёт только подписанный запрос. Отдельный хостовый runner запускает deploy.sh, проверяет Cosign, readiness и выполняет rollback при ошибке.</p>`
    + `</div></div><form class="version-form" method="post" action="/version-update" data-version-form>`
    + `<label for="version-select">Версия</label><select id="version-select" name="version" data-version-select disabled>`
    + `<option>Загрузка списка релизов…</option></select>`
    + `<button class="btn" type="submit" data-version-submit disabled>Установить версию</button></form>`
    + `<a class="release-link" href="https://github.com/NoVate911/novate-mcp/releases" target="_blank" rel="noreferrer">Открыть релизы на GitHub ↗</a></div>`
    + `<div class="settings-group"><div class="settings-group-head"><div>`
    + `<span class="settings-group-kicker">Статус обновления</span><h3>Последняя операция</h3></div></div>`
    + `<div class="version-deploy-status ${esc(deployState)}"><i></i><div><b>${esc(deployMessage)}</b>`
    + `<p>${deployVersion ? `Версия ${esc(deployVersion)} · ` : ""}${esc(deployUpdated)}</p></div></div></div>`
    + deployOperationsHtml() + `</div>`;

  const panels = SETTING_SECTIONS.map((section) =>
    `<section class="settings-panel" id="settings-${section.id}" role="tabpanel" `
    + `data-settings-panel="${section.id}"${section.id === activeTab ? "" : " hidden"}>`
    + (section.id === "storage" || section.id === "versions" ? ""
      : `<div class="settings-section-head"><h2>${esc(section.label)}</h2>`
        + `<p>${esc(section.description)}</p></div>`)
    + (section.id === "storage" ? storageContent
      : section.id === "versions" ? versionContent
      : section.id === "access" ? `<div class="panel"><table><tbody>${rows[section.id].join("")}</tbody></table></div>${tokenManagementHtml()}`
      : `<div class="panel"><table><tbody>${rows[section.id].join("")}</tbody></table></div>`)
    + `</section>`,
  ).join("");

  return shell("NoVate MCP — настройки",
    header("settings", user) + flash + `<div class="wrap">${noteBlock}${tabs}${panels}</div>`);
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
                   "Cache-Control": "no-store" },
      });
    }
    return new Response("// client.js не собран: выполни bun build client.ts --outdir public", {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  // ---- Вход через Telegram OIDC ----
  if (method === "GET" && path === "/login") {
    const err = url.searchParams.get("err");
    const msg =
      err === "denied"
        ? "Этот Telegram-аккаунт не в списке разрешённых (ALLOWED_TG_USERS)."
        : err === "state"
          ? "Сессия входа устарела. Попробуйте ещё раз."
          : err === "exchange"
            ? "Не удалось обменять код на токен. Подробности — в логах: docker compose logs dashboard"
            : err === "verify"
              ? "Telegram прислал некорректный id_token. Подробности — в логах: docker compose logs dashboard"
              : err === "token"
                ? "Telegram не подтвердил вход. Попробуйте ещё раз."
                : null;
    return html(loginPage(msg), err ? 403 : 200);
  }

  if (method === "GET" && path === "/auth/telegram") {
    const state = randomBytes(16).toString("hex");
    const returnTo = safeReturnTo(url.searchParams.get("next"));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      client_id: settings.get("TG_CLIENT_ID"),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: "openid profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return redirect(`${TG_AUTH_URL}?${params.toString()}`, {
      "Set-Cookie": cookieStr(STATE_COOKIE,
        packSigned({ state, verifier, returnTo, ts: Math.floor(Date.now() / 1000) }), STATE_TTL),
    });
  }

  if (method === "GET" && path === "/auth/callback") {
    const clearState = cookieStr(STATE_COOKIE, "", 0);
    const saved = unpackSigned(cookieOf(req, STATE_COOKIE), STATE_TTL);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (!saved || saved.state !== state || !code) {
      console.error(`OIDC callback: state не сошёлся (cookie=${saved ? "ok" : "нет"}, code=${code ? "есть" : "нет"})`);
      return redirect("/login?err=state", { "Set-Cookie": clearState });
    }
    const tokens = await exchangeCode(code, String(saved.verifier));
    if (!tokens || typeof tokens.id_token !== "string") {
      console.error("OIDC callback: нет id_token в ответе, поля: " + (tokens ? Object.keys(tokens).join(",") : "null"));
      return redirect("/login?err=exchange", { "Set-Cookie": clearState });
    }
    const claims = await verifyIdToken(tokens.id_token);
    if (!claims) {
      console.error("OIDC callback: id_token не прошёл проверку (деталь выше)");
      return redirect("/login?err=verify", { "Set-Cookie": clearState });
    }
    // sub может прийти числом — приводим к строке
    const sub = typeof claims.sub === "string" ? claims.sub
      : typeof claims.sub === "number" ? String(claims.sub) : null;
    if (!sub) {
      console.error(`OIDC callback: нет sub в claims (${Object.keys(claims).join(",")})`);
      return redirect("/login?err=verify", { "Set-Cookie": clearState });
    }
    if (!allowedUsers().has(sub)) {
      console.log(`Отказано во входе: Telegram ID ${sub} не в ALLOWED_TG_USERS`);
      tgNotify(`⛔ <b>Вход отклонён</b>

`
        + `<b>Панель:</b> NoVate MCP
`
        + `<b>Telegram ID:</b> <code>${tgEsc(sub)}</code>
`
        + `<b>Причина:</b> пользователь отсутствует в списке разрешённых.`);
      return redirect("/login?err=denied", { "Set-Cookie": clearState });
    }
    const name = typeof claims.name === "string" && claims.name
      ? claims.name
      : typeof claims.preferred_username === "string" && claims.preferred_username
        ? "@" + claims.preferred_username
        : `ID ${sub}`;
    const session = packSigned({ uid: sub, name, ts: Math.floor(Date.now() / 1000) });
    tgNotify(`🔐 <b>Выполнен вход в панель</b>

`
      + `<b>Пользователь:</b> ${tgEsc(name)}
`
      + `<b>Telegram ID:</b> <code>${tgEsc(sub)}</code>`);
    return redirectCookies(safeReturnTo(saved.returnTo), [
      clearState,
      cookieStr(COOKIE_NAME, session, COOKIE_TTL),
    ]);
  }

  if (path === "/logout") {
    return redirect("/login", { "Set-Cookie": cookieStr(COOKIE_NAME, "", 0) });
  }

  // Дальше — только после входа
  const session = sessionOf(req);
  if (!session) {
    if (method === "GET" && path.startsWith("/projects/")) {
      return redirect(`/auth/telegram?next=${encodeURIComponent(path)}`);
    }
    return redirect("/login");
  }

  if (method === "GET" && path === "/api/versions") {
    try {
      const info = await loadVersionsInfo();
      return new Response(JSON.stringify(info), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (err) {
      console.error("Не удалось проверить GitHub Releases:", err);
      return new Response(JSON.stringify({ error: "Не удалось получить список релизов GitHub." }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }

  if (method === "GET" && path === "/api/storage-status") {
    let status: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(S3_STATUS_FILE, "utf8"));
      if (parsed && typeof parsed === "object") status = parsed;
    } catch { /* S3 disabled or status not created yet */ }
    return new Response(JSON.stringify({
      connection: status.connection || "initializing",
      pending: status.pending || 0,
      startup: status.startup || {},
      updated_at: status.updated_at || null,
      last_error: status.last_error || "",
    }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  if (method === "GET" && path === "/") return html(indexPage(url, session.name));

  if (method === "GET" && path.startsWith("/projects/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/projects/".length)); } catch { return new Response("Not found", { status: 404 }); }
    let target = safePath(rel);
    if (!target) return new Response("Not found", { status: 404 });
    try {
      const info = statSync(target);
      if (info.isDirectory()) {
        if (!path.endsWith("/")) return redirect(path + "/");
        target = join(target, "index.html");
      }
      if (!statSync(target).isFile()) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(target), { headers: { "Cache-Control": "private, no-cache" } });
    } catch { return new Response("Not found", { status: 404 }); }
  }

  if (method === "GET" && path.startsWith("/browse/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/browse/".length)); } catch { return redirect("/"); }
    return browsePage(rel, session.name);
  }

  if (method === "POST" && path === "/delete-project") {
    if (!isSameOriginPost(req)) return redirect("/?error=project-origin");
    const form = await req.formData();
    const name = String(form.get("project") || "");
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      return redirect("/?error=project-delete");
    }
    const target = safePath(name);
    if (!target || dirname(target) !== DATA_DIR) return redirect("/?error=project-delete");
    try {
      const info = lstatSync(target);
      if (!info.isDirectory() || info.isSymbolicLink()) return redirect("/?error=project-delete");
      rmSync(target, { recursive: true, force: false });
      appendAudit(session.name, "project.delete", name);
      // Immediate reconcile removes the same project from S3; disabled S3 safely ignores it.
      writeFileSync(`${CONFIG_DIR}/s3-action.json`, JSON.stringify({
        action: "sync", requested_at: new Date().toISOString(), requested_by: session.uid,
        reason: "project-delete", project: name,
      }), "utf8");
      tgNotify(`🗑️ <b>Проект удалён</b>

<b>Проект:</b> <code>${tgEsc(name)}</code>
<b>Пользователь:</b> ${tgEsc(session.name)}
<i>Запущена S3-сверка.</i>`);
      return redirect("/?deleted=" + encodeURIComponent(name));
    } catch (err) {
      console.error("Не удалось удалить проект:", err);
      return redirect("/?error=project-delete");
    }
  }

  if (method === "GET" && path.startsWith("/download-project/")) {
    let name = "";
    try { name = decodeURIComponent(path.slice("/download-project/".length)); } catch { return redirect("/"); }
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return redirect("/");
    const target = safePath(name);
    if (!target) return redirect("/");
    try {
      if (!statSync(target).isDirectory()) return redirect("/");
      return streamDirectoryZip(target, name + ".zip");
    } catch (err) {
      console.error("Не удалось начать потоковую ZIP-архивацию проекта:", err);
      return redirect("/?error=project-archive");
    }
  }

  if (method === "GET" && path.startsWith("/download-folder/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/download-folder/".length)); } catch { return redirect("/"); }
    const target = safePath(rel);
    if (!target) return redirect("/");
    try {
      if (!statSync(target).isDirectory() || target === DATA_DIR) return redirect("/");
      return streamDirectoryZip(target, basename(target) + ".zip");
    } catch (err) {
      console.error("Не удалось начать потоковую ZIP-архивацию папки:", err);
      return redirect("/browse/" + encodeURIComponent(dirname(rel)));
    }
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

  if (method === "GET" && path === "/backups") return html(backupsPage(url, session.name));

  if (method === "POST" && path === "/backup-now") {
    // Файл-триггер для сервиса бэкапов (он следит за /config/backup-now)
    try {
      writeFileSync(`${CONFIG_DIR}/backup-now`, String(Date.now()), "utf8");
      appendAudit(session.name, "backup.create", "manual");
    } catch (err) {
      console.error("Не удалось создать триггер бэкапа:", err);
    }
    return redirect("/backups?started=1");
  }

  if (method === "POST" && path === "/backup-upload") {
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (contentLength > MAX_BACKUP_UPLOAD_BYTES + 1024 * 1024) {
      return redirect("/backups?upload-error=" + encodeURIComponent("Файл слишком большой (лимит 512 МБ)."));
    }
    const tempDir = mkdtempSync(join(os.tmpdir(), "novate-backup-upload-"));
    try {
      const form = await req.formData();
      const file = form.get("backup");
      if (!(file instanceof File) || !file.size) {
        return redirect("/backups?upload-error=" + encodeURIComponent("Выберите непустой файл бэкапа."));
      }
      if (file.size > MAX_BACKUP_UPLOAD_BYTES) {
        return redirect("/backups?upload-error=" + encodeURIComponent("Файл слишком большой (лимит 512 МБ)."));
      }
      const name = basename(file.name);
      if (name !== file.name || !BACKUP_NAME_RE.test(name)) {
        return redirect("/backups?upload-error=" + encodeURIComponent(
          "Имя файла не соответствует бэкапу NoVate MCP (novate-backup-YYYYMMDD-HHMMSS.tar.gz[.enc]).",
        ));
      }
      const upload = join(tempDir, name);
      await Bun.write(upload, file);
      const validationError = await validateBackupArchive(upload, name.endsWith(".enc"));
      if (validationError) {
        return redirect("/backups?upload-error=" + encodeURIComponent(validationError));
      }
      const target = resolve(BACKUP_DIR, name);
      if (!target.startsWith(BACKUP_DIR + "/")) {
        return redirect("/backups?upload-error=" + encodeURIComponent("Недопустимое имя файла."));
      }
      try {
        if (statSync(target).isFile()) {
          return redirect("/backups?upload-error=" + encodeURIComponent("Бэкап с таким именем уже существует."));
        }
      } catch { /* имя свободно */ }
      copyFileSync(upload, target);
      appendAudit(session.name, "backup.upload", name);
      tgNotify(`📥 <b>Бэкап загружен</b>

`
        + `<b>Файл:</b> <code>${tgEsc(name)}</code>
`
        + `<b>Проверка:</b> пройдена успешно
`
        + `<b>Пользователь:</b> ${tgEsc(session.name)}`);
      return redirect("/backups?uploaded=1");
    } catch (err) {
      console.error("Не удалось загрузить бэкап:", err);
      return redirect("/backups?upload-error=" + encodeURIComponent("Не удалось загрузить или проверить файл."));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  if (method === "POST" && path === "/backup-verify") {
    const form = await req.formData();
    const file = String(form.get("file") || "");
    if (!BACKUP_NAME_RE.test(file)) return redirect("/backups?verify-error=invalid");
    const target = resolve(BACKUP_DIR, file);
    try {
      if (!target.startsWith(BACKUP_DIR + "/") || !statSync(target).isFile()) throw new Error("Архив не найден");
      const error = await validateBackupArchive(target, file.endsWith(".enc"));
      const registry = readJson(`${CONFIG_DIR}/backup-verifications.json`);
      registry[file] = { state: error ? "error" : "ok", checkedAt: new Date().toISOString(), error: error || "" };
      writeFileSync(`${CONFIG_DIR}/backup-verifications.json`, JSON.stringify(registry, null, 2), { encoding: "utf8", mode: 0o600 });
      appendAudit(session.name, "backup.verify", file, error ? "error" : "ok", error || "");
      return redirect(`/backups?${error ? "verify-error=" + encodeURIComponent(error) : "verified=1"}`);
    } catch (error) {
      appendAudit(session.name, "backup.verify", file, "error", String(error));
      return redirect("/backups?verify-error=failed");
    }
  }

  if (method === "POST" && path === "/restore") {
    // Запрос на восстановление: файл-триггер с ИМЕНЕМ архива для сервиса backup
    const form = await req.formData();
    const file = String(form.get("file") || "");
    const project = String(form.get("project") || "").trim();
    if (!/^[\w.-]+\.tar\.gz(\.enc)?$/.test(file)) return redirect("/backups");
    if (project && (!/^[A-Za-z0-9_.-]{1,120}$/.test(project) || project === "." || project === "..")) return redirect("/backups");
    try {
      if (!statSync(resolve(BACKUP_DIR, file)).isFile()) return redirect("/backups");
      writeFileSync(`${CONFIG_DIR}/restore-now`, JSON.stringify({ file, project, requested_at: new Date().toISOString(), requested_by: session.uid }), "utf8");
      appendAudit(session.name, "backup.restore", project ? `${file}/${project}` : file);
      tgNotify(`♻️ <b>Запущено восстановление</b>

`
        + `<b>Архив:</b> <code>${tgEsc(file)}</code>
`
        + `<b>Пользователь:</b> ${tgEsc(session.name)}
`
        + `<i>Перед восстановлением будет создана страховочная копия.</i>`);
    } catch (err) {
      console.error("Не удалось создать триггер восстановления:", err);
    }
    return redirect("/backups?restore=1");
  }

  if (method === "GET" && path.startsWith("/backup-file/")) {
    let name = "";
    try { name = decodeURIComponent(path.slice("/backup-file/".length)); } catch { return redirect("/backups"); }
    // Только плоское имя архива — никаких путей
    if (!/^[\w.-]+\.tar\.gz(\.enc)?$/.test(name)) return redirect("/backups");
    const target = resolve(BACKUP_DIR, name);
    if (!target.startsWith(BACKUP_DIR + "/")) return redirect("/backups");
    try {
      if (!statSync(target).isFile()) return redirect("/backups");
    } catch {
      return redirect("/backups");
    }
    return new Response(Bun.file(target), {
      headers: {
        "Content-Type": name.endsWith(".enc") ? "application/octet-stream" : "application/gzip",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  }

  if (method === "POST" && path === "/s3-action") {
    const form = await req.formData();
    const action = String(form.get("action") || "");
    if (!["check", "sync", "recover"].includes(action)) {
      return redirect("/settings?tab=storage");
    }
    writeFileSync(`${CONFIG_DIR}/s3-action.json`, JSON.stringify({
      action, requested_at: new Date().toISOString(), requested_by: session.uid,
    }), { encoding: "utf8", mode: 0o600 });
    appendAudit(session.name, `s3.${action}`, "storage");
    return redirect("/settings?tab=storage&s3-action=1");
  }

  if (method === "POST" && path === "/token-create") {
    const form = await req.formData();
    const name = String(form.get("name") || "").trim();
    const role = String(form.get("role") || "reader");
    if (!name || !["reader", "editor", "operator"].includes(role)) return redirect("/settings?tab=access");
    const token = createManagedToken(name, role as "reader" | "editor" | "operator", session.name);
    return html(settingsPage(new URL("/settings?tab=access", url), session.name, { key: `MCP_TOKEN_${role}`, value: token.token }));
  }

  if (method === "POST" && path === "/token-revoke") {
    const form = await req.formData();
    revokeManagedToken(String(form.get("id") || ""), session.name);
    return redirect("/settings?tab=access");
  }

  if (method === "POST" && path === "/version-preflight") {
    const form = await req.formData();
    const version = String(form.get("version") || "").trim();
    if (!await versionCanBeDeployed(version)) return redirect("/settings?tab=versions&version-error=version");
    writeFileSync(`${CONFIG_DIR}/preflight-request.json`, JSON.stringify({ version, requested_at: new Date().toISOString(), requested_by: session.uid }), { encoding: "utf8", mode: 0o600 });
    appendAudit(session.name, "deploy.preflight", version);
    return redirect("/settings?tab=versions&preflight-requested=1");
  }

  if (method === "GET" && path.startsWith("/deploy-log/")) {
    const name = basename(decodeURIComponent(path.slice("/deploy-log/".length)));
    if (!/^panel-deploy-[0-9a-z-]+\\.log$/.test(name)) return new Response("Not found", { status: 404 });
    const target = `${CONFIG_DIR}/deploy-logs/${name}`;
    try { if (!statSync(target).isFile()) throw new Error("missing"); } catch { return new Response("Not found", { status: 404 }); }
    return new Response(readFileSync(target, "utf8"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if (method === "POST" && path === "/version-update") {
    if (!isSameOriginPost(req)) return redirect("/settings?tab=versions&version-error=origin");
    const form = await req.formData();
    const version = String(form.get("version") || "").trim();
    try {
      if (!await versionCanBeDeployed(version)) return redirect("/settings?tab=versions&version-error=version");
      const host = hostStatus();
      const runner = host.runner && typeof host.runner === "object" ? host.runner as Record<string, unknown> : {};
      if (runner.active !== "active" || runner.enabled !== "enabled") return redirect("/settings?tab=versions&version-error=runner");
      const preflight = preflightStatus();
      if (preflight.version !== version || preflight.state !== "ok") return redirect("/settings?tab=versions&version-error=preflight");
      writeFileSync(`${CONFIG_DIR}/deploy-request.json`, JSON.stringify({
        version, requested_at: new Date().toISOString(), requested_by: session.uid,
      }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      appendAudit(session.name, "deploy.request", version);
      tgNotify(`🚀 <b>Запрошено обновление NoVate MCP</b>

`
        + `<b>Версия:</b> <code>${tgEsc(version)}</code>
`
        + `<b>Пользователь:</b> ${tgEsc(session.name)}`);
      return redirect("/settings?tab=versions&version-requested=1");
    } catch (err) {
      console.error("Не удалось создать deploy-запрос:", err);
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code || "") : "";
      appendAudit(session.name, "deploy.request", version, "error", code || String(err));
      return redirect(`/settings?tab=versions&version-error=${code === "EEXIST" ? "busy" : code === "EACCES" ? "permission" : "request"}`);
    }
  }

  if (method === "GET" && path === "/monitoring") return html(monitoringPage(session.name));
  if (method === "GET" && path === "/settings") return html(settingsPage(url, session.name));

  if (method === "POST" && path === "/settings") {
    const form = await req.formData();
    const key = String(form.get("key") || "");
    const action = String(form.get("action") || "");
    const item = EDITABLE.find((entry) => entry.key === key);
    if (!item) return redirect("/settings");
    if (action === "reset") {
      settings.clearOverride(key);
      appendAudit(session.name, "settings.reset", key);
      tgNotify(`⚙️ <b>Настройка сброшена</b>

`
        + `<b>Параметр:</b> <code>${tgEsc(key)}</code>
`
        + `<b>Источник:</b> .env
`
        + `<b>Пользователь:</b> ${tgEsc(session.name)}`);
      return redirect(`/settings?tab=${item.section}&reset=1`);
    }
    if (action === "generate" && item.mode === "generated-secret") {
      const value = randomBytes(32).toString("hex");
      settings.setOverride(key, value);
      appendAudit(session.name, "settings.generate", key);
      tgNotify(`🔑 <b>Создан новый секрет</b>

`
        + `<b>Параметр:</b> <code>${tgEsc(key)}</code>
`
        + `<b>Пользователь:</b> ${tgEsc(session.name)}
`
        + `<i>Значение секрета в Telegram не отправляется.</i>`);
      const settingsUrl = new URL(url);
      settingsUrl.searchParams.set("tab", item.section);
      return html(settingsPage(settingsUrl, session.name, { key, value }));
    }
    if (action === "save" && item.mode !== "generated-secret") {
      const value = String(form.get("value") || "").trim();
      if (item.mode === "text" || value) {
        settings.setOverride(key, value);
        appendAudit(session.name, "settings.update", key);
        tgNotify(`⚙️ <b>Настройка изменена</b>

`
          + `<b>Параметр:</b> <code>${tgEsc(key)}</code>
`
          + `<b>Пользователь:</b> ${tgEsc(session.name)}`);
      }
      return redirect(`/settings?tab=${item.section}&saved=1`);
    }
    return redirect("/settings");
  }

  return redirect("/");
}

// ---------- запуск ----------

for (const key of ["TG_CLIENT_ID", "TG_CLIENT_SECRET", "SESSION_SECRET"]) {
  if (!settings.get(key)) {
    throw new Error(`${key} is not set! Проверь файл .env`);
  }
}
if (!allowedUsers().size) {
  console.warn("ВНИМАНИЕ: ALLOWED_TG_USERS пуст — войти в панель никто не сможет.");
}
if (!settings.get("DOMAIN")) {
  console.warn("ВНИМАНИЕ: DOMAIN пуст — вход через Telegram работать не будет (callback).");
}

startMonitoring(tgNotify);

Bun.serve({
  port: Number(process.env.DASHBOARD_PORT || "8001"),
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
