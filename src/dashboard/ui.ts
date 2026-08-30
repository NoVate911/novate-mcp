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
@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Manrope:wght@400;500;600;700;800&display=swap");

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
button, input, select, textarea { font: inherit; }
code, pre, .generated-secret {
  font-family: "JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  font-variant-ligatures: none;
}
html { color-scheme: dark; }
body {
  font-family: "Manrope", "Segoe UI Variable Text", "Segoe UI", sans-serif;
  font-size: 14px; font-weight: 500; line-height: 1.5;
  font-optical-sizing: auto; text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
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
h1 { font-size: 20px; font-weight: 800; letter-spacing: -.35px; }
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
.project-delete-form { display: inline-flex; margin: 0; }
.project-delete-button {
  width: 36px; height: 36px; display: inline-grid; place-items: center; flex: 0 0 auto;
  padding: 0; border: 1px solid rgba(255, 90, 110, .32); border-radius: 10px;
  color: #ff7285; background: rgba(255, 90, 110, .08); cursor: pointer;
  transition: color .2s ease, background .2s ease, border-color .2s ease, transform .2s ease;
}
.project-delete-button svg { fill: currentColor; }
.project-delete-button:hover { color: #fff; background: #e7475e; border-color: #e7475e; transform: translateY(-1px); }
.project-delete-button:focus-visible { outline: 2px solid #ff7285; outline-offset: 2px; }
.project-delete-button:disabled { opacity: .55; cursor: wait; transform: none; }
.tag {
  display: inline-block; background: var(--surface-2); border: 1px solid var(--border);
  color: var(--muted); border-radius: 9px; padding: 5px 12px; font-size: 13px;
  white-space: nowrap; margin-left: 8px; text-decoration: none;
  transition: color .2s ease, border-color .2s ease;
}
a.tag:hover { color: var(--accent); border-color: var(--accent); }

/* ---- таблицы ---- */
/* ---- вкладки настроек ---- */
.settings-tabs {
  display: flex; gap: 8px; align-items: center; overflow-x: auto;
  padding: 6px; margin-bottom: 22px; background: var(--surface);
  border: 1px solid var(--border); border-radius: 14px;
  scrollbar-width: thin;
}
.settings-tabs button {
  appearance: none; border: 0; background: transparent; color: var(--muted);
  border-radius: 9px; padding: 10px 15px; font: inherit; font-size: 13px;
  font-weight: 650; white-space: nowrap; cursor: pointer;
  transition: color .2s ease, background .2s ease, transform .2s ease;
}
.settings-tabs button:hover { color: var(--text); background: rgba(139, 148, 160, .09); }
.settings-tabs button[aria-selected=true] { color: var(--accent); background: var(--accent-soft); }
.settings-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.settings-section-head { margin: 0 4px 14px; }
.settings-section-head h2 { margin: 0 0 5px; font-size: 20px; }
.settings-section-head p { margin: 0; color: var(--muted); font-size: 13px; }
.settings-panel { animation: rise .25s ease both; }

/* ---- поиск и фильтры ---- */
.filters {
  display: grid; grid-template-columns: minmax(220px, 1.5fr) repeat(4, minmax(130px, auto));
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
.setting-name { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.setting-name .badge { flex: 0 0 auto; }
.hint { color: var(--muted); opacity: .8; font-size: 12px; margin-top: 7px; line-height: 1.55; }
form.inline { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.settings-guide {
  position: relative; display: flex; gap: 18px; align-items: flex-start;
  overflow: hidden; margin-bottom: 24px; padding: 24px;
  background: linear-gradient(135deg, rgba(30, 216, 149, .11), rgba(30, 216, 149, .025) 58%, transparent);
  border: 1px solid rgba(30, 216, 149, .24); border-radius: 16px;
}
.settings-guide::after {
  content: ""; position: absolute; width: 180px; height: 180px; right: -85px; top: -100px;
  border-radius: 50%; background: var(--accent); opacity: .07; pointer-events: none;
}
.settings-guide-icon {
  position: relative; z-index: 1; display: grid; place-items: center; flex: 0 0 46px;
  width: 46px; height: 46px; border-radius: 13px; color: var(--accent);
  background: var(--accent-soft); border: 1px solid rgba(30, 216, 149, .25);
  font-size: 22px; font-weight: 800;
}
.settings-guide-copy { position: relative; z-index: 1; min-width: 0; }
.settings-guide-kicker, .settings-group-kicker {
  display: block; margin-bottom: 5px; color: var(--accent); font-size: 10px;
  font-weight: 800; letter-spacing: .13em; text-transform: uppercase;
}
.settings-guide h1 { margin: 0 0 8px; font-size: clamp(20px, 3vw, 25px); letter-spacing: -.02em; }
.settings-guide p { max-width: 780px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
.settings-guide-points { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }
.settings-guide-points span {
  display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px;
  color: var(--text); background: rgba(12, 17, 23, .48); border: 1px solid var(--border);
  border-radius: 8px; font-size: 11px;
}
.settings-guide-points span::before { content: "✓"; color: var(--accent); font-weight: 900; }
.backup-guide-error {
  background: linear-gradient(135deg, rgba(255, 90, 110, .11), rgba(255, 90, 110, .025) 58%, transparent);
  border-color: rgba(255, 90, 110, .24);
}
.backup-guide-error::after { background: #ff5a6e; }
.backup-guide-error .settings-guide-icon {
  color: #ff7b8c; background: rgba(255, 90, 110, .09); border-color: rgba(255, 90, 110, .24);
}
.backup-guide-error .settings-guide-kicker { color: #ff7b8c; }
.settings-group + .settings-group { margin-top: 30px; }
.monitoring-operations, .token-access-group { margin-top: 30px; }
#settings-versions .settings-group + .settings-group { margin-top: 20px; }
.settings-group-head { display: flex; justify-content: space-between; gap: 16px; margin: 0 4px 12px; }
.settings-group-head h3 { margin: 0 0 5px; font-size: 17px; letter-spacing: -.01em; }
.settings-group-head p { max-width: 760px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.storage-state {
  display: inline-flex; align-items: center; gap: 8px; padding: 5px 9px;
  border: 1px solid var(--border); border-radius: 999px; font-size: 12px; font-weight: 700;
}
.storage-state i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
.storage-state.ok { color: var(--accent); background: var(--accent-soft); border-color: rgba(30, 216, 149, .25); }
.storage-state.error { color: #ff7b8c; background: rgba(255, 90, 110, .09); border-color: rgba(255, 90, 110, .24); }
.storage-state.wait { color: #f4bf64; background: rgba(244, 191, 100, .09); border-color: rgba(244, 191, 100, .24); }
.storage-state.off { color: var(--muted); }


.monitor-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:20px 0; }
.monitor-card { padding:16px; border:1px solid var(--border); border-radius:14px; background:var(--surface); display:flex; flex-direction:column; gap:7px; }
.monitor-card span { color:var(--muted); font-size:12px; }
.monitor-card b { font-size:17px; }
.monitor-card.error { border-color:rgba(255,90,110,.45); }
.monitor-problems { display:grid; gap:10px; margin-bottom:20px; }
.monitor-problem { display:flex; justify-content:space-between; gap:18px; padding:13px 15px; border:1px solid rgba(255,90,110,.4); border-radius:12px; background:rgba(255,90,110,.06); }
.monitor-problem span,.muted { color:var(--muted); }
@media (max-width:800px){.monitor-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.monitor-problem{flex-direction:column}}

.storage-progress { margin: 0 0 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.storage-progress-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 9px; color: var(--muted); font-size: 12px; }
.storage-progress-head b { color: var(--text); font-family: var(--mono); }
.storage-progress-track { height: 7px; overflow: hidden; border-radius: 99px; background: rgba(139,148,160,.14); }
.storage-progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width .35s ease; }
.storage-progress[data-state="error"] .storage-progress-track i { background: #ff5a6e; }
.s3-actions-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.s3-action-card {
  display: flex; flex-direction: column; min-height: 210px; padding: 18px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  transition: transform .2s ease, border-color .2s ease, background .2s ease;
}
.s3-action-card:hover { transform: translateY(-2px); border-color: rgba(139, 148, 160, .36); }
.s3-action-card.featured { border-color: rgba(30, 216, 149, .26); background: linear-gradient(145deg, var(--surface), rgba(30, 216, 149, .055)); }
.s3-action-icon {
  display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 16px;
  color: var(--accent); background: var(--accent-soft); border-radius: 9px; font-size: 17px; font-weight: 800;
}
.s3-action-card h4 { margin: 0 0 7px; font-size: 14px; }
.s3-action-card p { flex: 1; margin: 0 0 18px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.s3-action-card form { margin: 0; }
.s3-action-card .btn { width: 100%; text-align: center; }
.s3-disabled {
  padding: 18px 20px; background: var(--surface); border: 1px dashed var(--border);
  border-radius: 14px; color: var(--muted);
}
.s3-disabled b { display: block; margin-bottom: 5px; color: var(--text); }
.s3-disabled p { margin: 0; font-size: 12px; line-height: 1.6; }

.note {
  background: var(--surface); border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 12px; padding: 13px 17px; font-size: 13px;
  color: var(--muted); margin-bottom: 24px; line-height: 1.65;
}
.note.ok { color: var(--accent); border-left-color: var(--accent); }
.backup-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.upload-form { display: flex; align-items: center; }
.upload-button { position: relative; overflow: hidden; cursor: pointer; }
.upload-form input[type=file] {
  position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}

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
  color: var(--accent); transform-origin: left; animation: toast-progress var(--toast-duration, 5s) linear forwards; opacity: .75;
}
.toast-error .toast-progress { color: #ff5a6e; }
.toast-info .toast-progress { color: #58a6ff; }
.generated-secret {
  display: block; margin: 10px 0; padding: 9px 11px; border-radius: 8px;
  background: var(--bg); color: var(--accent); overflow-wrap: anywhere;
  font-family: "JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace;
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

/* ---- версии и обновления ---- */
.version-shell { display: flex; flex-direction: column; gap: 30px; }
.version-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.version-card { min-height: 126px; padding: 20px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
.version-card span { display: block; margin-bottom: 12px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .7px; }
.version-card b { display: block; font-size: clamp(20px, 4vw, 28px); letter-spacing: -.03em; }
.version-card p { margin: 9px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.version-form { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 10px; align-items: end; padding: 18px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
.version-form label { grid-column: 1 / -1; color: var(--muted); font-size: 12px; font-weight: 700; }
.version-form input, .version-form select { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--text); background: var(--bg); font: inherit; transition: border-color .2s ease, box-shadow .2s ease, background .2s ease; }
.version-form input::placeholder { color: var(--muted); opacity: .75; }
.version-form input:hover, .version-form select:hover { border-color: rgba(139, 148, 160, .5); }
.version-form input:focus, .version-form select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: var(--surface-2); }
.version-form .btn { min-height: 44px; }
.version-form .btn:disabled { opacity: .55; cursor: wait; transform: none; }
.release-notes { min-height: 120px; max-height: 360px; overflow: auto; padding: 18px; white-space: pre-wrap; user-select: text; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); color: var(--text); font-size: 13px; line-height: 1.65; }
.release-link { display: inline-block; margin-top: 12px; font-size: 13px; }
.version-deploy-status { display: flex; gap: 12px; align-items: flex-start; padding: 16px 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.version-deploy-status > i { width: 10px; height: 10px; margin-top: 5px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); }
.version-deploy-status.running > i { background: #f0b35a; }
.version-deploy-status.success > i { background: var(--accent); }
.version-deploy-status.error > i { background: #ff5a6e; }
.version-deploy-status p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }

@media (max-width: 860px) {
  .s3-actions-grid, .version-grid { grid-template-columns: 1fr; }
  .s3-action-card { min-height: 0; }
  .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filters input[type=search] { grid-column: 1 / -1; }
  .panel { overflow-x: auto; }
  table { min-width: 720px; }
}
@media (max-width: 560px) {
  .settings-guide { padding: 18px; }
  .settings-guide-icon { display: none; }
  .settings-guide-points { flex-direction: column; align-items: stretch; }
  .filters, .version-form { grid-template-columns: 1fr; }
  .version-form .btn { width: 100%; }
  .filters input[type=search] { grid-column: auto; }
  .card { align-items: flex-start; flex-direction: column; }
  .card-actions { justify-content: flex-start; }
}

.inline-form { display: inline-flex; align-items: center; gap: 6px; margin: 4px; }
.inline-form select { max-width: 170px; }
.settings-group + .settings-group { margin-top: 24px; }

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
    + `<script src="/static/client.js?v=7" defer></script></body></html>`;
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
    + `<a${cls("monitoring")} href="/monitoring">Мониторинг</a>`
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
