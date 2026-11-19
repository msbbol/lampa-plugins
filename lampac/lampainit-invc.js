var lampainit_invc = {};
lampainit_invc.appload = function appload() {};
lampainit_invc.appready = function appready() {
  var retired = [
    /lampame\.github\.io\/main\/nn\.js/,                         // Nightingale -> SeriesNotify
    /anclaver\.github\.io\/Lampa\/plugins\/favoritePlus\.js/    // -> {localhost}/favoritePlus.js (patched copy)
  ];
  try { Lampa.Plugins.get().forEach(function (p) { var url=(p&&p.url)||'';
    for (var i=0;i<retired.length;i++){ if (retired[i].test(url)) { Lampa.Plugins.remove(p); break; } } }); } catch (e) {}
};
lampainit_invc.first_initiale = function firstinitiale() {};
