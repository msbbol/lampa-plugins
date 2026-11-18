#!/usr/bin/env python3
"""Собирает рейтинги Кинопоиска для всех закладок Lampa (Lampac) в один JSON.

Источник рейтингов — API ПоискКино (poiskkino.dev, бывший kinopoisk.dev), ключ — в KEY_FILE.
Сопоставление: сначала пачками по TMDB id (externalId.tmdb), остальное — через
Lampac /externalids (TMDB -> kinopoisk_id) и пачками по id Кинопоиска.

Результат: OUT_FILE = {"updated": <unix>, "r": {"movie:278": [kp, kp_votes, kp_id], ...}}
Плагин fav-sort.js читает его как {localhost}/kp/ratings.json (или по адресу из ?kp=).

Настройка — переменными окружения: LAMPAC_URL, LAMPAC_ACCOUNT, KP_KEY_FILE, KP_STATE, KP_OUT.
https://github.com/msbbol/lampa-plugins

Запуск по cron раз в час; за запуск тратит не больше MAX_REQ_RUN запросов к API,
за сутки — не больше MAX_REQ_DAY (бесплатный тариф ограничен).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LAMPAC = os.environ.get("LAMPAC_URL", "http://127.0.0.1:9118")
ACCOUNT = os.environ.get("LAMPAC_ACCOUNT", "")   # email аккаунта Lampac (accsdb), чьи закладки берём
API = os.environ.get("KP_API", "https://api.poiskkino.dev/v1.4/movie")
KEY_FILE = os.environ.get("KP_KEY_FILE", "/opt/lampac/config/kp-api.key")
STATE_FILE = os.environ.get("KP_STATE", "/opt/lampac/kp-state.json")
OUT_FILE = os.environ.get("KP_OUT", "/opt/lampac/kp/ratings.json")

CHUNK = 100                      # id в одном запросе к API
MAX_REQ_RUN = int(os.environ.get("KP_MAX_REQ_RUN", "40"))
MAX_REQ_DAY = int(os.environ.get("KP_MAX_REQ_DAY", "150"))
REFRESH_AGE = 30 * 86400         # найденные рейтинги обновляем раз в месяц
MISS_RETRY = 14 * 86400          # ненайденные пробуем снова через две недели
FIELDS = ["id", "externalId", "rating", "votes", "isSeries", "year"]


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def http_json(url, headers=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def save_json(path, data, compact=False):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def card_key(card):
    is_tv = bool(card.get("name") or card.get("original_name") or card.get("first_air_date"))
    return ("tv:" if is_tv else "movie:") + str(card["id"])


YEARS = {}   # key -> год выхода по TMDB, для проверки совпадений


def bookmark_keys():
    q = urllib.parse.urlencode({"account_email": ACCOUNT})
    data = http_json(f"{LAMPAC}/bookmark/list?{q}")
    if data.get("dbInNotInitialization"):
        raise RuntimeError("закладки в Lampac ещё не инициализированы")
    keys = []
    for card in data.get("card") or []:
        if isinstance(card, dict) and card.get("id"):
            k = card_key(card)
            keys.append(k)
            y = str(card.get("release_date") or card.get("first_air_date") or "")[:4]
            if y.isdigit():
                YEARS[k] = int(y)
    return list(dict.fromkeys(keys))


def year_ok(key, doc):
    """Год на Кинопоиске и в TMDB должен совпадать (±1); без года не проверяем."""
    y1, y2 = YEARS.get(key), doc.get("year")
    return not y1 or not y2 or abs(int(y1) - int(y2)) <= 1


class Budget(Exception):
    pass


class Api:
    def __init__(self, key, state):
        self.key = key
        self.state = state
        day = time.strftime("%Y-%m-%d")
        if state.get("day") != day:
            state["day"], state["day_req"] = day, 0
        self.run_req = 0

    def query(self, field, values):
        if self.run_req >= MAX_REQ_RUN or self.state["day_req"] >= MAX_REQ_DAY:
            raise Budget()
        params = [("page", "1"), ("limit", str(max(len(values), 10)))]
        params += [("selectFields", f) for f in FIELDS]
        params += [(field, str(v)) for v in values]
        url = API + "?" + urllib.parse.urlencode(params)
        self.run_req += 1
        self.state["day_req"] += 1
        try:
            data = http_json(url, {"X-API-KEY": self.key, "Accept": "application/json"})
        except urllib.error.HTTPError as e:
            if e.code in (401, 402, 403, 429):
                log(f"API ответило {e.code}: ключ неверный или исчерпан лимит, остановка")
                raise Budget()
            raise
        return data.get("docs") or []


def doc_entry(doc):
    rating = doc.get("rating") or {}
    votes = doc.get("votes") or {}
    kp = rating.get("kp") or 0
    return [round(float(kp), 3), int(votes.get("kp") or 0), doc.get("id")]


def resolve_by_tmdb(api, keys, found):
    """keys: ['movie:278', ...] -> заполняет found[key] = entry."""
    by_id = {}
    for k in keys:
        kind, tid = k.split(":")
        by_id.setdefault(tid, set()).add(kind)
    ids = list(by_id)
    for i in range(0, len(ids), CHUNK):
        part = ids[i:i + CHUNK]
        for doc in api.query("externalId.tmdb", part):
            tmdb = str((doc.get("externalId") or {}).get("tmdb") or "")
            kinds = by_id.get(tmdb)
            if not kinds:
                continue
            kind = "tv" if doc.get("isSeries") else "movie"
            if kind not in kinds:
                # id фильмов и сериалов в TMDB пересекаются: чужой тип — почти всегда другой тайтл
                continue
            key = f"{kind}:{tmdb}"
            if not year_ok(key, doc):
                continue
            # если по одному TMDB id нашлось несколько записей, берём ту, где больше оценок
            if key not in found or doc_entry(doc)[1] > found[key][1]:
                found[key] = doc_entry(doc)


def kp_id_from_lampac(key):
    kind, tid = key.split(":")
    q = urllib.parse.urlencode({"id": tid, "serial": 1 if kind == "tv" else 0, "account_email": ACCOUNT})
    try:
        data = http_json(f"{LAMPAC}/externalids?{q}", timeout=20)
    except Exception:
        return None
    kp = str(data.get("kinopoisk_id") or "")
    return int(kp) if kp.isdigit() and kp != "0" else None


def resolve_by_kpid(api, keys, found, state):
    known = state.setdefault("kpid", {})
    need = {}
    for k in keys:
        kp = known.get(k)
        if kp is None:
            kp = kp_id_from_lampac(k) or 0
            known[k] = kp
        if kp:
            need[kp] = k
    ids = list(need)
    for i in range(0, len(ids), CHUNK):
        for doc in api.query("id", ids[i:i + CHUNK]):
            k = need.get(doc.get("id"))
            if k and year_ok(k, doc):
                found[k] = doc_entry(doc)


def main():
    if not os.path.exists(KEY_FILE):
        log(f"нет ключа API ({KEY_FILE}) — пропуск")
        return 0
    key = open(KEY_FILE, encoding="utf-8").read().strip()
    if not key:
        log("файл ключа пустой — пропуск")
        return 0

    state = load_json(STATE_FILE, {})
    ratings = state.setdefault("r", {})      # key -> [kp, votes, kp_id, checked_at] или [0,0,None,checked_at]
    now = int(time.time())

    keys = bookmark_keys()

    def due(k):
        e = ratings.get(k)
        if not e:
            return True
        age = now - e[3]
        return age > (REFRESH_AGE if e[0] else MISS_RETRY)

    todo = [k for k in keys if due(k)]
    # сначала то, чего ещё нет совсем, потом обновление старого
    todo.sort(key=lambda k: (k in ratings, ratings.get(k, [0, 0, 0, 0])[3]))
    log(f"закладок: {len(keys)}, к обработке: {len(todo)}")

    api = Api(key, state)
    found = {}
    stopped = False
    try:
        batch = todo[: CHUNK * MAX_REQ_RUN]
        resolve_by_tmdb(api, batch, found)
        rest = [k for k in batch if k not in found]
        if rest:
            resolve_by_kpid(api, rest, found, state)
        for k in batch:
            if k in found:
                ratings[k] = found[k] + [now]
            else:
                ratings[k] = [0, 0, None, now]
    except Budget:
        stopped = True
        for k, e in found.items():
            ratings[k] = e + [now]
    finally:
        save_json(STATE_FILE, state)

    out = {"updated": now, "r": {k: e[:3] for k, e in ratings.items() if e[0]}}
    save_json(OUT_FILE, out, compact=True)
    log(f"найдено в этом запуске: {len(found)}, всего с рейтингом: {len(out['r'])}, "
        f"запросов: {api.run_req} (за сутки {state['day_req']})" + (" — остановлено по лимиту" if stopped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
