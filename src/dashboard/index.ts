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
import {
  copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, statfsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as settings from "./settings.ts";
import { esc, fmtTime, header, humanSize, loginPage, mask, shell, toast } from "./ui.ts";

const DATA_DIR = resolve(process.env.MCP_DATA_DIR || "/data");
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
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
type EditableSetting = {
  key: string; label: string; hint: string; mode: SettingMode;
};

const EDITABLE: EditableSetting[] = [
  { key: "ALLOWED_TG_USERS", label: "Telegram ID с доступом в панель",
    hint: "Редактируйте весь список через запятую: можно дописывать новые ID и удалять старые. Применяется сразу.",
    mode: "text" },
  { key: "TG_CLIENT_ID", label: "Telegram OIDC Client ID",
    hint: "ID OIDC-приложения из @BotFather. Применяется сразу.", mode: "text" },
  { key: "TG_CLIENT_SECRET", label: "Telegram OIDC Client Secret",
    hint: "Выдаётся @BotFather, поэтому локально не генерируется. Поле пустое, пока секрет не заменяется.",
    mode: "external-secret" },
  { key: "SESSION_SECRET", label: "Секрет сессий панели",
    hint: "Генерируется панелью. После замены все текущие сессии завершаются.",
    mode: "generated-secret" },
  { key: "MCP_TOKEN", label: "Токен MCP-доступа (Bearer)",
    hint: "Генерируется панелью. MCP-сервис автоматически перечитает токен и перезапустит свой процесс.",
    mode: "generated-secret" },
  { key: "DOMAIN", label: "Домен сервера",
    hint: "Ссылки в панели и callback Telegram — сразу. HTTPS-домен Caddy меняется через .env + install.sh.",
    mode: "text" },
  { key: "TG_BOT_TOKEN", label: "Токен Telegram-бота",
    hint: "Выдаётся @BotFather, поэтому локально не генерируется. Применяется в течение минуты.",
    mode: "external-secret" },
  { key: "TG_CHAT_ID", label: "ID чата для бэкапов",
    hint: "Можно отредактировать текущее значение или очистить поле. Применяется в течение минуты.",
    mode: "text" },
  { key: "BACKUP_INTERVAL_HOURS", label: "Интервал бэкапов, часов",
    hint: "Как часто делать бэкап. Применяется в течение минуты.", mode: "text" },
  { key: "BACKUP_KEEP", label: "Локальных копий бэкапов",
    hint: "Столько последних архивов хранится на сервере.", mode: "text" },
  { key: "BACKUP_PASSWORD", label: "Пароль шифрования бэкапов (AES-256)",
    hint: "Генерируется панелью и применяется в течение минуты. Сохраните копию: без неё .enc не расшифровать.",
    mode: "generated-secret" },
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
  // base64url собираем вручную из base64 — не зависим от поддержки кодировки в рантайме
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

// ---------- уведомления в Telegram ----------

/** Неблокирующее уведомление в Telegram (бот для бэкапов). Ошибки — только в лог. */
function tgNotify(text: string): void {
  const token = settings.get("TG_BOT_TOKEN");
  const chatId = settings.get("TG_CHAT_ID");
  if (!token || !chatId) return;
  fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
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
  const notification = url.searchParams.get("error") === "project-archive"
    ? toast("Не удалось начать скачивание проекта.", "error")
    : "";
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
    cards.push(
      `<div class="card rise" data-filter-item data-name="${esc(name.toLocaleLowerCase("ru"))}" `
      + `data-modified="${st.latest}" data-size="${st.size}" data-files="${st.files}" `
      + `data-kind="${hasIndex ? "site" : "project"}" style="animation-delay:${120 + i * 70}ms">`
      + `<a class="main" href="/browse/${encodeURIComponent(name)}">`
      + `<div class="name">📁 ${esc(name)}</div>`
      + `<div class="meta">${humanSize(st.size)} · изменён ${fmtTime(st.latest)}</div>`
      + `</a><div class="card-actions">${openSite}${download}</div></div>`,
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

function streamDirectoryArchive(directory: string, downloadName: string): Response {
  const packed = Bun.spawn([
    "tar", "-czf", "-", "-C", dirname(directory), "--", basename(directory),
  ], { stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(packed.stderr).text();
  void Promise.all([packed.exited, stderr]).then(([code, message]) => {
    if (code !== 0) console.error("Потоковая архивация папки завершилась с ошибкой:", message);
  });
  return new Response(packed.stdout, {
    headers: {
      "Content-Type": "application/gzip",
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
  if (url.searchParams.has("started")) {
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
    const enc = st.encrypted ? " · 🔐 зашифрован" : "";
    const rst = st.restore ? `<div class="hint">Восстановление: ${esc(st.restore)}</div>` : "";
    statusHtml = `<div class="note rise">Последний бэкап: <b>${esc(st.file || "—")}</b>`
      + ` · ${humanSize(st.size || 0)} · ${esc(fmtTime(Date.parse(st.time)))}${enc}${tg}${nextStr}${rst}</div>`;
  } else {
    statusHtml = `<div class="note rise">Бэкапов ещё не было. Первый создаётся автоматически `
      + `после запуска сервиса, дальше — по расписанию (BACKUP_INTERVAL_HOURS) или кнопкой ниже.</div>`;
  }

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
        `<tr><td>🗄 ${esc(f.name)}</td><td>${humanSize(f.size)}</td><td>${esc(fmtTime(f.mtime))}</td>`
        + `<td><a class="btn" href="/backup-file/${encodeURIComponent(f.name)}">Скачать</a> `
        + `<a class="btn gray" href="/backups?confirm=${encodeURIComponent(f.name)}">Восстановить</a></td></tr>`,
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
    + `<tbody>${rows}</tbody></table></div>`
    + `<div class="hint" style="margin-top:16px">В архив входят проекты и настройки панели. `
    + `Локально хранятся последние BACKUP_KEEP копий (папка backups на сервере), `
    + `каждый архив отправляется в Telegram (TG_BOT_TOKEN → TG_CHAT_ID). `
    + `Если задан BACKUP_PASSWORD — архивы шифруются (AES-256, файлы .enc). `
    + `Загружаемые архивы проверяются по имени, формату, структуре и безопасности содержимого. `
    + `«Восстановить» перезаписывает проекты из выбранного архива.</div></div>`);
}

type GeneratedSecret = { key: string; value: string };

function generatedSecretToast(secret: GeneratedSecret): string {
  const suffix = secret.key === "MCP_TOKEN"
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

function settingsPage(url: URL, user: string, generated?: GeneratedSecret): string {
  let flash = generated ? generatedSecretToast(generated) : "";
  if (!generated && url.searchParams.has("saved")) {
    flash = toast("Настройка сохранена.", "success");
  } else if (!generated && url.searchParams.has("reset")) {
    flash = toast("Переопределение сброшено — снова действует значение из .env.", "success");
  }

  const rows: string[] = [];
  for (const item of EDITABLE) {
    const effective = settings.get(item.key);
    const src = settings.source(item.key);
    const secret = item.mode !== "text";
    const shown = secret ? mask(effective) : esc(effective || "(не задан)");
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

    rows.push(
      `<tr><td style="width:210px"><b>${esc(item.key)}</b>`
      + `<div class="hint">${esc(item.label)}</div></td>`
      + `<td><span class="val">${shown}</span> ${badge}${editor}`
      + `<form id="reset-${esc(item.key)}" method="post" action="/settings">`
      + `<input type="hidden" name="key" value="${esc(item.key)}">`
      + `<input type="hidden" name="action" value="reset"></form>`
      + `<div class="hint">${esc(item.hint)}</div></td></tr>`,
    );
  }

  const noteBlock =
    `<div class="note rise">Обычные значения показаны прямо в полях: их можно дополнять, редактировать и очищать. `
    + `Локальные секреты создаются кнопкой «Сгенерировать новый» и показываются один раз для копирования. `
    + `TG_CLIENT_SECRET и TG_BOT_TOKEN выдаёт Telegram — их можно только заменить вручную. `
    + `Кнопка «По умолчанию» удаляет переопределение и возвращает значение из .env.</div>`;

  return shell("NoVate MCP — настройки",
    header("settings", user) + flash + `<div class="wrap">${noteBlock}`
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
        packSigned({ state, verifier, ts: Math.floor(Date.now() / 1000) }), STATE_TTL),
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
      tgNotify("⛔ Отклонена попытка входа в панель NoVate MCP: Telegram ID " + sub);
      return redirect("/login?err=denied", { "Set-Cookie": clearState });
    }
    const name = typeof claims.name === "string" && claims.name
      ? claims.name
      : typeof claims.preferred_username === "string" && claims.preferred_username
        ? "@" + claims.preferred_username
        : `ID ${sub}`;
    const session = packSigned({ uid: sub, name, ts: Math.floor(Date.now() / 1000) });
    tgNotify("🔑 Вход в панель NoVate MCP: " + name + " (ID " + sub + ")");
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

  if (method === "GET" && path === "/") return html(indexPage(url, session.name));

  if (method === "GET" && path.startsWith("/browse/")) {
    let rel = "";
    try { rel = decodeURIComponent(path.slice("/browse/".length)); } catch { return redirect("/"); }
    return browsePage(rel, session.name);
  }

  if (method === "GET" && path.startsWith("/download-project/")) {
    let name = "";
    try { name = decodeURIComponent(path.slice("/download-project/".length)); } catch { return redirect("/"); }
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return redirect("/");
    const target = safePath(name);
    if (!target) return redirect("/");
    try {
      if (!statSync(target).isDirectory()) return redirect("/");
      return streamDirectoryArchive(target, name + ".tar.gz");
    } catch (err) {
      console.error("Не удалось начать потоковую архивацию проекта:", err);
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
      return streamDirectoryArchive(target, basename(target) + ".tar.gz");
    } catch (err) {
      console.error("Не удалось начать потоковую архивацию папки:", err);
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
      tgNotify("🗄 Загружен и проверен бэкап " + name + " (пользователь " + session.name + ")");
      return redirect("/backups?uploaded=1");
    } catch (err) {
      console.error("Не удалось загрузить бэкап:", err);
      return redirect("/backups?upload-error=" + encodeURIComponent("Не удалось загрузить или проверить файл."));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  if (method === "POST" && path === "/restore") {
    // Запрос на восстановление: файл-триггер с ИМЕНЕМ архива для сервиса backup
    const form = await req.formData();
    const file = String(form.get("file") || "");
    if (!/^[\w.-]+\.tar\.gz(\.enc)?$/.test(file)) return redirect("/backups");
    try {
      if (!statSync(resolve(BACKUP_DIR, file)).isFile()) return redirect("/backups");
      writeFileSync(`${CONFIG_DIR}/restore-now`, file, "utf8");
      tgNotify("♻️ Запрошено восстановление проектов из архива " + file
        + " (пользователь " + session.name + ")");
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

  if (method === "GET" && path === "/settings") return html(settingsPage(url, session.name));

  if (method === "POST" && path === "/settings") {
    const form = await req.formData();
    const key = String(form.get("key") || "");
    const action = String(form.get("action") || "");
    const item = EDITABLE.find((entry) => entry.key === key);
    if (!item) return redirect("/settings");
    if (action === "reset") {
      settings.clearOverride(key);
      tgNotify("⚙️ Настройка " + key + " сброшена к .env (пользователь " + session.name + ")");
      return redirect("/settings?reset=1");
    }
    if (action === "generate" && item.mode === "generated-secret") {
      const value = randomBytes(32).toString("hex");
      settings.setOverride(key, value);
      tgNotify("⚙️ Сгенерировано новое значение " + key + " (пользователь " + session.name + ")");
      return html(settingsPage(url, session.name, { key, value }));
    }
    if (action === "save" && item.mode !== "generated-secret") {
      const value = String(form.get("value") || "").trim();
      if (item.mode === "text" || value) {
        settings.setOverride(key, value);
        tgNotify("⚙️ Настройка " + key + " изменена из панели (пользователь " + session.name + ")");
      }
      return redirect("/settings?saved=1");
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
