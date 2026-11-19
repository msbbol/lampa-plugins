#!/usr/bin/env python3
"""kp-vote: ваши оценки Кинопоиска для Lampa.

Официального API Кинопоиска на чтение и запись оценок нет. Сервис отправляет те же GraphQL-запросы,
что и сайт kinopoisk.ru (MoviePreviewCard, MovieSetVote, MovieRemoveVote), с cookie вашей сессии Яндекса.
Тексты запросов должны совпадать с сайтовыми побайтно: сервер Кинопоиска принимает только свои запросы.

Cookie хранится в $STATE_DIRECTORY/cookie (0600), наружу не отдаётся и в лог не пишется.
Запросы принимаются только из локальной сети.

  GET  /              страница настройки: статус и поле для cookie
  GET  /kp-vote.js    плагин Lampa
  GET  /status        {"configured":bool,"loggedIn":bool|null}
  GET  /vote?kp=ID    {"kp":ID,"value":8|null}
  POST /vote          {"kp":ID,"rate":1..10}  или  {"kp":ID,"rate":0} — удалить оценку
  POST /cookie        {"cookie":"..."}  сохраняет, только если с ней виден вход в аккаунт
  POST /cookie/delete удаляет сохранённую cookie
"""
import ipaddress
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = os.environ.get("LISTEN", "0.0.0.0")
PORT = int(os.environ.get("PORT", "9121"))
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("STATE_DIRECTORY", HERE)
COOKIE_FILE = os.path.join(STATE, "cookie")
GRAPHQL = "https://graphql.kinopoisk.ru/graphql/?operationName="
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")
CACHE_TTL = 600
PROBE_ID = 326  # любой существующий фильм: по userData видно, вошли мы или нет

with open(os.path.join(HERE, "queries.json"), encoding="utf-8") as f:
    QUERIES = json.load(f)

_cache = {}
_lock = threading.Lock()


class KpError(Exception):
    def __init__(self, message, code=502):
        super().__init__(message)
        self.code = code


