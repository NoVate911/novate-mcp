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

# ============================================================
# Панель управления проектами. Настройки приходят из .env.
# Вход: по токену DASH_TOKEN (подписанная cookie на 7 дней).
# ============================================================

DATA_DIR = Path(os.environ.get("MCP_DATA_DIR", "/data")).resolve()
DASH_TOKEN = os.environ.get("DASH_TOKEN")
if not DASH_TOKEN:
    raise RuntimeError("DASH_TOKEN is not set! Проверь файл .env")

COOKIE_NAME = "dash_auth"
COOKIE_TTL = 7 * 24 * 3600

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def sign(ts):
    return hmac.new(DASH_TOKEN.encode(), ts.encode(), hashlib.sha256).hexdigest()


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


CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e6e9f0; min-height: 100vh; }
.wrap { max-width: 1000px; margin: 0 auto; padding: 32px 20px 60px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
h1 { font-size: 24px; }
h1 span { color: #7c8aff; }
a { color: #7c8aff; text-decoration: none; }
a:hover { text-decoration: underline; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 30px; }
.stat { background: #181b26; border: 1px solid #262b3d; border-radius: 14px; padding: 16px 18px; }
.stat b { display: block; font-size: 22px; margin-top: 4px; color: #9fb0ff; }
.stat small { opacity: .55; }
.card { background: #181b26; border: 1px solid #262b3d; border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
.card:hover { border-color: #7c8aff; }
.card .name { font-size: 17px; font-weight: 600; }
.card .meta { opacity: .55; font-size: 13px; margin-top: 4px; }
.tag { background: #232840; border-radius: 8px; padding: 4px 12px; font-size: 13px; white-space: nowrap; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #262b3d; }
th { opacity: .5; font-weight: 500; font-size: 13px; }
tr:hover td { background: #1c2030; }
.crumb { margin-bottom: 20px; opacity: .9; }
.btn { display: inline-block; background: #7c8aff; color: #0f1117 !important; padding: 8px 18px; border-radius: 9px; font-weight: 600; }
.btn:hover { opacity: .9; text-decoration: none; }
.logout { opacity: .6; font-size: 14px; }
.empty { text-align: center; opacity: .5; padding: 60px 0; }
.panel { background: #181b26; border: 1px solid #262b3d; border-radius: 14px; padding: 8px 6px; }
form.login { max-width: 360px; margin: 12vh auto; background: #181b26; border: 1px solid #262b3d; border-radius: 16px; padding: 34px 30px; }
form.login h1 { margin-bottom: 8px; }
form.login p { opacity: .55; font-size: 14px; margin-bottom: 22px; }
input[type=password], input[type=text] { width: 100%; background: #0f1117; border: 1px solid #333a55; color: #e6e9f0; border-radius: 9px; padding: 12px 14px; font-size: 15px; margin-bottom: 14px; }
input:focus { outline: none; border-color: #7c8aff; }
button { width: 100%; background: #7c8aff; color: #0f1117; border: 0; border-radius: 9px; padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
button:hover { opacity: .9; }
.err { background: #3d1d24; border: 1px solid #7c2d3a; color: #ff9aa8; border-radius: 9px; padding: 10px 14px; font-size: 14px; margin-bottom: 14px; }
"""

PAGE = ("<!DOCTYPE html><html lang=ru><head><meta charset=UTF-8>"
        "<meta name=viewport content='width=device-width, initial-scale=1'>"
        "<title>@TITLE@</title><style>" + CSS + "</style></head><body>"
        "@CONTENT@</body></html>")


def page(title, content):
    return HTMLResponse(PAGE.replace("@TITLE@", esc(title)).replace("@CONTENT@", content))


LOGIN_FORM = ("<form class=login method=post action=/login>"
              "<h1>NoVate <span>Panel</span></h1>"
              "<p>Панель управления проектами. Введите токен доступа (DASH_TOKEN).</p>"
              "@ERR@"
              "<input type=password name=token placeholder='Токен доступа' autofocus required>"
              "<button type=submit>Войти</button></form>")

ERR_HTML = "<div class=err>Неверный токен. Попробуйте ещё раз.</div>"


@app.get("/login", response_class=HTMLResponse)
def login_form():
    return page("Вход", LOGIN_FORM.replace("@ERR@", ""))


@app.post("/login")
async def login(request: Request):
    form = await request.form()
    token = str(form.get("token", ""))
    if not hmac.compare_digest(token, DASH_TOKEN):
        return page("Вход", LOGIN_FORM.replace("@ERR@", ERR_HTML))
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
                size += p.stat().st_size
                latest = max(latest, p.stat().st_mtime)
            except OSError:
                pass
    return files, size, latest


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    red = guard(request)
    if red:
        return red
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
            cards.append(
                "<a class=card href='/browse/" + urllib.parse.quote(p.name) + "'>"
                "<div><div class=name>📁 " + esc(p.name) + "</div>"
                "<div class=meta>" + str(files) + " файлов · " + human_size(size)
                + " · изменён " + when + "</div></div>"
                "<div class=tag>" + human_size(size) + "</div></a>")
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
    body = ("<div class=wrap><header><h1>NoVate <span>Panel</span></h1>"
            "<a class=logout href=/logout>Выйти</a></header>" + stats)
    if cards:
        body += "".join(cards)
    else:
        body += "<div class=empty>Проектов пока нет.<br>Попроси Notion AI что-нибудь создать!</div>"
    body += "</div>"
    return page("Панель управления", body)


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
    listing = ("<div class=crumb>" + " / ".join(crumbs) + "</div>"
               "<div class=panel><table><tr><th>Имя</th><th>Размер</th><th></th></tr>"
               + ("".join(rows) if rows else "<tr><td colspan=3 style='text-align:center;opacity:.5'>пусто</td></tr>")
               + "</table></div>")
    return page("Файлы", "<div class=wrap>" + listing + "</div>")


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
