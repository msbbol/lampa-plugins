/*
 * fav-sort.js — сортировка и фильтр закладок для Lampa (3.x)
 * Версия: 1.0.0
 * https://github.com/msbbol/lampa-plugins · Лицензия MIT
 *
 * Работает в категориях закладок: «Позже», «Просмотрено», «Закладки», «Нравится», «Смотрю» и т.д.
 *
 * Как работает: оборачивает Lampa.Api.favorite — штатную функцию, которая отдаёт страницу
 * закладок по 20 карточек. Если для категории выбраны сортировка/фильтры, список сначала
 * сортируется и фильтруется, затем режется на страницы. Без настроек поведение штатное.
 * Кнопка-воронка в шапке видна только на страницах закладок. Настройки хранятся на устройстве
 * отдельно для каждой категории.
 *
 * Рейтинг Кинопоиска (необязательно): сервер (kp-ratings.py по cron) кладёт рейтинги закладок
 * в JSON-файл, плагин его читает. Адрес файла:
 *   - параметр ?kp=<url> в адресе плагина, например fav-sort.js?kp=http://192.168.1.10:9118/kp/ratings.json
 *   - иначе <папка плагина>/kp/ratings.json, если плагин отдаёт свой сервер (Lampac);
 *   - при загрузке с github.io без ?kp= функции Кинопоиска отключены и скрыты.
 *
 * ES5 — чтобы работало на старых Tizen/webOS.
 */
