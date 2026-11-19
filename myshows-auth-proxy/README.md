# Свой прокси авторизации MyShows — `myshows-auth-proxy`

Плагин [MyShows для Lampa](https://github.com/Igorek1986/lampa-plugins) отмечает просмотренные серии в вашем аккаунте [myshows.me](https://myshows.me). В браузерной Lampa запрос входа напрямую к myshows.me блокирует CORS, поэтому плагин отправляет логин и пароль на прокси, по умолчанию — на сервер автора плагина.

Этот прокси делает то же самое на вашем сервере, чтобы логин и пароль не уходили третьей стороне: принимает `POST /auth` с `{"login", "password"}`, передаёт их в `https://myshows.me/api/session` и возвращает `{"token": …}`. Ничего не сохраняет, в лог пишет только метод, путь и код ответа.

## Установка

```sh
cp myshows-auth-proxy.py /opt/lampac/
cp myshows-auth-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now myshows-auth-proxy
curl -s localhost:9120/health     # {"ok": true}
```

Порт — `9120` (переменная `PORT`). Адрес прокси передаётся плагину параметром `auth_proxy`, например:

```
http://<сервер>:9118/myshows/myshows.js?auth_proxy=http://<сервер>:9120/auth
```

Python 3, без зависимостей.
