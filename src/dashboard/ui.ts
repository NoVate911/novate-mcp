/**
 * UI-слой панели «NoVate MCP»: CSS, каркас страниц, helpers.
 * Стиль: минимализм, тёмная тема, акцент #1ED895.
 * Анимации — только CSS (transform/opacity, дёшево для GPU).
 * Выделение текста запрещено везде, кроме полей ввода.
 */

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function humanSize(n: number): string {
  let size = n;
  for (const unit of ["Б", "КБ", "МБ", "ГБ"]) {
    if (size < 1024) return `${size.toFixed(1)} ${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(1)} ТБ`;
}

export function mask(v: string): string {
  if (!v) return "(не задан)";
  return v.length > 4 ? "••••••" + v.slice(-4) : "••••••";
}

export function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type ToastKind = "success" | "error" | "info";

/** Всплывающее уведомление в правом верхнем углу. */
export function toast(message: string, kind: ToastKind = "info"): string {
  return `<div class="toast-stack"><div class="toast toast-${kind}" data-toast role="status">`
    + `<span>${esc(message)}</span><button class="toast-close" type="button" aria-label="Закрыть">×</button>`
    + `<div class="toast-progress"></div></div></div>`;
}

const CSS = `
:root {
  --bg: #0b0e11;
  --surface: #11151b;
  --surface-2: #151b22;
  --border: #1f2630;
  --text: #e9edf1;
  --muted: #8b94a0;
  --accent: #1ED895;
  --accent-soft: rgba(30, 216, 149, .12);
  --accent-glow: rgba(30, 216, 149, .22);
}
* { margin: 0; padding: 0; box-sizing: border-box;
    -webkit-user-select: none; -moz-user-select: none; user-select: none; }
input, textarea { -webkit-user-select: text; -moz-user-select: text; user-select: text; }
html { color-scheme: dark; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  background: var(--bg); color: var(--text); min-height: 100vh;
}
body::before {
  content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(700px 320px at 75% -10%, var(--accent-soft), transparent 70%);
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #232b36; border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background: #2e3847; }
::-webkit-scrollbar-track { background: transparent; }

.wrap { position: relative; z-index: 1; max-width: 1020px; margin: 0 auto; padding: 28px 20px 64px; }

/* ---- шапка ---- */
.topbar {
  position: sticky; top: 0; z-index: 10;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  background: rgba(11, 14, 17, .72);
  border-bottom: 1px solid var(--border);
}
.topbar-inner { max-width: 1020px; margin: 0 auto; padding: 16px 20px;
  display: flex; justify-content: space-between; align-items: center; }
h1 { font-size: 20px; font-weight: 700; letter-spacing: .3px; }
h1 span { color: var(--accent); }
h1 a { color: inherit; text-decoration: none; }
.nav a {
  margin-left: 24px; font-size: 14px; color: var(--muted); text-decoration: none;
  padding-bottom: 4px; border-bottom: 2px solid transparent;
  transition: color .2s ease, border-color .2s ease;
}
.nav a:hover { color: var(--text); }
.nav a.active { color: var(--accent); border-bottom-color: var(--accent); }
.nav .user { margin-left: 24px; font-size: 14px; color: var(--muted); }

/* ---- анимации появления ---- */
@keyframes rise {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
.rise { animation: rise .55s cubic-bezier(.2, .7, .3, 1) both; }

/* ---- статистика ---- */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px; margin-bottom: 30px; }
.stat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 18px;
  transition: transform .25s cubic-bezier(.2,.7,.3,1), border-color .25s ease;
}
.stat:hover { transform: translateY(-3px); border-color: var(--accent); }
.stat b { display: block; font-size: 24px; margin-top: 6px; color: var(--accent);
  font-variant-numeric: tabular-nums; }
.stat small { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }

/* ---- карточки проектов ---- */
.card {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 18px 20px; margin-bottom: 12px;
  transition: transform .25s cubic-bezier(.2,.7,.3,1), border-color .25s ease, box-shadow .25s ease;
}
.card:hover {
  transform: translateY(-3px); border-color: var(--accent);
  box-shadow: 0 12px 34px -10px var(--accent-glow);
}
.card a.main { color: inherit; text-decoration: none; flex: 1; min-width: 0; }
.card .name { font-size: 16px; font-weight: 600; }
.card .meta { color: var(--muted); font-size: 13px; margin-top: 5px; }
.card-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.card-actions .tag { margin-left: 0; }
.tag {
  display: inline-block; background: var(--surface-2); border: 1px solid var(--border);
  color: var(--muted); border-radius: 9px; padding: 5px 12px; font-size: 13px;
  white-space: nowrap; margin-left: 8px; text-decoration: none;
  transition: color .2s ease, border-color .2s ease;
}
a.tag:hover { color: var(--accent); border-color: var(--accent); }

/* ---- таблицы ---- */
/* ---- поиск и фильтры ---- */
.filters {
  display: grid; grid-template-columns: minmax(220px, 1.5fr) repeat(4, minmax(130px, auto)) auto;
  gap: 10px; align-items: center; margin-bottom: 18px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 12px;
}
.filters input[type=search], .filters select {
  width: 100%; min-width: 0; background: var(--bg); border: 1px solid var(--border);
  color: var(--text); border-radius: 9px; padding: 10px 12px; font-size: 13px;
  transition: border-color .2s ease, box-shadow .2s ease;
}
.filters input[type=search] { -webkit-user-select: text; -moz-user-select: text; user-select: text; }
.filters input[type=search]:focus, .filters select:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
}
.filter-count { color: var(--muted); font-size: 12px; white-space: nowrap; text-align: right; }
.filter-empty { padding: 36px 0; }
[hidden] { display: none !important; }

.panel { background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 6px; overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 13px 15px; border-bottom: 1px solid var(--border);
  vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px;
  text-transform: uppercase; letter-spacing: .6px; }
tr:last-child td { border-bottom: 0; }
tbody tr { transition: background .15s ease; }
tbody tr:hover { background: rgba(30, 216, 149, .045); }

/* ---- элементы ---- */
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.crumb { margin-bottom: 20px; color: var(--muted); font-size: 14px; }
.crumb a { color: var(--muted); }
.crumb a:hover { color: var(--accent); text-decoration: none; }
.btn {
  display: inline-block; background: var(--accent); color: #05231a !important;
  padding: 9px 18px; border-radius: 10px; font-weight: 700; font-size: 14px;
  border: 0; cursor: pointer; text-decoration: none;
  transition: filter .2s ease, transform .2s ease;
}
.btn:hover { filter: brightness(1.12); transform: translateY(-1px); text-decoration: none; }
.btn.gray { background: var(--surface-2); color: var(--text) !important;
  border: 1px solid var(--border); }
.btn.gray:hover { border-color: var(--accent); filter: none; }
.badge { display: inline-block; border-radius: 7px; padding: 3px 10px;
  font-size: 12px; font-weight: 600; }
.badge.env { background: rgba(139, 148, 160, .14); color: var(--muted); }
.badge.panel { background: var(--accent-soft); color: var(--accent); }
.hint { color: var(--muted); opacity: .8; font-size: 12px; margin-top: 7px; line-height: 1.55; }
.val { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 14px; }
form.inline { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.note {
  background: var(--surface); border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 12px; padding: 13px 17px; font-size: 13px;
  color: var(--muted); margin-bottom: 24px; line-height: 1.65;
}
.note.ok { color: var(--accent); border-left-color: var(--accent); }
.backup-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.upload-form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.upload-form input[type=file] {
  max-width: 260px; color: var(--muted); font-size: 13px;
  -webkit-user-select: text; -moz-user-select: text; user-select: text;
}
.upload-form input[type=file]::file-selector-button { display: none; }

/* ---- тост-уведомления ---- */
.toast-stack {
  position: fixed; z-index: 100; top: 82px; right: 20px; width: min(390px, calc(100vw - 40px));
  pointer-events: none;
}
.toast {
  position: relative; overflow: hidden; pointer-events: auto;
  display: flex; align-items: flex-start; gap: 12px;
  background: rgba(17, 21, 27, .97); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 12px; padding: 14px 42px 16px 16px; color: var(--text);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .45); line-height: 1.45; font-size: 14px;
  animation: toast-in .28s cubic-bezier(.2,.7,.3,1) both;
}
.toast-success { border-left-color: var(--accent); }
.toast-error { border-left-color: #ff5a6e; }
.toast-info { border-left-color: #58a6ff; }
.toast-close {
  position: absolute; top: 7px; right: 8px; width: 28px; height: 28px; border: 0;
  background: transparent; color: var(--muted); cursor: pointer; font-size: 20px; line-height: 1;
}
.toast-close:hover { color: var(--text); }
.toast-progress {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: currentColor;
  color: var(--accent); transform-origin: left; animation: toast-progress 4.8s linear forwards; opacity: .75;
}
.toast-error .toast-progress { color: #ff5a6e; }
.toast-info .toast-progress { color: #58a6ff; }
.generated-secret {
  display: block; margin: 10px 0; padding: 9px 11px; border-radius: 8px;
  background: var(--bg); color: var(--accent); overflow-wrap: anywhere;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  -webkit-user-select: text; -moz-user-select: text; user-select: text;
}
.secret-copy { padding: 7px 12px; font-size: 12px; }
.toast.toast-leave { animation: toast-out .22s ease forwards; }
@keyframes toast-in { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: none; } }
@keyframes toast-out { to { opacity: 0; transform: translateX(18px); } }
@keyframes toast-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }

.empty { text-align: center; color: var(--muted); padding: 70px 0; line-height: 1.9; }

/* ---- поля ввода ---- */
input[type=text], input[type=password] {
  background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: 10px; padding: 11px 14px; font-size: 14px;
  transition: border-color .2s ease, box-shadow .2s ease;
}
input:focus { outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft); }
form.inline input { flex: 1; min-width: 180px; }

/* ---- логин ---- */
.login-wrap { min-height: 100vh; display: grid; place-items: center;
  position: relative; z-index: 1; padding: 20px; }
.glow {
  position: absolute; width: 420px; height: 420px; border-radius: 50%;
  background: var(--accent); filter: blur(120px); pointer-events: none;
  animation: pulse 5.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: .10; }
  50%      { transform: scale(1.18); opacity: .18; }
}
.login-card {
  position: relative; width: min(380px, 92vw);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 20px; padding: 38px 34px;
  box-shadow: 0 30px 70px -24px rgba(0, 0, 0, .7);
  animation: rise .6s cubic-bezier(.2, .7, .3, 1) both;
  text-align: center;
}
.login-card h1 { margin-bottom: 8px; }
.login-card p { color: var(--muted); font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
.login-btn {
  display: block; width: 100%; background: var(--accent); color: #05231a;
  border-radius: 10px; padding: 13px; font-size: 15px; font-weight: 700;
  text-decoration: none; transition: filter .2s ease, transform .2s ease;
}
.login-btn:hover { filter: brightness(1.12); transform: translateY(-1px); text-decoration: none; }
.err {
  background: rgba(255, 90, 110, .1); border: 1px solid rgba(255, 90, 110, .35);
  color: #ff9aa8; border-radius: 10px; padding: 11px 15px;
  font-size: 14px; margin-bottom: 16px; text-align: left;
}

@media (max-width: 860px) {
  .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filters input[type=search] { grid-column: 1 / -1; }
  .filter-count { text-align: left; }
  .panel { overflow-x: auto; }
  table { min-width: 720px; }
}
@media (max-width: 560px) {
  .filters { grid-template-columns: 1fr; }
  .filters input[type=search] { grid-column: auto; }
  .card { align-items: flex-start; flex-direction: column; }
  .card-actions { justify-content: flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
`;

/** Каркас HTML-страницы. */
export function shell(title: string, content: string): string {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body>`
    + content
    + `<script src="/static/client.js" defer></script></body></html>`;
}

/** Липкая шапка с навигацией. */
export function header(active: string, user = ""): string {
  const cls = (name: string) => (name === active ? ` class="active"` : "");
  const who = user ? `<span class="user">👤 ${esc(user)}</span>` : "";
  return `<div class="topbar"><div class="topbar-inner">`
    + `<h1><a href="/">NoVate <span>MCP</span></a></h1>`
    + `<nav class="nav">`
    + `<a${cls("projects")} href="/">Проекты</a>`
    + `<a${cls("backups")} href="/backups">Бэкапы</a>`
    + `<a${cls("settings")} href="/settings">Настройки</a>`
    + who
    + `<a href="/logout">Выйти</a>`
    + `</nav></div></div>`;
}

/** Страница входа (только через Telegram OIDC). */
export function loginPage(error: string | null): string {
  const err = error ? toast(error, "error") : "";
  return shell("NoVate MCP — вход", err + `<div class="login-wrap"><div class="glow"></div>`
    + `<div class="login-card">`
    + `<h1>NoVate <span>MCP</span></h1>`
    + `<p>Панель управления проектами.<br>Вход — через Telegram<br>для пользователей из списка разрешённых.</p>`
    + err
    + `<a class="login-btn" href="/auth/telegram">Войти через Telegram</a>`
    + `</div></div>`);
}
