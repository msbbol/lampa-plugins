/*!
 * kp-vote.js — ваши оценки Кинопоиска в Lampa (msbbol).
 * В карточке: значок «Моя КП» с вашей оценкой и кнопка «Оценить» (1–10, удалить оценку).
 * Когда фильм или сериал отмечен просмотренным (кнопкой MyShows или «Просмотрено» Lampa), предлагает поставить оценку.
 * Оценки читаются и ставятся через сервис kp-vote на домашнем сервере (cookie Кинопоиска хранится там).
 * Работает только в основном профиле (profiles.js): оценки уходят в один аккаунт Кинопоиска.
 */
(function () {
  'use strict';

  if (window.kp_vote_plugin) return;
  window.kp_vote_plugin = true;

  var SCRIPT = (document.currentScript && document.currentScript.src) || '';
  var API = SCRIPT ? SCRIPT.replace(/\/kp-vote\.js.*$/, '') : window.location.protocol + '//' + window.location.hostname + ':9121';
  var MAP_KEY = 'kp_vote_map';
  var ASK_KEY = 'kp_vote_ask_viewed';
  var STAR = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7L12 17.5 5.8 21.2l1.6-7L2 9.5l7.1-.6z"/></svg>';

  function mainProfile() {
    return !window.profiles_plugin || !Lampa.Storage.get('lampac_profile_id', '');
  }

  function account(url) {
    var email = Lampa.Storage.get('account_email', '');
    var uid = Lampa.Storage.get('lampac_unic_id', '');
    if (email) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
    if (uid) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));
    return url;
  }

  function lampacHost() {
    var plugin = (Lampa.Plugins.get() || []).filter(function (p) { return /\/lampainit\.js|\/tg-notify\.js|\/fav-sort\.js/.test(p.url || ''); })[0];
    if (plugin) return plugin.url.replace(/\/[^/]+$/, '');
    return window.location.origin;
  }

  function json(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  // TMDB -> id Кинопоиска (через Lampac /externalids), с кешем
  function kpId(card) {
    if (!card) return Promise.resolve(null);
    var direct = card.kinopoisk_id || card.kp_id;
    if (direct && /^\d+$/.test(String(direct))) return Promise.resolve(parseInt(direct, 10));
    if (!card.id || (card.source && card.source !== 'tmdb' && card.source !== 'cub')) return Promise.resolve(null);

    var serial = card.name || card.original_name || card.number_of_seasons ? 1 : 0;
    var key = (serial ? 'tv:' : 'movie:') + card.id;
    var map = Lampa.Storage.get(MAP_KEY, {}) || {};
    if (map[key] !== undefined) return Promise.resolve(map[key] || null);

    var url = account(lampacHost() + '/externalids?id=' + encodeURIComponent(card.id) + '&serial=' + serial);
    return json('GET', url).then(function (data) {
      var kp = parseInt(data.kinopoisk_id, 10) || 0;
      map = Lampa.Storage.get(MAP_KEY, {}) || {};
      map[key] = kp;
      Lampa.Storage.set(MAP_KEY, map, true);
      return kp || null;
    }).catch(function () { return null; });
  }

  function getVote(kp) {
    return json('GET', API + '/vote?kp=' + kp).then(function (d) { return d.value; });
  }

  function setVote(kp, rate) {
    return json('POST', API + '/vote', { kp: kp, rate: rate }).then(function (d) { return d.value; });
  }

  function cardTitle(card) {
    return card.title || card.name || card.original_title || card.original_name || '';
  }

  // ---------- карточка ----------
  function renderBadge(render, value) {
    var line = render.find('.full-start-new__rate-line, .full-start__rate-line').first();
    if (!line.length) return;
    var badge = line.find('.rate--kp-my');
    if (!value) {
      badge.remove();
      return;
    }
    if (!badge.length) {
      badge = $('<div class="full-start__rate rate--kp-my"><div></div><div>Моя КП</div></div>');
      var kp = line.find('.rate--kp');
      if (kp.length) kp.after(badge); else line.prepend(badge);
    }
    badge.find('div').first().text(value);
  }

  function renderButton(render, state) {
    var buttons = render.find('.full-start-new__buttons, .full-start__buttons').first();
    if (!buttons.length) return;
    var btn = buttons.find('.button--kp-vote');
    if (!btn.length) {
      btn = $('<div class="full-start__button selector button--kp-vote">' + STAR + '<span></span></div>');
      var opts = buttons.find('.button--options');
      if (opts.length) opts.before(btn); else buttons.append(btn);
      btn.on('hover:enter', function () { choose(state, function () { Lampa.Controller.toggle('full_start'); }); });
    }
    btn.find('span').text(state.value ? 'Моя оценка: ' + state.value : 'Оценить');
  }

  function update(state) {
    renderBadge(state.render, state.value);
    renderButton(state.render, state);
  }

  function choose(state, back, title) {
    var items = [];
    for (var i = 10; i >= 1; i--) items.push({ title: String(i), rate: i, selected: state.value === i });
    if (state.value) items.push({ title: 'Удалить оценку', rate: 0 });
    if (title) items.push({ title: 'Не сейчас', skip: true });

    Lampa.Select.show({
      title: title || 'Оценка на Кинопоиске',
      items: items,
      onBack: back,
      onSelect: function (item) {
        back();
        if (item.skip) return;
        setVote(state.kp, item.rate).then(function (value) {
          state.value = value;
          if (state.render) update(state);
          Lampa.Noty.show(value ? 'Оценка ' + value + ' отправлена на Кинопоиск' : 'Оценка на Кинопоиске удалена');
        }).catch(function (e) {
          Lampa.Noty.show('Кинопоиск: ' + e.message);
        });
      }
    });
  }

  var current = null; // состояние открытой карточки

  Lampa.Listener.follow('full', function (e) {
    if (e.type !== 'complite' || !mainProfile()) return;
    var card = e.data && e.data.movie;
    var render = e.object && e.object.activity && e.object.activity.render();
    if (!card || !render) return;

    var state = { card: card, render: render, kp: null, value: null };
    current = state;

    kpId(card).then(function (kp) {
      if (!kp) return;
      state.kp = kp;
      renderButton(render, state);
      return getVote(kp).then(function (value) {
        state.value = value;
        update(state);
      });
    }).catch(function (err) {
      if (/cookie/i.test(err.message)) renderButton(render, state);
      console.log('kp-vote', err.message);
    });
  });

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

  // ---------- оценка при отметке просмотренным (MyShows или «Просмотрено» Lampa) ----------
  function playerOpened() {
    return !!(Lampa.Player && Lampa.Player.opened && Lampa.Player.opened());
  }

  function askFor(card) {
    if (!card || !mainProfile() || String(Lampa.Storage.get(ASK_KEY, true)) === 'false' || !once(card)) return;
    var state = current && current.card && current.card.id === card.id ? current : { card: card, render: null, kp: null, value: null };
    var ready = state.kp ? Promise.resolve(state.kp) : kpId(state.card).then(function (kp) { state.kp = kp; return kp; });
    ready.then(function (kp) {
      if (!kp) return;
      return (state.value ? Promise.resolve(state.value) : getVote(kp)).then(function (value) {
        state.value = value;
        if (value) return; // оценка уже стоит
        var show = function () {
          var controller = Lampa.Controller.enabled().name;
          choose(state, function () { Lampa.Controller.toggle(controller); }, 'Оцените «' + cardTitle(state.card) + '»');
        };
        if (playerOpened()) {
          // MyShows отмечает просмотр и во время воспроизведения — спросим, когда плеер закроется
          var wait = function (e) {
            if (e.type !== 'destroy') return;
            Lampa.Player.listener.remove('destroy', wait);
            setTimeout(show, 600);
          };
          Lampa.Player.listener.follow('destroy', wait);
        } else setTimeout(show, 300);
      });
    }).catch(function (err) { console.log('kp-vote', err.message); });
  }

  watchedHook();
  Lampa.Listener.follow('msbbol_watched', function (e) { askFor(e.card); });
  Lampa.Favorite.listener.follow('add', function (e) {
    if (e.where === 'viewed') askFor(e.card);
  });

  // ---------- настройки ----------
  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({
      component: 'kp_vote',
      name: 'Оценки Кинопоиска',
      icon: STAR
    });
    Lampa.SettingsApi.addParam({
      component: 'kp_vote',
      param: { name: 'kp_vote_status', type: 'static' },
      field: { name: 'Состояние', description: 'Проверяю…' },
      onRender: function (item) {
        json('GET', API + '/status').then(function (s) {
          item.find('.settings-param__descr').text(
            !mainProfile() ? 'Оценки работают только в основном профиле.' :
              !s.configured ? 'Cookie Кинопоиска не задана — откройте страницу настройки.' :
                s.loggedIn ? 'Готово: оценки уходят в ваш аккаунт Кинопоиска.' :
                  'Cookie устарела — обновите её на странице настройки.');
        }).catch(function (e) {
          item.find('.settings-param__descr').text('Сервис недоступен: ' + e.message);
        });
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'kp_vote',
      param: { name: ASK_KEY, type: 'trigger', default: true },
      field: { name: 'Спрашивать оценку', description: 'Когда фильм или сериал отмечен просмотренным в MyShows или «Просмотрено» Lampa' }
    });
    Lampa.SettingsApi.addParam({
      component: 'kp_vote',
      param: { name: 'kp_vote_setup', type: 'static' },
      field: { name: 'Страница настройки', description: API + '/ — откройте на компьютере, чтобы задать cookie Кинопоиска' }
    });
  }

  if (window.appready) addSettings();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') addSettings(); });
})();
