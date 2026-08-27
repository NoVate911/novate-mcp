import hashlib
import hmac
import html
import os
import shutil
import time
import urllib.parse
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

import settings

# ============================================================
# NoVate MCP — панель управления проектами.
# Вход по DASH_TOKEN (cookie на 7 дней). Настройки: .env — дефолт,
# переопределения в панели имеют приоритет (overrides.json).
# ============================================================

DATA_DIR = Path(os.environ.get("MCP_DATA_DIR", "/data")).resolve()

COOKIE_NAME = "dash_auth"
COOKIE_TTL = 7 * 24 * 3600

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# Редактируемые в панели настройки: (ключ, подпись, подсказка, секрет?)
EDITABLE = [
    ("DASH_TOKEN", "Токен входа в панель",
     "Применяется сразу. Старые входы разлогинятся.", True),
    ("MCP_TOKEN", "Токен подключения Notion (Bearer)",
     "Нужен перезапуск: docker compose restart mcp. Затем обнови токен в подключении Notion.", True),
    ("DOMAIN", "Домен сервера",
     "Ссылки в панели — сразу. Сам HTTPS-домен и Caddy меняются только через .env + install.sh.", False),
]

# Только для просмотра (нельзя переопределить из панели)
INFO_ONLY = [
    ("PROJECTS_DIR", "Папка проектов",
     "Меняется только в .env на сервере, затем bash install.sh."),
]


def current_token():
    return settings.get("DASH_TOKEN")


def sign(ts):
    return hmac.new(current_token().encode(), ts.encode(), hashlib.sha256).hexdigest()


def authed(request):
    cookie = request.cookies.get(COOKIE_NAME, "")
    if "." not in cookie:
        return False
    ts, sig = cookie.rsplit(".", 1)
    try:
        age = time.time() - float(ts)
    except ValueError:
        return False
    if age < 0 or age > COOKIE_TTL:
        return False
    return hmac.compare_digest(sig, sign(ts))


def guard(request):
    if not authed(request):
        return RedirectResponse("/login")
    return None


def safe_path(rel):
    target = (DATA_DIR / rel.lstrip("/")).resolve()
    if target != DATA_DIR and DATA_DIR not in target.parents:
        return None
    return target


def human_size(n):
    size = float(n)
    for unit in ["Б", "КБ", "МБ", "ГБ"]:
        if size < 1024:
            return "%.1f %s" % (size, unit)
        size /= 1024
    return "%.1f ТБ" % size


def esc(s):
    return html.escape(str(s), quote=True)


def mask(v):
    if not v:
        return "(не задан)"
    return "••••••" + v[-4:] if len(v) > 4 else "••••••"


