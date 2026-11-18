/*
 * card-size.js — размер карточек и масштаб интерфейса для Lampa (3.x)
 * Версия: 1.0.0
 * https://github.com/msbbol/lampa-plugins · Лицензия MIT
 *
 * Lampa масштабирует интерфейс по ширине окна, поэтому на больших мониторах (4K, 27–32")
 * карточки получаются огромными, а в сетке закладок/категорий всегда 6 колонок.
 * Плагин добавляет в «Настройки → Интерфейс» два пункта:
 *   - «Размер карточек» — сколько карточек в ряду сетки (6–12); карточки в лентах
 *     на главной уменьшаются в той же пропорции;
 *   - «Масштаб интерфейса» — общий масштаб (шапка, меню, тексты), 50–100 %.
 * Настройки хранятся на устройстве: на ПК и на телевизоре можно выставить по-разному.
 * На экранах уже 768px (телефоны) размер карточек не меняется.
 *
 * ES5 — чтобы работало на старых Tizen/webOS.
 */
(function () {
  'use strict';

  if (window.card_size_plugin) return;
  window.card_size_plugin = true;

  var VERSION = '1.0.0';
  var CARD_KEY = 'card_size_cols';
  var UI_KEY = 'card_size_ui';
  var BASE_COLS = 6;          // штатная сетка Lampa
  var STYLE_ID = 'card-size-style';

  var CARD_VALUES = {
    '6': '6 в ряд (стандарт)',
    '7': '7 в ряд',
    '8': '8 в ряд',
    '9': '9 в ряд',
    '10': '10 в ряд',
    '12': '12 в ряд'
  };
  var UI_VALUES = {
    '100': '100 % (стандарт)',
    '90': '90 %',
    '80': '80 %',
    '70': '70 %',
    '60': '60 %',
    '50': '50 %'
  };

  function num(key, def, allowed) {
    var v = String(Lampa.Storage.get(key, def));
    return allowed[v] ? parseInt(v, 10) : parseInt(def, 10);
  }

  function buildCss() {
    var cols = num(CARD_KEY, '6', CARD_VALUES);
    var ui = num(UI_KEY, '100', UI_VALUES) / 100;
    var css = '';

    // Общий масштаб: та же формула, что у Lampa (ширина окна / 84.17), с нашим множителем
    if (ui !== 1) {
      css += 'body{font-size:' + Math.max(window.innerWidth / 84.17 * ui, 10.6).toFixed(2) + 'px !important}';
    }

    if (cols !== BASE_COLS) {
      var k = BASE_COLS / cols;   // во сколько раз уменьшаем карточку
      css += '@media screen and (min-width:768px){';
      // Карточка целиком в em: ширина в лентах (12.75em), подписи, значки — всё уменьшится вместе
      css += 'body .card{font-size:' + k.toFixed(4) + 'em}';
      css += 'body.size--bigger .card{font-size:' + (1.14 * k).toFixed(4) + 'em}';
      // Сетки: cols--N → пропорционально больше колонок
      for (var n = 3; n <= 8; n++) {
        var c = Math.max(n, Math.round(n / k));
        css += '.mapping--grid.cols--' + n + '>*{width:' + (100 / c).toFixed(4) + '%}';
      }
      css += '}';
    }
    return css;
  }

  function apply() {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = buildCss();
  }

  function relayout() {
    apply();
    // Lampa пересчитывает прокрутку и навигацию по событию resize
    try { window.dispatchEvent(new Event('resize')); } catch (e) {
      var ev = document.createEvent('Event');
      ev.initEvent('resize', true, true);
      window.dispatchEvent(ev);
    }
  }

  function addSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;

    Lampa.SettingsApi.addParam({
      component: 'interface',
      param: { name: CARD_KEY, type: 'select', values: CARD_VALUES, default: '6' },
      field: {
        name: 'Размер карточек',
        description: 'Сколько карточек в ряду; ленты на главной уменьшаются так же. Только для этого устройства'
      },
      onChange: relayout
    });

    Lampa.SettingsApi.addParam({
      component: 'interface',
      param: { name: UI_KEY, type: 'select', values: UI_VALUES, default: '100' },
      field: {
        name: 'Масштаб интерфейса',
        description: 'Общий размер шапки, меню и текста. Только для этого устройства'
      },
      onChange: relayout
    });
  }

  function start() {
    console.log('card-size', VERSION);
    apply();
    addSettings();

    // Масштаб зависит от ширины окна — пересчитываем при изменении размера
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(apply, 100);
    });

    // Лента на главной рисует карточки порциями (по 7) и догружает при перемещении.
    // С уменьшенными карточками справа оставалось пустое место — увеличиваем порцию
    // пропорционально размеру карточек и сразу догружаем первую.
    Lampa.Listener.follow('line', function (e) {
      if (e.type !== 'create' || !e.line || typeof e.line.emit !== 'function') return;
      var cols = num(CARD_KEY, '6', CARD_VALUES);
      if (cols === BASE_COLS) return;
      var line = e.line;
      if (typeof line.view === 'number' && line.view > 0) line.view = Math.ceil(line.view * cols / BASE_COLS);
      setTimeout(function () {
        try { line.emit('scroll'); } catch (err) { /* не критично */ }
      }, 0);
    });

    // Значение могли поменять и не через наши пункты (синхронизация, другой плагин)
    Lampa.Storage.listener.follow('change', function (e) {
      if (e.name === CARD_KEY || e.name === UI_KEY || e.name === 'interface_size') setTimeout(apply, 0);
    });
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
