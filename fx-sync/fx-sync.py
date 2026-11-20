#!/usr/bin/env python3
"""fx-sync: просмотренное из Lampa — в плейлисты Filmix.

Когда в Lampa фильм или сериал отмечен как «Просмотрено», плагин fx-sync.js присылает сюда его
названия и год. Сервис находит тайтл на Filmix и делает то же, что кнопки сайта:
  * фильм  -> плейлист «Просмотрено», сериал -> плейлист «Просмотрено. Сериалы»;
  * убирает тайтл из «Закладок» Filmix.
Официального API у Filmix нет, используются запросы сайта (DLE):
  GET  /api/v2/suggestions?search_word=…        поиск
  POST /api/playlist/get_list   movie_id          плейлисты пользователя и есть ли в них тайтл
  POST /api/playlist/add_item   id, item_id       добавить в плейлист
  GET  /engine/ajax/favorites.php?fav_id=…&action=minus   убрать из закладок
Оба действия идемпотентны: в плейлист добавляем, только если тайтла там ещё нет; action=minus
только убирает (в отличие от кнопки на сайте, которая переключает).

Cookie Filmix хранится в $STATE_DIRECTORY/cookie (0600), наружу не отдаётся и в лог не пишется.
Запросы принимаются только из локальной сети.

  GET  /              страница настройки: адрес сайта, cookie, последние действия
  GET  /fx-sync.js    плагин Lampa
  GET  /status        {"configured","loggedIn","host","playlists"}
  POST /watched       {"kind":"movie|tv","title","original_title","year","tmdb", "filmix_id"?}
                      -> {"status":"done",…} | {"status":"choose","candidates":[…]} | {"status":"not_found"}
  POST /cookie        {"cookie":"…"}  сохраняет, только если с ней виден вход
  POST /cookie/delete
  POST /host          {"host":"filmix.top"}  сайт переехал на новое зеркало
"""
import html
import ipaddress
import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = os.environ.get("LISTEN", "0.0.0.0")
PORT = int(os.environ.get("PORT", "9122"))
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("STATE_DIRECTORY", HERE)
COOKIE_FILE = os.path.join(STATE, "cookie")
HOST_FILE = os.path.join(STATE, "host")
MAP_FILE = os.path.join(STATE, "map.json")      # "movie:603" -> {"id":…, "title":…, "year":…, "link":…}
LOG_FILE = os.path.join(STATE, "log.json")      # последние действия для страницы настройки
DEFAULT_HOST = os.environ.get("FILMIX_HOST", "filmix.top")
PLAYLIST_MOVIES = os.environ.get("PLAYLIST_MOVIES", "Просмотрено")
PLAYLIST_SERIES = os.environ.get("PLAYLIST_SERIES", "Просмотрено. Сериалы")
PROBE_ID = 126903  # любой существующий тайтл: get_list отвечает JSON только вошедшему пользователю
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")

_lock = threading.Lock()


class FxError(Exception):
    def __init__(self, message, code=502):
        super().__init__(message)
        self.code = code


# ---------- состояние ----------

def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def write_private(path, text):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def host():
    return read_text(HOST_FILE) or DEFAULT_HOST


def clean_cookie(raw):
    raw = (raw or "").strip()
    if raw.lower().startswith("cookie:"):
        raw = raw[7:].strip()
    return " ".join(raw.split())


def clean_host(raw):
    raw = (raw or "").strip().lower()
    raw = re.sub(r"^https?://", "", raw).split("/")[0]
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", raw):
        raise FxError("адрес сайта вида filmix.top", 400)
    return raw


def log_action(entry):
    with _lock:
        log = read_json(LOG_FILE, [])
        entry["at"] = time.strftime("%Y-%m-%d %H:%M")
        log.insert(0, entry)
        write_private(LOG_FILE, json.dumps(log[:30], ensure_ascii=False))


# ---------- HTTP к Filmix ----------

_last = [0.0]
_net = threading.Lock()


def request(method, path, params=None, cookie=None, base=None):
    """Запрос к сайту. Filmix отвечает 503 на частые запросы, поэтому не чаще раза в 1.5 с и один повтор."""
    for attempt in (1, 2):
        with _net:
            wait = _last[0] + 1.5 - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                return _request(method, path, params, cookie, base)
            except FxError as e:
                if attempt == 2 or "HTTP 503" not in str(e):
                    raise
                time.sleep(4)
            finally:
                _last[0] = time.time()