CSS = """
* { margin: 0; padding: 0; box-sizing: border-box;
    -webkit-user-select: none; -moz-user-select: none; user-select: none; }
input, textarea { -webkit-user-select: text; -moz-user-select: text; user-select: text; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e6e9f0; min-height: 100vh; }
.wrap { max-width: 1000px; margin: 0 auto; padding: 32px 20px 60px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
h1 { font-size: 24px; }
h1 span { color: #7c8aff; }
a { color: #7c8aff; text-decoration: none; }
a:hover { text-decoration: underline; }
.nav a { margin-left: 22px; font-size: 14px; opacity: .75; }
.nav a:hover { opacity: 1; text-decoration: none; }
.nav a.active { opacity: 1; border-bottom: 2px solid #7c8aff; padding-bottom: 3px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 30px; }
.stat { background: #181b26; border: 1px solid #262b3d; border-radius: 14px; padding: 16px 18px; }
.stat b { display: block; font-size: 22px; margin-top: 4px; color: #9fb0ff; }
.stat small { opacity: .55; }
.card { background: #181b26; border: 1px solid #262b3d; border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
.card:hover { border-color: #7c8aff; }
.card .name { font-size: 17px; font-weight: 600; }
.card .meta { opacity: .55; font-size: 13px; margin-top: 4px; }
.tag { background: #232840; border-radius: 8px; padding: 4px 12px; font-size: 13px; white-space: nowrap; margin-left: 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #262b3d; vertical-align: top; }
th { opacity: .5; font-weight: 500; font-size: 13px; }
tr:hover td { background: #1c2030; }
.crumb { margin-bottom: 20px; opacity: .9; }
.btn { display: inline-block; background: #7c8aff; color: #0f1117 !important; padding: 8px 18px; border-radius: 9px; font-weight: 600; border: 0; cursor: pointer; font-size: 14px; }
.btn:hover { opacity: .9; text-decoration: none; }
.btn.gray { background: #2a2f45; color: #e6e9f0 !important; }
.badge { display: inline-block; border-radius: 7px; padding: 3px 10px; font-size: 12px; font-weight: 600; }
.badge.env { background: #1d2b1f; color: #8fd49a; }
.badge.panel { background: #2e2416; color: #f0b35c; }
.hint { opacity: .5; font-size: 12px; margin-top: 6px; line-height: 1.5; }
.val { font-family: monospace; font-size: 14px; }
form.inline { display: flex; gap: 8px; margin-top: 10px; }
form.inline input { flex: 1; background: #0f1117; border: 1px solid #333a55; color: #e6e9f0; border-radius: 9px; padding: 9px 12px; font-size: 14px; margin: 0; }
form.inline input:focus { outline: none; border-color: #7c8aff; }
.note { background: #17233d; border: 1px solid #2a3d6b; border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 22px; line-height: 1.6; }
.note.ok { background: #16281c; border-color: #2a5b36; }
.empty { text-align: center; opacity: .5; padding: 60px 0; }
.panel { background: #181b26; border: 1px solid #262b3d; border-radius: 14px; padding: 8px 6px; }
form.login { max-width: 360px; margin: 12vh auto; background: #181b26; border: 1px solid #262b3d; border-radius: 16px; padding: 34px 30px; }
form.login h1 { margin-bottom: 8px; }
form.login p { opacity: .55; font-size: 14px; margin-bottom: 22px; }
input[type=password], input[type=text] { width: 100%; background: #0f1117; border: 1px solid #333a55; color: #e6e9f0; border-radius: 9px; padding: 12px 14px; font-size: 15px; margin-bottom: 14px; }
input:focus { outline: none; border-color: #7c8aff; }
button { background: #7c8aff; color: #0f1117; border: 0; border-radius: 9px; padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
button:hover { opacity: .9; }
form.login button { width: 100%; }
.err { background: #3d1d24; border: 1px solid #7c2d3a; color: #ff9aa8; border-radius: 9px; padding: 10px 14px; font-size: 14px; margin-bottom: 14px; }
"""

PAGE = ("<!DOCTYPE html><html lang=ru><head><meta charset=UTF-8>"
        "<meta name=viewport content='width=device-width, initial-scale=1'>"
        "<title>@TITLE@</title><style>" + CSS + "</style></head><body>"
        "@CONTENT@</body></html>")


def page(title, content):
    return HTMLResponse(PAGE.replace("@TITLE@", esc(title)).replace("@CONTENT@", content))


def header(active):
    def cls(name):
        return " class=active" if name == active else ""
    return ("<header><h1>NoVate <span>MCP</span></h1><div class=nav>"
            "<a" + cls("projects") + " href=/>Проекты</a>"
            "<a" + cls("settings") + " href=/settings>Настройки</a>"
            "<a href=/logout>Выйти</a></div></header>")


LOGIN_FORM = ("<form class=login method=post action=/login>"
              "<h1>NoVate <span>MCP</span></h1>"
              "<p>Панель управления проектами. Введите токен доступа (DASH_TOKEN).</p>"
              "@ERR@"
              "<input type=password name=token placeholder='Токен доступа' autofocus required>"
              "<button type=submit>Войти</button></form>")

ERR_HTML = "<div class=err>Неверный токен. Попробуйте ещё раз.</div>"


@app.get("/login", response_class=HTMLResponse)
def login_form():
    return page("NoVate MCP — вход", LOGIN_FORM.replace("@ERR@", ""))


