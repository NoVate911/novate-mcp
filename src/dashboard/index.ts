/**
 * NoVate MCP — панель управления проектами.
 * TypeScript + Bun: лёгкий HTTP-сервер без фреймворков.
 *
 * Маршруты:
 *   GET  /                  — список проектов + статистика (нужен вход)
 *   GET  /browse/<путь>     — просмотр папки (нужен вход)
 *   GET  /download/<путь>   — скачивание файла (нужен вход)
 *   GET  /backups           — бэкапы: статус, архивы, запуск вручную (нужен вход)
 *   POST /backup-now        — запустить бэкап вне расписания (нужен вход)
 *   GET  /backup-file/<имя> — скачивание архива бэкапа (нужен вход)
 *   GET  /settings          — настройки (нужен вход)
 *   POST /settings          — сохранить/сбросить переопределение (нужен вход)
 *   GET  /login             — страница входа (кнопка «Войти через Telegram»)
 *   GET  /auth/telegram     — старт входа: редирект на Telegram OIDC
 *   GET  /auth/callback     — callback Telegram OIDC (code -> id_token -> сессия)
 *   GET  /logout
 *   GET  /static/client.js  — клиентский JS (собирается bun build при сборке образа)
 */

import {
  createHash, createHmac, createPublicKey, randomBytes,
  timingSafeEqual, verify as cryptoVerify,
} from "node:crypto";
import { readdirSync, readFileSync, statSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, resolve } from "node:path";
import * as settings from "./settings.ts";
import { esc, fmtTime, header, humanSize, loginPage, mask, shell } from "./ui.ts";

const DATA_DIR = resolve(process.env.MCP_DATA_DIR || "/data");
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || "/backups");
const COOKIE_NAME = "dash_auth";
const COOKIE_TTL = 7 * 24 * 3600;
const STATE_COOKIE = "oauth_state";
const STATE_TTL = 600;

// Telegram OpenID Connect (https://core.telegram.org/widgets/login)
const TG_AUTH_URL = "https://oauth.telegram.org/auth";
const TG_TOKEN_URL = "https://oauth.telegram.org/token";
const TG_JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";
const TG_ISSUER = "https://oauth.telegram.org";

