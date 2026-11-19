#!/usr/bin/env python3
"""Свой прокси авторизации MyShows для плагина Igorek1986/lampa-plugins (myshows.js).

В браузерной Lampa запрос логина напрямую к myshows.me блокируется CORS, поэтому плагин
шлёт логин/пароль на прокси. Этот прокси заменяет сторонний myshows.igorek1986.ru:
принимает POST /auth {"login","password"}, передаёт в https://myshows.me/api/session
и возвращает {"token": ...}. Ничего не сохраняет и тело запросов не логирует.
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = os.environ.get("LISTEN", "0.0.0.0")
PORT = int(os.environ.get("PORT", "9120"))
UPSTREAM = "https://myshows.me/api/session"
MAX_BODY = 4096


class Handler(BaseHTTPRequestHandler):
    server_version = "myshows-auth-proxy"
    sys_version = ""

    def log_message(self, fmt, *args):
        # только метод, путь без query и код ответа — без логинов и паролей
        print(f"{self.address_string()} {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}", flush=True)

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/health"):
            return self.reply(200, {"ok": True})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") not in ("/auth", "/myshows/auth"):
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self.reply(400, {"error": "bad request"})
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            login, password = data.get("login"), data.get("password")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "bad json"})
        if not login or not password:
            return self.reply(400, {"error": "login and password are required"})

        req = urllib.request.Request(
            UPSTREAM,
            data=json.dumps({"login": login, "password": password}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "Mozilla/5.0 (Lampa MyShows plugin)"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                upstream = json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            return self.reply(e.code if 400 <= e.code < 500 else 502, {"error": "myshows rejected login", "status": e.code})
        except Exception:
            return self.reply(502, {"error": "myshows unreachable"})

        token = upstream.get("token") if isinstance(upstream, dict) else None
        if not token:
            return self.reply(401, {"error": "no token"})
        self.reply(200, {"token": token})


if __name__ == "__main__":
    ThreadingHTTPServer((LISTEN, PORT), Handler).serve_forever()
