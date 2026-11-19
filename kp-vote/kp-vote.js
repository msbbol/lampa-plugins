/*!
 * kp-vote.js — ваши оценки Кинопоиска в Lampa (msbbol).
 * В карточке: значок «Моя КП» с вашей оценкой и кнопка «Оценить» (1–10, удалить оценку).
 * При отметке «Просмотрено» в открытой карточке предлагает поставить оценку.
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

  // ---------- оценка при отметке «Просмотрено» ----------
  Lampa.Favorite.listener.follow('add,added', function (e) {
    if (e.where !== 'viewed' || !mainProfile() || String(Lampa.Storage.get(ASK_KEY, true)) === 'false') return;
    var active = Lampa.Activity.active();
    if (!active || active.component !== 'full' || !e.card || !current || !current.card || current.card.id !== e.card.id) return;

    var state = current;
    var ready = state.kp ? Promise.resolve(state.kp) : kpId(state.card).then(function (kp) { state.kp = kp; return kp; });
    ready.then(function (kp) {
      if (!kp || state.value) return;
      setTimeout(function () {
        var controller = Lampa.Controller.enabled().name;
        choose(state, function () { Lampa.Controller.toggle(controller); }, 'Оцените «' + cardTitle(state.card) + '»');
      }, 300);
    });
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
      field: { name: 'Спрашивать оценку', description: 'Когда отмечаете фильм или сериал как «Просмотрено» в его карточке' }
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