// Редактируемые в панели настройки
const EDITABLE = [
  { key: "ALLOWED_TG_USERS", label: "Telegram ID с доступом в панель",
    hint: "Через запятую. Применяется сразу — убранный из списка теряет доступ мгновенно. "
      + "ID отклонённых попыток входа видны в логах: docker compose logs dashboard",
    secret: false },
  { key: "TG_CLIENT_ID", label: "Telegram OIDC Client ID",
    hint: "ID OIDC-приложения из @BotFather. Применяется сразу.", secret: false },
  { key: "TG_CLIENT_SECRET", label: "Telegram OIDC Client Secret",
    hint: "Секрет OIDC-приложения из @BotFather. Применяется сразу.", secret: true },
  { key: "SESSION_SECRET", label: "Секрет сессий панели",
    hint: "Применяется сразу. Все текущие сессии разлогинятся.", secret: true },
  { key: "MCP_TOKEN", label: "Токен MCP-доступа (Bearer)",
    hint: "Нужен перезапуск: docker compose restart mcp. Затем обнови токен в своём MCP-клиенте.",
    secret: true },
  { key: "DOMAIN", label: "Домен сервера",
    hint: "Ссылки в панели и callback Telegram — сразу. HTTPS-домен Caddy меняется через .env + install.sh.",
    secret: false },
  { key: "TG_BOT_TOKEN", label: "Токен бота для бэкапов",
    hint: "Бот присылает архивы в чат TG_CHAT_ID. Применяется в течение минуты.",
    secret: true },
  { key: "TG_CHAT_ID", label: "ID чата для бэкапов",
    hint: "Личный ID — бэкапы придут в личку (бота нужно один раз запустить кнопкой Start). "
      + "Применяется в течение минуты.",
    secret: false },
  { key: "BACKUP_INTERVAL_HOURS", label: "Интервал бэкапов, часов",
    hint: "Как часто делать бэкап. Применяется в течение минуты.", secret: false },
  { key: "BACKUP_KEEP", label: "Локальных копий бэкапов",
    hint: "Столько последних архивов хранится в папке backups на сервере, старые удаляются.",
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

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Сравнение через sha256 + timingSafeEqual — длина строк не утекает. */
function eqStr(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Подписанное HMAC значение cookie: base64url(payload).hex-подпись. */
function packSigned(payload: Record<string, unknown>): string {
  const p = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${p}.${hmac(settings.get("SESSION_SECRET"), p)}`;
}

/** Проверка подписи и срока жизни подписанного значения cookie. */
function unpackSigned(cookie: string, ttl: number): Record<string, unknown> | null {
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const p = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!p || !sig || !eqStr(sig, hmac(settings.get("SESSION_SECRET"), p))) return null;
  try {
    const data = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof data.ts !== "number") return null;
    const age = Math.floor(Date.now() / 1000) - data.ts;
    if (age < 0 || age > ttl) return null;
    return data;
  } catch {
    return null;
  }
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
    if (parts.length !== 3) return null;
    const head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
      alg?: string; kid?: string;
    };
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const keys = await jwks();
    const jwk = keys.find((k) => k.kid === head.kid);
    if (!jwk) return null;
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
      return null;
    }
    if (!ok) return null;
    if (payload.iss !== TG_ISSUER) return null;
    const cid = settings.get("TG_CLIENT_ID");
    const aud = payload.aud;
    if (aud !== cid && !(Array.isArray(aud) && aud.includes(cid))) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
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
        Authorization: "Basic " + Buffer.from(`${cid}:${secret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: cid,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      console.error(`Telegram token endpoint: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("Telegram token exchange failed:", err);
    return null;
  }
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

function indexPage(user: string): string {
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
    header("projects", user) + `<div class="wrap">${stats}${body}</div>`);
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
    header("", user) + `<div class="wrap rise">`
    + `<div class="crumb">${crumbs.join(" / ")}</div>`
    + `<div class="panel"><table><thead><tr><th>Имя</th><th>Размер</th><th></th></tr></thead>`
    + `<tbody>${table}</tbody></table></div></div>`));
}

// ---------- бэкапы ----------

type BackupStatus = {
  time?: string; file?: string; size?: number; files?: number;
  telegram?: string; reason?: string; error?: string;
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
  if (url.searchParams.has("started")) {
    flash = `<div class="note ok rise">Бэкап запущен — архив появится в списке и прилетит в Telegram в течение минуты.</div>`;
  }

  const st = backupStatus();
  let statusHtml: string;
  if (st?.error) {
    statusHtml = `<div class="note rise" style="border-left-color:#ff5a6e">`
      + `Последний бэкап завершился ошибкой: ${esc(st.error)}`
      + `${st.time ? ` (${esc(fmtTime(Date.parse(st.time)))})` : ""}</div>`;
  } else if (st?.time) {
    const tg = st.telegram === "ok"
      ? " · отправлен в Telegram ✅"
      : st.telegram === "skipped"
        ? " · Telegram не настроен (заполни TG_BOT_TOKEN и TG_CHAT_ID)"
        : st.telegram && st.telegram.startsWith("error")
          ? ` · ошибка отправки в Telegram: ${esc(st.telegram.slice(7).trim())}`
          : "";
    const intervalH = Number(settings.get("BACKUP_INTERVAL_HOURS")) || 24;
    const next = Date.parse(st.time) + intervalH * 3600_000;
    const nextStr = Number.isFinite(next)
      ? `<div class="hint">Следующий по расписанию: ${esc(fmtTime(next))} · интервал ${esc(String(intervalH))} ч</div>`
      : "";
    statusHtml = `<div class="note rise">Последний бэкап: <b>${esc(st.file || "—")}</b>`
      + ` · ${humanSize(st.size || 0)} · ${esc(fmtTime(Date.parse(st.time)))}${tg}${nextStr}</div>`;
  } else {
    statusHtml = `<div class="note rise">Бэкапов ещё не было. Первый создаётся автоматически `
      + `после запуска сервиса, дальше — по расписанию (BACKUP_INTERVAL_HOURS) или кнопкой ниже.</div>`;
  }

  let rows = "";
  try {
    rows = readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".tar.gz"))
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
        `<tr><td>🗄 ${esc(f.name)}</td><td>${humanSize(f.size)}</td><td>${esc(fmtTime(f.mtime))}</td>`
        + `<td><a class="btn" href="/backup-file/${encodeURIComponent(f.name)}">Скачать</a></td></tr>`,
      )
      .join("");
    if (!rows) rows = `<tr><td colspan="4" style="text-align:center;color:var(--muted)">архивов пока нет</td></tr>`;
  } catch {
    rows = `<tr><td colspan="4" style="text-align:center;color:var(--muted)">папка бэкапов недоступна</td></tr>`;
  }

  return shell("NoVate MCP — бэкапы",
    header("backups", user) + `<div class="wrap">${flash}${statusHtml}`
    + `<form method="post" action="/backup-now" class="rise">`
    + `<button class="btn" type="submit">Сделать бэкап сейчас</button></form>`
    + `<div class="panel rise" style="margin-top:24px"><table>`
    + `<thead><tr><th>Архив</th><th>Размер</th><th>Дата</th><th></th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`
    + `<div class="hint" style="margin-top:16px">В архив входят проекты и настройки панели. `
    + `Локально хранятся последние BACKUP_KEEP копий (папка backups на сервере), `
    + `каждый архив отправляется в Telegram (TG_BOT_TOKEN → TG_CHAT_ID).</div></div>`);
}

function settingsPage(url: URL, user: string): string {
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
    + `Изменение MCP_TOKEN вступает в силу после <span class="val">docker compose restart mcp</span>. `
    + `Настройки Telegram и бэкапов применяются в течение минуты, без перезапуска.</div>`;

  return shell("NoVate MCP — настройки",
    header("settings", user) + `<div class="wrap">${flash}${noteBlock}`
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

  // ---- Вход через Telegram OIDC ----
  if (method === "GET" && path === "/login") {
    const err = url.searchParams.get("err");
    const msg =
      err === "denied"
        ? "Этот Telegram-аккаунт не в списке разрешённых (ALLOWED_TG_USERS)."
        : err === "state"
          ? "Сессия входа устарела. Попробуйте ещё раз."
          : err === "token"
            ? "Telegram не подтвердил вход. Попробуйте ещё раз."
            : null;
    return html(loginPage(msg), err ? 403 : 200);
  }

  if (method === "GET" && path === "/auth/telegram") {
    const state = randomBytes(16).toString("hex");
    const verifier = b64url(randomBytes(32));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
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
        packSigned({ state, verifier, ts: Math.floor(Date.now() / 1000) }), STATE_TTL),
    });
  }

  if (method === "GET" && path === "/auth/callback") {
    const clearState = cookieStr(STATE_COOKIE, "", 0);
    const saved = unpackSigned(cookieOf(req, STATE_COOKIE), STATE_TTL);
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    if (!saved || saved.state !== state || !code) {
      return redirect("/login?err=state", { "Set-Cookie": clearState });
    }
    const tokens = await exchangeCode(code, String(saved.verifier));
    const claims = tokens && typeof tokens.id_token === "string"
      ? await verifyIdToken(tokens.id_token)
      : null;
    if (!claims || typeof claims.sub !== "string") {
      return redirect("/login?err=token", { "Set-Cookie": clearState });
    }
    if (!allowedUsers().has(claims.sub)) {
      console.log(`Отказано во входе: Telegram ID ${claims.sub} не в ALLOWED_TG_USERS`);
      return redirect("/login?err=denied", { "Set-Cookie": clearState });
    }
    const name = typeof claims.name === "string" && claims.name
      ? claims.name
      : typeof claims.preferred_username === "string" && claims.preferred_username
        ? "@" + claims.preferred_username
        : `ID ${claims.sub}`;
    const session = packSigned({ uid: claims.sub, name, ts: Math.floor(Date.now() / 1000) });
    return redirectCookies("/", [
      clearState,
      cookieStr(COOKIE_NAME, session, COOKIE_TTL),
    ]);
  }

  if (path === "/logout") {
    return redirect("/login", { "Set-Cookie": cookieStr(COOKIE_NAME, "", 0) });
  }

  // Дальше — только после входа
  const session = sessionOf(req);
  if (!session) return redirect("/login");

  if (method === "GET" && path === "/") return html(indexPage(session.name));

  if (method === "GET" && path.startsWith("/browse/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/browse/".length)); } catch { return redirect("/"); }
    return browsePage(rel, session.name);
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
    } catch (err) {
      console.error("Не удалось создать триггер бэкапа:", err);
    }
    return redirect("/backups?started=1");
  }

  if (method === "GET" && path.startsWith("/backup-file/")) {
    let name = "";
    try { name = decodeURIComponent(path.slice("/backup-file/".length)); } catch { return redirect("/backups"); }
    // Только плоское имя архива — никаких путей
    if (!/^[\w.-]+\.tar\.gz$/.test(name)) return redirect("/backups");
    const target = resolve(BACKUP_DIR, name);
    if (!target.startsWith(BACKUP_DIR + "/")) return redirect("/backups");
    try {
      if (!statSync(target).isFile()) return redirect("/backups");
    } catch {
      return redirect("/backups");
    }
    return new Response(Bun.file(target), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  }

  if (method === "GET" && path === "/settings") return html(settingsPage(url, session.name));

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