@app.post("/login")
async def login(request: Request):
    form = await request.form()
    token = str(form.get("token", ""))
    if not hmac.compare_digest(token, current_token()):
        return page("NoVate MCP — вход", LOGIN_FORM.replace("@ERR@", ERR_HTML))
    ts = str(int(time.time()))
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(COOKIE_NAME, ts + "." + sign(ts), max_age=COOKIE_TTL,
                    httponly=True, secure=True, samesite="lax")
    return resp


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login")
    resp.delete_cookie(COOKIE_NAME)
    return resp


def dir_stats(path):
    files = 0
    size = 0
    latest = 0
    for p in path.rglob("*"):
        if p.is_file():
            files += 1
            try:
                st = p.stat()
                size += st.st_size
                latest = max(latest, st.st_mtime)
            except OSError:
                pass
    return files, size, latest


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    red = guard(request)
    if red:
        return red
    domain = settings.get("DOMAIN")
    cards = []
    total_size = 0
    total_files = 0
    if DATA_DIR.is_dir():
        for p in sorted(DATA_DIR.iterdir()):
            if not p.is_dir():
                continue
            files, size, latest = dir_stats(p)
            total_size += size
            total_files += files
            when = time.strftime("%d.%m.%Y %H:%M", time.localtime(latest)) if latest else "—"
            public = ""
            if domain:
                url = "https://" + domain + "/projects/" + urllib.parse.quote(p.name) + "/"
                public = "<a class=tag href='" + url + "' target=_blank>открыть сайт ↗</a>"
            cards.append(
                "<div class=card><a href='/browse/" + urllib.parse.quote(p.name) + "'>"
                "<div class=name>📁 " + esc(p.name) + "</div>"
                "<div class=meta>" + str(files) + " файлов · " + human_size(size)
                + " · изменён " + when + "</div></a>"
                "<div>" + public + "<span class=tag>" + human_size(size) + "</span></div></div>")
    try:
        disk = shutil.disk_usage(DATA_DIR)
        disk_free = human_size(disk.free)
    except OSError:
        disk_free = "—"
    try:
        uptime_sec = float(open("/proc/uptime").read().split()[0])
        uptime = "%d дн %d ч" % (uptime_sec // 86400, (uptime_sec % 86400) // 3600)
    except Exception:
        uptime = "—"
    stats = ("<div class=stats>"
             "<div class=stat><small>Проектов</small><b>" + str(len(cards)) + "</b></div>"
             "<div class=stat><small>Файлов всего</small><b>" + str(total_files) + "</b></div>"
             "<div class=stat><small>Занято проектами</small><b>" + human_size(total_size) + "</b></div>"
             "<div class=stat><small>Свободно на диске</small><b>" + disk_free + "</b></div>"
             "<div class=stat><small>Аптайм сервера</small><b>" + uptime + "</b></div>"
             "</div>")
    body = "<div class=wrap>" + header("projects") + stats
    if cards:
        body += "".join(cards)
    else:
        body += "<div class=empty>Проектов пока нет.<br>Попроси Notion AI что-нибудь создать!</div>"
    body += "</div>"
    return page("NoVate MCP — проекты", body)


@app.get("/browse/{path:path}", response_class=HTMLResponse)
def browse(request: Request, path: str):
    red = guard(request)
    if red:
        return red
    target = safe_path(path)
    if target is None or not target.is_dir():
        return RedirectResponse("/")
    crumbs = ["<a href='/'>Проекты</a>"]
    parts = target.relative_to(DATA_DIR).parts
    acc = ""
    for part in parts:
        acc = acc + "/" + part if acc else part
        crumbs.append("<a href='/browse/" + urllib.parse.quote(acc) + "'>" + esc(part) + "</a>")
    rows = []
    for p in sorted(target.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
        rel = str(p.relative_to(DATA_DIR))
        q = urllib.parse.quote(rel)
        if p.is_dir():
            rows.append("<tr><td>📁 <a href='/browse/" + q + "'>" + esc(p.name)
                        + "</a></td><td>—</td><td>папка</td></tr>")
        else:
            rows.append("<tr><td>📄 " + esc(p.name) + "</td><td>" + human_size(p.stat().st_size)
                        + "</td><td><a class=btn href='/download/" + q + "'>Скачать</a></td></tr>")
    listing = (header("") + "<div class=crumb>" + " / ".join(crumbs) + "</div>"
               "<div class=panel><table><tr><th>Имя</th><th>Размер</th><th></th></tr>"
               + ("".join(rows) if rows else "<tr><td colspan=3 style='text-align:center;opacity:.5'>пусто</td></tr>")
               + "</table></div>")
    return page("NoVate MCP — файлы", "<div class=wrap>" + listing + "</div>")


@app.get("/download/{path:path}")
def download(request: Request, path: str):
    red = guard(request)
    if red:
        return red
    target = safe_path(path)
    if target is None or not target.is_file():
        return RedirectResponse("/")
    return FileResponse(target, filename=target.name,
                        media_type="application/octet-stream")


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    red = guard(request)
    if red:
        return red
    flash = ""
    if "saved" in request.query_params:
        flash = "<div class='note ok'>Сохранено: значение из панели теперь имеет приоритет над .env.</div>"
    elif "reset" in request.query_params:
        flash = "<div class='note ok'>Переопределение сброшено — снова действует значение из .env.</div>"
    rows = []
    for key, label, hint, secret in EDITABLE:
        effective = settings.get(key)
        src = settings.source(key)
        shown = mask(effective) if secret else esc(effective or "(не задан)")
        badge = ("<span class='badge panel'>панель</span>" if src == "panel"
                 else "<span class='badge env'>.env</span>")
        reset_btn = ""
        if src == "panel":
            reset_btn = ("<button class='btn gray' form='reset-" + key + "'>По умолчанию</button>")
        rows.append(
            "<tr><td style='width:200px'><b>" + esc(key) + "</b>"
            "<div class=hint>" + esc(label) + "</div></td>"
            "<td><span class=val>" + shown + "</span> " + badge
            + "<form class=inline method=post action=/settings>"
            + "<input type=hidden name=key value=" + esc(key) + ">"
            + "<input type=text name=value placeholder='Новое значение (пусто — не менять)'>"
            + "<button class=btn type=submit name=action value=save>Сохранить</button>"
            + reset_btn
            + "</form>"
            + "<form id='reset-" + key + "' method=post action=/settings>"
            + "<input type=hidden name=key value=" + esc(key) + ">"
            + "<input type=hidden name=action value=reset></form>"
            + "<div class=hint>" + esc(hint) + "</div></td></tr>")
    for key, label, hint in INFO_ONLY:
        effective = settings.get(key)
        rows.append(
            "<tr><td style='width:200px'><b>" + esc(key) + "</b>"
            "<div class=hint>" + esc(label) + "</div></td>"
            "<td><span class=val>" + esc(effective or "(не задан)") + "</span> "
            "<span class='badge env'>.env</span>"
            "<div class=hint>" + esc(hint) + "</div></td></tr>")
    note = ("<div class=note>Приоритет: <b>переопределение в панели</b> &gt; <b>.env</b> "
            "(значения по умолчанию). Кнопка «По умолчанию» удаляет переопределение. "
            "Изменения MCP_TOKEN и DOMAIN применяются на MCP-сервере после "
            "<span class=val>docker compose restart</span>.</div>")
    body = ("<div class=wrap>" + header("settings") + flash + note
            + "<div class=panel><table>" + "".join(rows) + "</table></div></div>")
    return page("NoVate MCP — настройки", body)


@app.post("/settings")
async def settings_save(request: Request):
    red = guard(request)
    if red:
        return red
    form = await request.form()
    key = str(form.get("key", ""))
    action = str(form.get("action", ""))
    allowed = [k for k, _, _, _ in EDITABLE]
    if key not in allowed:
        return RedirectResponse("/settings", status_code=303)
    if action == "reset":
        settings.clear_override(key)
        return RedirectResponse("/settings?reset=1", status_code=303)
    value = str(form.get("value", "")).strip()
    if value:
        settings.set_override(key, value)
    return RedirectResponse("/settings?saved=1", status_code=303)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
