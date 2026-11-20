/*!
 * fx-sync.js — просмотренное из Lampa в Filmix (msbbol).
 * Отметка «Просмотрено» (кнопкой MyShows в карточке или статусом Lampa): фильм попадает в плейлист Filmix «Просмотрено»,
 * сериал — в «Просмотрено. Сериалы», и тайтл убирается из «Закладок» Filmix.
 * Запросы к Filmix делает сервис fx-sync на домашнем сервере (cookie Filmix хранится там).
 * Работает только в основном профиле (profiles.js): аккаунт Filmix один.
 */
(function () {
  'use strict';

  if (window.fx_sync_plugin) return;
  window.fx_sync_plugin = true;

  var SCRIPT = (document.currentScript && document.currentScript.src) || '';
  var API = SCRIPT ? SCRIPT.replace(/\/fx-sync\.js.*$/, '') : window.location.protocol + '//' + window.location.hostname + ':9122';
  var ON_KEY = 'fx_sync_enabled';
  var QUEUE_KEY = 'fx_sync_queue';
  var ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4zm0 4h7v2H4zm12.5-3.5L21 17l-4.5 4.5-1.4-1.4 2.1-2.1H13v-2h4.2l-2.1-2.1z"/></svg>';

  function mainProfile() {
    return !window.profiles_plugin || !Lampa.Storage.get('lampac_profile_id', '');
  }

  function enabled() {
    return String(Lampa.Storage.get(ON_KEY, true)) !== 'false';
  }

  function notify(text) {
    Lampa.Noty.show('Filmix: ' + text);
  }

  function post(body) {
    return fetch(API + '/watched', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function describe(card) {
    var tv = !!(card.name || card.original_name || card.number_of_seasons || card.first_air_date);
    var date = (tv ? card.first_air_date : card.release_date) || card.release_date || card.first_air_date || '';
    return {
      kind: tv ? 'tv' : 'movie',
      tmdb: (!card.source || card.source === 'tmdb' || card.source === 'cub') ? card.id : null,
      title: card.title || card.name || '',
      original_title: card.original_title || card.original_name || '',
      year: parseInt(String(date).slice(0, 4), 10) || 0
    };
  }

  // ---------- очередь на случай, если сервис или Filmix недоступны ----------
  function queue() {
    var q = Lampa.Storage.get(QUEUE_KEY, '[]');
    if (typeof q === 'string') { try { q = JSON.parse(q); } catch (e) { q = []; } }
    return Array.isArray(q) ? q : [];
  }

  function saveQueue(q) {
    Lampa.Storage.set(QUEUE_KEY, q.slice(-50));
  }

  function enqueue(item) {
    var q = queue().filter(function (x) { return !(x.kind === item.kind && x.tmdb && x.tmdb === item.tmdb && x.title === item.title); });
    q.push(item);
    saveQueue(q);
  }

  var flushing = false;
  function flush() {
    if (flushing || !mainProfile() || !enabled()) return;
    var q = queue();
    if (!q.length) return;
    flushing = true;
    var item = q[0];
    send(item, true).then(function (ok) {
      flushing = false;
      if (!ok) return;
      saveQueue(queue().slice(1));
      setTimeout(flush, 1500);
    });
  }

  // ---------- выбор, если Filmix нашёл несколько похожих ----------
  function choose(item, candidates) {
    // не перебивать другое окно выбора (например, оценку Кинопоиска) и плеер
    var busy = Lampa.Controller.enabled().name === 'select' || (Lampa.Player && Lampa.Player.opened && Lampa.Player.opened());
    if (busy) return setTimeout(function () { choose(item, candidates); }, 700);
    var controller = Lampa.Controller.enabled().name;
    var items = candidates.map(function (c) {
      return {
        title: c.title + (c.year ? ' (' + c.year + ')' : ''),
        subtitle: (c.original && c.original !== c.title ? c.original + ' · ' : '') + (c.series ? 'сериал' : 'фильм'),
        candidate: c
      };
    });
    items.push({ title: 'Пропустить', skip: true });
    Lampa.Select.show({
      title: 'Filmix: какой это «' + item.title + '»?',
      items: items,
      onSelect: function (a) {
        Lampa.Controller.toggle(controller);
        if (a.skip) return;
        var next = Object.assign({}, item, { filmix_id: a.candidate.id, candidate: a.candidate });
        send(next, false);
      },
      onBack: function () { Lampa.Controller.toggle(controller); }
    });
  }

  // true — обработано (успех или окончательный ответ), false — повторить позже
  function send(item, fromQueue) {
    return post(item).then(function (r) {
      if (r.status === 'done') {
        var parts = [];
        if (r.playlistAction === 'added') parts.push('в «' + r.playlist + '»');
        else parts.push('уже в «' + r.playlist + '»');
        if (r.favorites !== 'absent') parts.push('убран из закладок');
        notify('«' + item.title + '» ' + parts.join(', '));
      } else if (r.status === 'choose') {
        if (fromQueue) notify('уточните «' + item.title + '»');
        choose(item, r.candidates || []);
      } else if (r.status === 'not_found') {
        notify('«' + item.title + '» не найден на сайте');
      }
      return true;
    }).catch(function (err) {
      var retry = !err.status || err.status >= 500 || err.status === 401 || err.status === 409;
      if (retry && !fromQueue) {
        enqueue(item);
        notify('не отправлено (' + err.message + '), повторю позже');
      }
      console.log('fx-sync', err.message);
      return !retry;
    });
  }

  // ---------- общий перехват: MyShows отметил фильм или сериал просмотренным ----------
  // Плагин MyShows шлёт JSON-RPC manage.SetMovieStatus / manage.SetShowStatus со status "finished".
  // При успешном ответе рассылаем Lampa.Listener 'msbbol_watched' {card, kind}; карточка — открытая (кнопка MyShows в ней).
  function watchedHook() {
    if (window.msbbol_watched_hook) return;
    window.msbbol_watched_hook = true;
    var RX = /"method"\s*:\s*"manage\.Set(Movie|Show)Status"/;

    function inspect(body, onResponse) {
      if (typeof body !== 'string' || !RX.test(body)) return;
      var req;
      try { req = JSON.parse(body); } catch (e) { return; }
      if (!req || !req.params || req.params.status !== 'finished') return;
      var kind = req.method === 'manage.SetShowStatus' ? 'tv' : 'movie';
      var act = Lampa.Activity.active();
      var card = act && act.component === 'full' ? (act.card || null) : null;
      if (!card) return;
      onResponse(function (text) {
        var res;
        try { res = JSON.parse(text); } catch (e) { return; }
        if (res && res.result) Lampa.Listener.send('msbbol_watched', { card: card, kind: kind, source: 'myshows' });
      });
    }

    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      try {
        inspect(body, function (done) {
          xhr.addEventListener('load', function () { if (xhr.status >= 200 && xhr.status < 300) done(xhr.responseText); });
        });
      } catch (e) {}
      return send.apply(this, arguments);
    };
    if (window.fetch) {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var p = origFetch.apply(this, arguments);
        try {
          inspect(init && init.body, function (done) {
            p.then(function (r) { if (r.ok) r.clone().text().then(done); }).catch(function () {});
          });
        } catch (e) {}
        return p;
      };
    }
  }

  // одна и та же карточка может прийти и из «Просмотрено», и из MyShows — не дублируем
  var recent = {};
  function once(card) {
    var key = (card.name || card.original_name ? 'tv:' : 'movie:') + card.id;
    var now = Date.now();
    if (recent[key] && now - recent[key] < 120000) return false;
    recent[key] = now;
    return true;
  }

  function onWatched(card, kind) {
    if (!card || !mainProfile() || !enabled() || !once(card)) return;
    var item = describe(card);
    if (kind) item.kind = kind;
    if (!item.title && !item.original_title) return;
    send(item, false);
  }

  watchedHook();
  Lampa.Listener.follow('msbbol_watched', function (e) { onWatched(e.card, e.kind); });
  Lampa.Favorite.listener.follow('add', function (e) {
    if (e.where === 'viewed') onWatched(e.card);
  });

  // ---------- настройки ----------
  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({ component: 'fx_sync', name: 'Filmix: просмотренное', icon: ICON });
    Lampa.SettingsApi.addParam({
      component: 'fx_sync',
      param: { name: 'fx_sync_status', type: 'static' },
      field: { name: 'Состояние', description: 'Проверяю…' },
      onRender: function (item) {
        fetch(API + '/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
          var q = queue().length;
          item.find('.settings-param__descr').text(
            (!mainProfile() ? 'Работает только в основном профиле.' :
              !s.configured ? 'Cookie Filmix не задана — откройте страницу настройки.' :
                s.loggedIn ? 'Готово: ' + s.host + ', вход виден.' :
                  'Cookie Filmix устарела — обновите её на странице настройки.') +
            (q ? ' В очереди: ' + q + '.' : ''));
        }).catch(function (e) {
          item.find('.settings-param__descr').text('Сервис недоступен: ' + e.message);
        });
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'fx_sync',
      param: { name: ON_KEY, type: 'trigger', default: true },
      field: { name: 'Отправлять в Filmix', description: 'Отмеченное просмотренным в MyShows или «Просмотрено» Lampa: в плейлист «Просмотрено» или «Просмотрено. Сериалы», из закладок — убрать' }
    });
    Lampa.SettingsApi.addParam({
      component: 'fx_sync',
      param: { name: 'fx_sync_setup', type: 'static' },
      field: { name: 'Страница настройки', description: API + '/ — откройте на компьютере, чтобы задать cookie Filmix' }
    });
  }

  function start() {
    addSettings();
    setTimeout(flush, 5000);
    setInterval(flush, 10 * 60 * 1000);
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
