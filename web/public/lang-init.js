/* Pre-paint language: load as a blocking <script src> in <head>, like theme-init.js (CSP-safe, no inline code).
   A share link's ?lang=en|ja wins and is saved under Akari's LangProvider key ("lang"), so the provider's
   first effect reads the same language instead of flipping to a previously saved one; <html lang> is set
   before the first paint either way. src/shared/i18n/i18n.ts initialLocale() applies the same rules. */
(function () {
  try {
    var d = document.documentElement, ok = function (v) { return v === "en" || v === "ja"; };
    var q = new URLSearchParams(location.search).get("lang"), saved = null;
    try { saved = localStorage.getItem("lang"); } catch (e) {}
    if (ok(q)) {
      if (q !== saved) { try { localStorage.setItem("lang", q); } catch (e) {} }
      d.lang = q;
    } else if (ok(saved)) {
      d.lang = saved;
    } else if (navigator.language && navigator.language.indexOf("ja") === 0) {
      d.lang = "ja";
    }
  } catch (e) {}
})();