def read_cookie():
    try:
        with open(COOKIE_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def write_cookie(value):
    os.makedirs(STATE, exist_ok=True)
    tmp = COOKIE_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(value)
    os.replace(tmp, COOKIE_FILE)


def clean_cookie(raw):
    raw = (raw or "").strip()
    if raw.lower().startswith("cookie:"):
        raw = raw[7:].strip()
    return " ".join(raw.split())


def gql(operation, variables, cookie=None):
    cookie = cookie if cookie is not None else read_cookie()
    if not cookie:
        raise KpError("cookie Кинопоиска не задана", 409)
    body = json.dumps({"operationName": operation, "query": QUERIES[operation],
                       "variables": variables}).encode()
    req = urllib.request.Request(GRAPHQL + operation, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Service-Id": "25",
        "Origin": "https://www.kinopoisk.ru",
        "Referer": "https://www.kinopoisk.ru/",
        "User-Agent": UA,
        "Cookie": cookie,
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        raise KpError(f"Кинопоиск ответил {e.code}")
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise KpError(f"Кинопоиск недоступен: {e}")
    if data.get("errors"):
        raise KpError("; ".join(str(x.get("message")) for x in data["errors"]))
    return data.get("data") or {}


def preview(kp, cookie=None):
    data = gql("MoviePreviewCard", {"movieId": kp, "actorsLimit": 1, "withUserData": True,
                                    "seasonSubscriptionsSupported": False}, cookie)
    movie = data.get("movie")
    if movie is None:
        raise KpError("фильм не найден на Кинопоиске", 404)
    return movie


def logged_in(cookie=None):
    try:
        return preview(PROBE_ID, cookie).get("userData") is not None
    except KpError as e:
        if "authentication" in str(e).lower() or "anonymous" in str(e).lower():
            return False
        raise


def get_vote(kp):
    with _lock:
        hit = _cache.get(kp)
        if hit and time.time() - hit[1] < CACHE_TTL:
            return hit[0]
    movie = preview(kp)
    user = movie.get("userData")
    if user is None:
        raise KpError("cookie Кинопоиска устарела: войдите заново и обновите её", 401)
    value = (user.get("voting") or {}).get("value")
    with _lock:
        _cache[kp] = (value, time.time())
    return value


def set_vote(kp, rate):
    if rate:
        data = gql("MovieSetVote", {"movieId": kp, "rate": rate})
        result = ((data.get("movie") or {}).get("vote") or {}).get("set") or {}
    else:
        data = gql("MovieRemoveVote", {"movieId": kp})
        result = ((data.get("movie") or {}).get("vote") or {}).get("remove") or {}
    if result.get("error"):
        raise KpError(result["error"].get("message") or "Кинопоиск отклонил оценку")
    value = rate or None
    with _lock:
        _cache[kp] = (value, time.time())
    return value


def is_local(addr):
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_private or ip.is_loopback


SETUP_PAGE = """<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Кинопоиск для Lampa</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222}
textarea{width:100%;height:140px;font:13px monospace}button{font-size:16px;padding:6px 16px;margin-right:8px}
#st{padding:8px 12px;border-radius:6px;background:#eee}.ok{background:#e3f5e1!important}.bad{background:#fbe4e4!important}
ol li{margin-bottom:4px}</style></head><body>
<h2>Оценки Кинопоиска в Lampa</h2><p id="st">Проверяю…</p>
<h3>Как взять cookie</h3><ol>
<li>Откройте <a href="https://www.kinopoisk.ru/" target="_blank">kinopoisk.ru</a> в браузере, где вы вошли в аккаунт.</li>
<li>Нажмите F12 → вкладка <b>Network</b> (Сеть), в фильтре введите <code>graphql</code>, обновите страницу (F5).</li>
<li>Щёлкните любой запрос <code>graphql.kinopoisk.ru</code> → <b>Headers</b> → раздел <b>Request Headers</b>.</li>
<li>Найдите строку <code>cookie:</code>, щёлкните по значению правой кнопкой → <b>Copy value</b>.</li>
<li>Вставьте ниже и нажмите «Сохранить». Cookie хранится только на этом сервере.</li></ol>
<textarea id="c" placeholder="cookie из запроса к graphql.kinopoisk.ru"></textarea><p>
<button onclick="save()">Сохранить</button><button onclick="del()">Удалить cookie</button></p>
<script>
async function st(){const s=document.getElementById('st');try{const j=await (await fetch('status')).json();
s.className=j.loggedIn?'ok':'bad';s.textContent=!j.configured?'Cookie не задана.':j.loggedIn?'Готово: вход в Кинопоиск виден, оценки работают.':'Cookie задана, но вход не виден — обновите её.';}
catch(e){s.className='bad';s.textContent='Ошибка: '+e.message;}}
async function save(){const v=document.getElementById('c').value;const r=await fetch('cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:v})});
const j=await r.json();document.getElementById('c').value='';alert(j.ok?'Сохранено, вход виден.':(j.error||'Не сохранено'));st();}
async function del(){if(!confirm('Удалить cookie?'))return;await fetch('cookie/delete',{method:'POST'});st();}
st();</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "kp-vote"
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
            raise KpError("слишком большой запрос", 413)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise KpError("неверный JSON", 400)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.guard():
            return
        url = urllib.parse.urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(url.query)
        try:
            if path == "/":
                return self.send(200, SETUP_PAGE.encode(), "text/html; charset=utf-8")
            if path == "/kp-vote.js":
                with open(os.path.join(HERE, "kp-vote.js"), "rb") as f:
                    return self.send(200, f.read(), "application/javascript; charset=utf-8")
            if path == "/health":
                return self.reply(200, {"ok": True})
            if path == "/status":
                if not read_cookie():
                    return self.reply(200, {"configured": False, "loggedIn": False})
                return self.reply(200, {"configured": True, "loggedIn": logged_in()})
            if path == "/vote":
                kp = int((query.get("kp") or ["0"])[0])
                if kp <= 0:
                    raise KpError("нет id Кинопоиска", 400)
                return self.reply(200, {"kp": kp, "value": get_vote(kp)})
            self.reply(404, {"error": "not found"})
        except KpError as e:
            self.reply(e.code, {"error": str(e)})
        except ValueError:
            self.reply(400, {"error": "неверный id"})

    def do_POST(self):
        if not self.guard():
            return
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        try:
            if path == "/vote":
                data = self.body()
                kp = int(data.get("kp") or 0)
                rate = int(data.get("rate") or 0)
                if kp <= 0 or not 0 <= rate <= 10:
                    raise KpError("нужны kp и rate от 0 до 10", 400)
                return self.reply(200, {"kp": kp, "value": set_vote(kp, rate)})
            if path == "/cookie":
                cookie = clean_cookie(self.body().get("cookie"))
                names = [p.split("=", 1)[0].strip() for p in cookie.split(";") if "=" in p]
                if not names:
                    raise KpError("это не похоже на cookie: нужна строка вида имя=значение; имя=значение", 400)
                if not logged_in(cookie):
                    shown = ", ".join(names[:20]) + (" …" if len(names) > 20 else "")
                    raise KpError(f"с этой cookie вход в Кинопоиск не виден (в ней {len(names)} полей: {shown})", 400)
                write_cookie(cookie)
                with _lock:
                    _cache.clear()
                return self.reply(200, {"ok": True})
            if path == "/cookie/delete":
                try:
                    os.remove(COOKIE_FILE)
                except FileNotFoundError:
                    pass
                with _lock:
                    _cache.clear()
                return self.reply(200, {"ok": True})
            self.reply(404, {"error": "not found"})
        except KpError as e:
            self.reply(e.code, {"error": str(e)})
        except ValueError:
            self.reply(400, {"error": "неверные данные"})


if __name__ == "__main__":
    print(f"kp-vote on {LISTEN}:{PORT}, state {STATE}", flush=True)
    ThreadingHTTPServer((LISTEN, PORT), Handler).serve_forever()