def _request(method, path, params=None, cookie=None, base=None):
    cookie = read_cookie() if cookie is None else cookie
    base = base or host()
    url = f"https://{base}{path}"
    data = None
    if params and method == "GET":
        url += "?" + urllib.parse.urlencode(params)
    elif params:
        data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": f"https://{base}",
        "Referer": f"https://{base}/",
        **({"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"} if data else {}),
        **({"Cookie": cookie} if cookie else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read()
            charset = res.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as e:
        raise FxError(f"Filmix ответил HTTP {e.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise FxError(f"Filmix ({base}) недоступен: {getattr(e, 'reason', e)}", 504)
    return raw.decode(charset, "replace")


def read_cookie():
    return read_text(COOKIE_FILE)


def as_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return None


def playlists(movie_id, cookie=None):
    """Плейлисты пользователя: [{"id","name","has"}]. None — вход не виден."""
    data = as_json(request("POST", "/api/playlist/get_list", {"movie_id": movie_id}, cookie))
    if not isinstance(data, dict) or data.get("type") != "success" or not isinstance(data.get("message"), list):
        return None
    return [{"id": str(p.get("id")), "name": html.unescape(str(p.get("name") or "")).strip(),
             "has": p.get("highlited") not in (None, "", 0, "0")} for p in data["message"]]


def logged_in(cookie=None):
    try:
        return playlists(PROBE_ID, cookie) is not None
    except FxError:
        return None


def need_login(movie_id):
    if not read_cookie():
        raise FxError("cookie Filmix не задана: откройте страницу настройки fx-sync", 409)
    lists = playlists(movie_id)
    if lists is None:
        raise FxError("cookie Filmix устарела: войдите на сайт заново и обновите её", 401)
    return lists


# ---------- поиск тайтла ----------

def norm(s):
    s = unicodedata.normalize("NFKC", html.unescape(str(s or ""))).lower().replace("ё", "е")
    return re.sub(r"[^0-9a-zа-я]+", "", s)


def is_series(post):
    return bool(post.get("last_serie")) or "/seria/" in (post.get("link") or "")


def suggest(word):
    data = as_json(request("GET", "/api/v2/suggestions", {"search_word": word}, cookie=""))
    return (data or {}).get("posts") or []


def short(post):
    link = re.sub(r"^https?://[^/]+", "", post.get("link") or "")
    return {"id": int(post["id"]), "title": html.unescape(post.get("title") or ""),
            "original": html.unescape(post.get("original_name") or ""),
            "year": int(post.get("year") or 0), "series": is_series(post), "link": link}


def find(kind, title, original, year):
    """-> (лучший кандидат | None, список кандидатов для выбора)."""
    want_series = kind == "tv"
    names = {n for n in (norm(title), norm(original)) if n}
    seen, posts = set(), []
    for word in [original, title]:
        if not word or word in seen:
            continue
        seen.add(word)
        for p in suggest(word):
            if p.get("id") and int(p["id"]) not in {x["id"] for x in posts}:
                posts.append(short(p))
        best, _ = pick(posts, kind, title, original, year, names)
        if best:
            return best, []
    if not posts:
        return None, []
    return pick(posts, kind, title, original, year, names)


def pick(posts, kind, title, original, year, names):
    want_series = kind == "tv"

    def score(p):
        name_ok = norm(p["title"]) in names or norm(p["original"]) in names
        kind_ok = p["series"] == want_series
        dy = abs(p["year"] - year) if year and p["year"] else 9
        return name_ok, kind_ok, dy

    def both(p):  # совпали и русское, и оригинальное название
        return int(norm(p["title"]) == norm(title)) + int(bool(original) and norm(p["original"]) == norm(original))

    good = []
    for p in posts:
        name_ok, kind_ok, dy = score(p)
        if name_ok and kind_ok and dy <= 1:
            good.append(((dy, -both(p)), p))
    good.sort(key=lambda x: x[0])
    if len(good) == 1 or (len(good) > 1 and good[0][0] < good[1][0]):
        return good[0][1], []
    # неоднозначно или ничего не подошло — даём выбрать: сначала тот же тип, потом по году
    posts.sort(key=lambda p: (not score(p)[1], not score(p)[0], score(p)[2]))
    return None, posts[:8]


# ---------- действия ----------

def in_favorites(post):
    """True/False по кнопке на странице тайтла, None — не удалось понять."""
    if not post.get("link"):
        return None
    try:
        page = request("GET", post["link"])
    except FxError:
        return None
    m = re.search(r'<[^>]+id="fav-id-%d"[^>]*>' % post["id"], page)
    if not m:
        return None
    return bool(re.search(r'class="[^"]*\bactive\b', m.group(0)))


def apply(kind, post):
    lists = need_login(post["id"])
    name = PLAYLIST_SERIES if kind == "tv" else PLAYLIST_MOVIES
    target = next((p for p in lists if p["name"].lower() == name.lower()), None)
    if not target:
        raise FxError(f"на Filmix нет плейлиста «{name}»", 404)

    result = {"playlist": target["name"]}
    if target["has"]:
        result["playlistAction"] = "already"
    else:
        data = as_json(request("POST", "/api/playlist/add_item", {"id": target["id"], "item_id": post["id"]}))
        if not isinstance(data, dict) or data.get("type") != "success":
            msg = (data or {}).get("message") if isinstance(data, dict) else None
            raise FxError(f"Filmix не добавил в плейлист: {msg or 'неожиданный ответ'}")
        result["playlistAction"] = "added"

    was = in_favorites(post)
    if was is False:
        result["favorites"] = "absent"
    else:
        request("GET", "/engine/ajax/favorites.php",
                {"fav_id": post["id"], "action": "minus", "skin": "Filmix", "alert": 0})
        result["favorites"] = "removed" if was else "removed?"
    return result


def watched(data):
    kind = "tv" if data.get("kind") == "tv" else "movie"
    title = str(data.get("title") or "").strip()
    original = str(data.get("original_title") or "").strip()
    year = int(data.get("year") or 0)
    key = f"{kind}:{data.get('tmdb')}" if data.get("tmdb") else None
    mapping = read_json(MAP_FILE, {})

    post = None
    if data.get("filmix_id"):                       # пользователь выбрал вручную
        fid = int(data["filmix_id"])
        cands = data.get("candidate") or {}
        post = {"id": fid, "title": cands.get("title") or title, "original": cands.get("original") or original,
                "year": int(cands.get("year") or year), "link": cands.get("link") or ""}
    elif key and key in mapping:
        post = mapping[key]
    else:
        if not title and not original:
            raise FxError("нет названия", 400)
        post, candidates = find(kind, title, original, year)
        if not post:
            if candidates:
                return {"status": "choose", "candidates": candidates}
            log_action({"title": title or original, "year": year, "status": "not_found"})
            return {"status": "not_found"}

    if not post.get("link"):
        for p in suggest(post.get("original") or post.get("title") or title):
            if int(p.get("id") or 0) == post["id"]:
                post["link"] = short(p)["link"]
                break

    result = apply(kind, post)
    if key:
        with _lock:
            mapping = read_json(MAP_FILE, {})
            mapping[key] = {k: post.get(k) for k in ("id", "title", "original", "year", "link")}
            write_private(MAP_FILE, json.dumps(mapping, ensure_ascii=False))
    filmix = {"id": post["id"], "title": post.get("title"), "year": post.get("year"),
              "url": f"https://{host()}{post.get('link') or ''}"}
    log_action({"title": post.get("title") or title, "year": post.get("year"), "status": "done",
                "filmix": post["id"], **result})
    return {"status": "done", "filmix": filmix, **result}


# ---------- HTTP-сервер ----------

def is_local(addr):
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_loopback


SETUP_PAGE = """<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Filmix для Lampa</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#222}
textarea{width:100%;height:140px;font:13px monospace}input{font-size:16px;padding:4px 8px}
button{font-size:16px;padding:6px 16px;margin-right:8px}#st{padding:8px 12px;border-radius:6px;background:#eee}
.ok{background:#e3f5e1!important}.bad{background:#fbe4e4!important}ol li{margin-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:14px}td{border-bottom:1px solid #eee;padding:4px 6px}</style></head><body>
<h2>Просмотренное из Lampa — в Filmix</h2><p id="st">Проверяю…</p>
<h3>Адрес сайта</h3><p>Filmix часто меняет зеркала. Cookie привязана к адресу: после переезда обновите и адрес, и cookie.</p>
<p><input id="h" size="24"> <button onclick="saveHost()">Сохранить адрес</button></p>
<h3>Как взять cookie</h3><ol>
<li>Откройте <a id="site" target="_blank">Filmix</a> в браузере, где вы вошли в аккаунт.</li>
<li>Нажмите F12 → вкладка <b>Network</b> (Сеть), обновите страницу (F5).</li>
<li>Щёлкните первый запрос (сам адрес сайта) → <b>Headers</b> → раздел <b>Request Headers</b>.</li>
<li>Найдите строку <code>cookie:</code>, щёлкните по значению правой кнопкой → <b>Copy value</b>.</li>
<li>Вставьте ниже и нажмите «Сохранить». Cookie хранится только на этом сервере.</li></ol>
<textarea id="c" placeholder="cookie из запроса к Filmix"></textarea><p>
<button onclick="save()">Сохранить</button><button onclick="del()">Удалить cookie</button></p>
<h3>Последние действия</h3><table id="log"></table>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function st(){const s=document.getElementById('st');try{const j=await (await fetch('status')).json();
document.getElementById('h').value=j.host;const a=document.getElementById('site');a.href='https://'+j.host+'/';a.textContent=j.host;
s.className=j.loggedIn?'ok':'bad';s.textContent=!j.configured?'Cookie не задана.':j.loggedIn?'Готово: вход в Filmix виден, плейлисты: '+(j.playlists||[]).join(', '):'Cookie задана, но вход не виден — обновите её.';
document.getElementById('log').innerHTML=(j.log||[]).map(e=>'<tr><td>'+esc(e.at)+'</td><td>'+esc(e.title)+(e.year?' ('+e.year+')':'')+'</td><td>'+
(e.status==='done'?esc((e.playlistAction==='added'?'добавлен в «':'уже был в «')+e.playlist+'»'+(e.favorites==='absent'?'':', убран из закладок')):e.status==='not_found'?'не найден на Filmix':esc(e.status))+'</td></tr>').join('');}
catch(e){s.className='bad';s.textContent='Ошибка: '+e.message;}}
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});return r.json();}
async function save(){const j=await post('cookie',{cookie:document.getElementById('c').value});document.getElementById('c').value='';alert(j.ok?'Сохранено, вход виден.':(j.error||'Не сохранено'));st();}
async function saveHost(){const j=await post('host',{host:document.getElementById('h').value});alert(j.ok?'Адрес сохранён. Если сайт переехал, обновите и cookie.':(j.error||'Не сохранено'));st();}
async function del(){if(!confirm('Удалить cookie?'))return;await post('cookie/delete');st();}
st();</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "fx-sync"
    sys_version = ""

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}",
              flush=True)

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def send(self, code, body, ctype):
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def reply(self, code, obj):
        self.send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def guard(self):
        if is_local(self.client_address[0]):
            return True
        self.reply(403, {"error": "только из локальной сети"})
        return False

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 65536:
            raise FxError("слишком большой запрос", 413)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise FxError("неверный JSON", 400)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.guard():
            return
        path = urllib.parse.urlparse(self.path).path.rstrip("/") or "/"
        try:
            if path == "/":
                return self.send(200, SETUP_PAGE.encode(), "text/html; charset=utf-8")
            if path == "/fx-sync.js":
                with open(os.path.join(HERE, "fx-sync.js"), "rb") as f:
                    return self.send(200, f.read(), "application/javascript; charset=utf-8")
            if path == "/health":
                return self.reply(200, {"ok": True})
            if path == "/status":
                out = {"configured": bool(read_cookie()), "loggedIn": False, "host": host(),
                       "log": read_json(LOG_FILE, [])[:15]}
                if out["configured"]:
                    try:
                        lists = playlists(PROBE_ID)
                        out["loggedIn"] = lists is not None
                        out["playlists"] = [p["name"] for p in lists or []
                                            if p["name"].lower() in (PLAYLIST_MOVIES.lower(), PLAYLIST_SERIES.lower())]
                    except FxError as e:
                        out["loggedIn"] = None
                        out["error"] = str(e)
                return self.reply(200, out)
            self.reply(404, {"error": "not found"})
        except FxError as e:
            self.reply(e.code, {"error": str(e)})

    def do_POST(self):
        if not self.guard():
            return
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        try:
            if path == "/watched":
                return self.reply(200, watched(self.body()))
            if path == "/cookie":
                cookie = clean_cookie(self.body().get("cookie"))
                names = [p.split("=", 1)[0].strip() for p in cookie.split(";") if "=" in p]
                if not names:
                    raise FxError("это не похоже на cookie: нужна строка вида имя=значение; имя=значение", 400)
                if not logged_in(cookie):
                    shown = ", ".join(names[:20]) + (" …" if len(names) > 20 else "")
                    raise FxError(f"с этой cookie вход в Filmix ({host()}) не виден (в ней {len(names)} полей: {shown})", 400)
                write_private(COOKIE_FILE, cookie)
                return self.reply(200, {"ok": True})
            if path == "/cookie/delete":
                try:
                    os.remove(COOKIE_FILE)
                except FileNotFoundError:
                    pass
                return self.reply(200, {"ok": True})
            if path == "/host":
                write_private(HOST_FILE, clean_host(self.body().get("host")))
                return self.reply(200, {"ok": True})
            self.reply(404, {"error": "not found"})
        except FxError as e:
            self.reply(e.code, {"error": str(e)})
        except (ValueError, TypeError, KeyError):
            self.reply(400, {"error": "неверные данные"})


if __name__ == "__main__":
    print(f"fx-sync on {LISTEN}:{PORT}, state {STATE}", flush=True)
    ThreadingHTTPServer((LISTEN, PORT), Handler).serve_forever()