(function () {
  'use strict';

  if (window.fav_sort_plugin) return;
  window.fav_sort_plugin = true;

  var STORAGE_KEY = 'fav_sort_state';
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
  var VERSION = '1.0.0';
  var KP_URL = (function () {
    var m = SCRIPT_SRC.match(/[?&]kp=([^&#]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    if (!SCRIPT_SRC) return location.origin + '/kp/ratings.json';
    if (/^https?:\/\/[^\/]*\.github\.io\//i.test(SCRIPT_SRC)) return '';
    return SCRIPT_SRC.split(/[?#]/)[0].replace(/\/[^\/]*$/, '') + '/kp/ratings.json';
  })();
  var SKIP_TYPES = { history: true };

  var GENRES = {
    28: 'Боевик', 12: 'Приключения', 16: 'Мультфильм', 35: 'Комедия', 80: 'Криминал',
    99: 'Документальный', 18: 'Драма', 10751: 'Семейный', 14: 'Фэнтези', 36: 'История',
    27: 'Ужасы', 10402: 'Музыка', 9648: 'Детектив', 10749: 'Мелодрама', 878: 'Фантастика',
    10770: 'Телефильм', 53: 'Триллер', 10752: 'Военный', 37: 'Вестерн',
    10759: 'Боевик и приключения', 10762: 'Детский', 10763: 'Новости', 10764: 'Реалити-шоу',
    10765: 'НФ и фэнтези', 10766: 'Мыльная опера', 10767: 'Ток-шоу', 10768: 'Война и политика'
  };

  var SORTS = [
    { id: 'added', title: 'Сначала новые добавленные' },
    { id: 'added_asc', title: 'Сначала старые добавленные' },
    { id: 'year_desc', title: 'Год: сначала новые' },
    { id: 'year_asc', title: 'Год: сначала старые' },
    { id: 'rating', title: 'Рейтинг TMDB' },
    { id: 'kp', title: 'Рейтинг Кинопоиска' },
    { id: 'title', title: 'Название (А→Я)' }
  ];

  var KINDS = [
    { id: 'all', title: 'Все' },
    { id: 'movie', title: 'Фильмы' },
    { id: 'tv', title: 'Сериалы' },
    { id: 'cartoon', title: 'Мультфильмы', descr: 'и мультсериалы, аниме' },
    { id: 'show', title: 'ТВ-шоу', descr: 'реалити, ток-шоу, новости' }
  ];

  // Жанры TMDB: 16 — анимация; 10764 — реалити, 10767 — ток-шоу, 10763 — новости
  var SHOW_GENRES = [10764, 10767, 10763];

  var RATINGS = [0, 5, 6, 7, 7.5, 8];

  var DEFAULT_STATE = { sort: 'added', kind: 'all', genre: 0, decade: 'all', rating: 0, kprating: 0 };

  /* ---------- состояние ---------- */

  function allStates() {
    var s = Lampa.Storage.get(STORAGE_KEY, '{}');
    if (typeof s === 'string') {
      try { s = JSON.parse(s); } catch (e) { s = {}; }
    }
    return s && typeof s === 'object' ? s : {};
  }

  function getState(type) {
    var s = allStates()[type] || {};
    var r = {};
    for (var k in DEFAULT_STATE) r[k] = s.hasOwnProperty(k) ? s[k] : DEFAULT_STATE[k];
    return r;
  }

  function setState(type, state) {
    var s = allStates();
    s[type] = state;
    Lampa.Storage.set(STORAGE_KEY, s);
  }

  function isDefault(st) {
    for (var k in DEFAULT_STATE) if (st[k] !== DEFAULT_STATE[k]) return false;
    return true;
  }

  /* ---------- данные карточки ---------- */

  function isTv(card) {
    return !!(card.name || card.original_name || card.first_air_date);
  }

  function yearOf(card) {
    var d = card.release_date || card.first_air_date || '';
    var y = parseInt(String(d).slice(0, 4), 10);
    return isNaN(y) ? 0 : y;
  }

  function titleOf(card) {
    return String(card.title || card.name || card.original_title || card.original_name || '');
  }

  function ratingOf(card) {
    var v = parseFloat(card.vote_average);
    return isNaN(v) ? 0 : v;
  }

  function votesOf(card) {
    var n = parseInt(card.vote_count, 10);
    return isNaN(n) ? 0 : n;
  }

  // Взвешенный рейтинг (как в топах IMDb): фильм с одной оценкой «10» не обгонит фильм с 8.5 и тысячами оценок
  var MIN_VOTES = 50, MEAN = 6.5;
  function weightedOf(card) {
    var v = votesOf(card), r = ratingOf(card);
    return (v / (v + MIN_VOTES)) * r + (MIN_VOTES / (v + MIN_VOTES)) * MEAN;
  }

  // Для фильтра «от N»: учитываем только оценки, которым можно верить (от 10 голосов)
  function passesRating(card, min) {
    return votesOf(card) >= 10 && ratingOf(card) >= min;
  }

  /* ---------- рейтинг Кинопоиска ---------- */

  var KP = { data: null, at: 0, waiting: null };

  function loadKp(done) {
    if (KP.data && Date.now() - KP.at < 10 * 60 * 1000) return done();
    if (!KP_URL) { KP.data = KP.data || {}; return done(); }
    if (KP.waiting) return KP.waiting.push(done);
    KP.waiting = [done];

    var finish = function () {
      var w = KP.waiting;
      KP.waiting = null;
      if (!KP.data) KP.data = {};
      w.forEach(function (f) { try { f(); } catch (e) { console.log('fav-sort', e); } });
    };

    var xhr = new XMLHttpRequest();
    xhr.open('GET', KP_URL + (KP_URL.indexOf('?') < 0 ? '?' : '&') + 't=' + Math.floor(Date.now() / 60000), true);
    xhr.timeout = 8000;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var json = JSON.parse(xhr.responseText);
          KP.data = json.r || {};
          KP.at = Date.now();
        } catch (e) { /* оставляем старые данные */ }
      }
      finish();
    };
    xhr.onerror = xhr.ontimeout = finish;
    xhr.send();
  }

  function kpOf(card) {
    return (KP.data && KP.data[(isTv(card) ? 'tv:' : 'movie:') + card.id]) || null;
  }

  function hasKpData() {
    for (var k in KP.data || {}) return true;
    return false;
  }

  // Тот же приём, что и для TMDB: у Кинопоиска оценок обычно тысячи, поэтому порог выше
  var KP_MIN_VOTES = 500, KP_MEAN = 6.5;
  function kpWeightedOf(card) {
    var e = kpOf(card);
    if (!e || !e[0]) return -1;
    var v = e[1] || 0;
    return (v / (v + KP_MIN_VOTES)) * e[0] + (KP_MIN_VOTES / (v + KP_MIN_VOTES)) * KP_MEAN;
  }

  function passesKp(card, min) {
    var e = kpOf(card);
    return !!e && e[1] >= 50 && e[0] >= min;
  }

  function needsKp(st) {
    return st.sort === 'kp' || !!st.kprating;
  }

  // Тип для фильтра — взаимоисключающий: мультфильм > ТВ-шоу > сериал > фильм
  function kindOf(card) {
    var g = genresOf(card);
    if (g.indexOf(16) >= 0) return 'cartoon';
    if (isTv(card)) {
      for (var i = 0; i < SHOW_GENRES.length; i++) if (g.indexOf(SHOW_GENRES[i]) >= 0) return 'show';
      return 'tv';
    }
    return 'movie';
  }

  function genresOf(card) {
    if (card.genre_ids && card.genre_ids.length) return card.genre_ids;
    if (card.genres && card.genres.length) return card.genres.map(function (g) { return g.id; });
    return [];
  }

  function decadeOf(year) {
    if (!year) return 'unknown';
    if (year < 1980) return 'old';
    return String(Math.floor(year / 10) * 10);
  }

  function decadeTitle(id) {
    if (id === 'all') return 'Все годы';
    if (id === 'old') return 'До 1980';
    if (id === 'unknown') return 'Год неизвестен';
    return id + '-е';
  }

  /* ---------- сортировка и фильтры ---------- */

  function apply(list, st) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (st.kind !== 'all' && kindOf(c) !== st.kind) continue;
      if (st.genre && genresOf(c).indexOf(st.genre) < 0) continue;
      if (st.decade !== 'all' && decadeOf(yearOf(c)) !== st.decade) continue;
      if (st.rating && !passesRating(c, st.rating)) continue;
      if (st.kprating && !passesKp(c, st.kprating)) continue;
      out.push({ card: c, index: i });
    }

    var cmp;
    switch (st.sort) {
      case 'added_asc': cmp = function (a, b) { return b.index - a.index; }; break;
      case 'year_desc': cmp = function (a, b) { return yearOf(b.card) - yearOf(a.card) || a.index - b.index; }; break;
      case 'year_asc': cmp = function (a, b) { return (yearOf(a.card) || 9999) - (yearOf(b.card) || 9999) || a.index - b.index; }; break;
      case 'rating': cmp = function (a, b) { return weightedOf(b.card) - weightedOf(a.card) || a.index - b.index; }; break;
      case 'kp': cmp = function (a, b) {
        // без рейтинга Кинопоиска — в конец, между собой по TMDB
        return kpWeightedOf(b.card) - kpWeightedOf(a.card) || weightedOf(b.card) - weightedOf(a.card) || a.index - b.index;
      }; break;
      case 'title': cmp = function (a, b) { return titleOf(a.card).localeCompare(titleOf(b.card), 'ru') || a.index - b.index; }; break;
      default: cmp = function (a, b) { return a.index - b.index; };
    }
    out.sort(cmp);
    return out.map(function (x) { return x.card; });
  }

  function categoryCards(type, filter) {
    var list = (Lampa.Favorite.get({ type: type }) || []).slice();
    if (filter) list = list.filter(function (a) { return filter === 'tv' ? isTv(a) : !isTv(a); });
    return list;
  }

  /* ---------- обёртка над Api.favorite ---------- */

  function hookApi() {
    var original = Lampa.Api.favorite;
    if (!original || original.__fav_sort) return;

    var wrapped = function (params, oncomplete, onerror) {
      params = params || {};
      var type = params.type;
      if (!type || SKIP_TYPES[type]) return original.apply(this, arguments);

      var st = getState(type);
      if (isDefault(st)) return original.apply(this, arguments);

      var build = function () {
        var list = apply(categoryCards(type, params.filter), st);
        var total_pages = Math.ceil(list.length / 20);
        var page = Math.max(1, Math.min(params.page || 1, total_pages));
        var data = {
          results: list.slice(20 * (page - 1), 20 * page),
          total_pages: total_pages,
          page: page
        };
        if (data.results.length) oncomplete(data);
        else onerror();
      };

      if (needsKp(st)) loadKp(build);
      else build();
    };
    wrapped.__fav_sort = true;
    Lampa.Api.favorite = wrapped;
  }

  /* ---------- меню ---------- */

  function activeFavorite() {
    var a = Lampa.Activity.active();
    return a && a.component === 'favorite' && a.type && !SKIP_TYPES[a.type] ? a : null;
  }

  function reload(activity, st) {
    var base = activity.fav_sort_title || activity.title || '';
    var suffix = isDefault(st) ? '' : ' • ' + summary(st);
    Lampa.Activity.replace({ page: 1, fav_sort_title: base, title: base + suffix });
  }

  function summary(st) {
    var parts = [];
    if (st.sort !== 'added') parts.push(find(SORTS, st.sort).title.toLowerCase());
    if (st.kind !== 'all') parts.push(find(KINDS, st.kind).title.toLowerCase());
    if (st.genre) parts.push((GENRES[st.genre] || ('жанр ' + st.genre)).toLowerCase());
    if (st.decade !== 'all') parts.push(decadeTitle(st.decade));
    if (st.rating) parts.push('TMDB ★' + st.rating + '+');
    if (st.kprating) parts.push('КП ★' + st.kprating + '+');
    return parts.join(', ');
  }

  function find(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return arr[0];
  }

  function countBy(list, fn) {
    var map = {};
    list.forEach(function (c) {
      var keys = fn(c);
      if (!(keys instanceof Array)) keys = [keys];
      keys.forEach(function (k) { map[k] = (map[k] || 0) + 1; });
    });
    return map;
  }

  function openMenu() {
    var activity = activeFavorite();
    if (!activity) {
      Lampa.Noty.show('Откройте список закладок, например «Позже»');
      return;
    }
    loadKp(function () { showMenu(activity); });
  }

  function showMenu(activity) {
    var type = activity.type;
    var st = getState(type);
    var base = categoryCards(type, activity.filter);
    var found = apply(base, st).length;

    function commit(next) {
      setState(type, next);
      reload(activity, next);
      var n = apply(base, next).length;
      Lampa.Noty.show(n ? 'Показано ' + n + ' из ' + base.length : 'Ничего не найдено — измените фильтры');
    }

    function sub(title, items, key) {
      Lampa.Select.show({
        title: title,
        items: items,
        onSelect: function (item) {
          var next = getState(type);
          next[key] = item.value;
          commit(next);
        }
      });
    }

    var genreCounts = countBy(base, genresOf);
    var decadeCounts = countBy(base, function (c) { return decadeOf(yearOf(c)); });
    var kindCounts = countBy(base, kindOf);

    var items = [
      { title: 'Сортировка', subtitle: find(SORTS, st.sort).title, action: 'sort' },
      { title: 'Тип', subtitle: find(KINDS, st.kind).title, action: 'kind' },
      { title: 'Жанр', subtitle: st.genre ? (GENRES[st.genre] || st.genre) : 'Все жанры', action: 'genre' },
      { title: 'Годы', subtitle: decadeTitle(st.decade), action: 'decade' },
      { title: 'Рейтинг TMDB', subtitle: st.rating ? 'от ' + st.rating : 'Любой', action: 'rating' },
    ];
    if (KP_URL) items.push({ title: 'Рейтинг Кинопоиска', subtitle: !hasKpData() ? 'Нет данных с сервера' : st.kprating ? 'от ' + st.kprating : 'Любой', action: 'kprating' });
    if (!isDefault(st)) items.push({ title: 'Сбросить', subtitle: 'Штатный порядок, без фильтров', action: 'reset' });

    Lampa.Select.show({
      title: (Lampa.Lang.translate('title_' + type) || 'Закладки') + ' — показано ' + found + ' из ' + base.length,
      items: items,
      onSelect: function (item) {
        if (item.action === 'reset') {
          commit(JSON.parse(JSON.stringify(DEFAULT_STATE)));
        } else if (item.action === 'sort') {
          sub('Сортировка', SORTS.filter(function (s) { return KP_URL || s.id !== 'kp'; }).map(function (s) {
            var it = { title: s.title, value: s.id, selected: s.id === st.sort };
            if (s.id === 'kp' && !hasKpData()) it.subtitle = 'Нет данных с сервера — порядок как по TMDB';
            return it;
          }), 'sort');
        } else if (item.action === 'kind') {
          sub('Тип', KINDS.map(function (k) {
            var n = k.id === 'all' ? base.length : (kindCounts[k.id] || 0);
            return { title: k.title, subtitle: n + ' шт.' + (k.descr ? ' · ' + k.descr : ''), value: k.id, selected: k.id === st.kind };
          }), 'kind');
        } else if (item.action === 'genre') {
          var g = Object.keys(genreCounts).map(Number).sort(function (a, b) { return genreCounts[b] - genreCounts[a]; });
          sub('Жанр', [{ title: 'Все жанры', value: 0, selected: !st.genre }].concat(g.map(function (id) {
            return { title: GENRES[id] || ('Жанр ' + id), subtitle: genreCounts[id] + ' шт.', value: id, selected: id === st.genre };
          })), 'genre');
        } else if (item.action === 'decade') {
          var d = Object.keys(decadeCounts).sort(function (a, b) {
            var na = parseInt(a, 10) || (a === 'old' ? 1 : 0), nb = parseInt(b, 10) || (b === 'old' ? 1 : 0);
            return nb - na;
          });
          sub('Годы', [{ title: 'Все годы', value: 'all', selected: st.decade === 'all' }].concat(d.map(function (id) {
            return { title: decadeTitle(id), subtitle: decadeCounts[id] + ' шт.', value: id, selected: id === st.decade };
          })), 'decade');
        } else if (item.action === 'rating') {
          sub('Рейтинг TMDB', RATINGS.map(function (r) {
            var n = r ? base.filter(function (c) { return passesRating(c, r); }).length : base.length;
            return { title: r ? 'от ' + r : 'Любой', subtitle: n + ' шт.', value: r, selected: r === st.rating };
          }), 'rating');
        } else if (item.action === 'kprating') {
          if (!hasKpData()) {
            Lampa.Noty.show('Рейтинги Кинопоиска ещё не собраны на сервере');
            return;
          }
          var withKp = base.filter(function (c) { return !!kpOf(c); }).length;
          sub('Рейтинг Кинопоиска', RATINGS.map(function (r) {
            var n = r ? base.filter(function (c) { return passesKp(c, r); }).length : base.length;
            return { title: r ? 'от ' + r : 'Любой', subtitle: r ? n + ' шт.' : 'рейтинг известен у ' + withKp + ' из ' + base.length, value: r, selected: r === st.kprating };
          }), 'kprating');
        }
      }
    });
  }

  /* ---------- рейтинг Кинопоиска на постерах ---------- */

  function kpBadge(el) {
    if (!el || el.__kpBadge) return;
    var d = el.card_data;
    if (!d || !d.id || !KP.data) return;
    var tv = isTv(d) || (el.classList && el.classList.contains('card--tv'));
    var e = KP.data[(tv ? 'tv:' : 'movie:') + d.id];
    if (!e || !e[0]) return;
    var view = el.querySelector('.card__view');
    if (!view) return;
    el.__kpBadge = true;
    var b = document.createElement('div');
    b.className = 'card__vote card__kp';   // стиль как у штатного рейтинга, но слева
    b.innerHTML = '<span>КП</span>' + (Math.round(e[0] * 10) / 10).toFixed(1);
    view.appendChild(b);
  }

  function kpScan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.classList.contains('card')) kpBadge(root);
    var list = root.querySelectorAll ? root.querySelectorAll('.card') : [];
    for (var i = 0; i < list.length; i++) kpBadge(list[i]);
  }

  function startKpBadges() {
    if (!KP_URL) return;
    $('head').append('<style>' +
      '.card__vote.card__kp{left:.3em;right:auto}' +
      '.card__kp span{color:#ff6a00;font-size:.55em;margin-right:.3em;vertical-align:.2em}' +
      '</style>');
    loadKp(function () { kpScan(document.body); });
    if (!window.MutationObserver) return;
    new MutationObserver(function (muts) {
      if (!KP.data) return;
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) kpScan(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- кнопка в шапке ---------- */

  var ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  var button;

  function updateButton() {
    if (!button) return;
    var on = !!activeFavorite();
    button.toggleClass('hide', !on);
    if (on) {
      var st = getState(Lampa.Activity.active().type);
      button.toggleClass('fav-sort--active', !isDefault(st));
    }
  }

  function start() {
    console.log('fav-sort', VERSION, KP_URL ? 'kp: ' + KP_URL : 'kp: off');
    hookApi();
    startKpBadges();

    $('head').append('<style>.head__action.fav-sort--active{color:#ffd54f}</style>');
    button = Lampa.Head.addIcon(ICON, openMenu);
    button.addClass('fav-sort-button hide');

    Lampa.Listener.follow('activity', function (e) {
      if (e.type === 'start' || e.type === 'archive' || e.type === 'destroy') setTimeout(updateButton, 0);
    });
    updateButton();
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
