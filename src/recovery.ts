/**
 * Recovery-page HTML generator. Hosts can either:
 *   • Copy `assets/sw-recovery.html` into their `public/` and hand-edit
 *     branding, or
 *   • Generate a branded copy at build time with `buildRecoveryHtml(...)`.
 *
 * The output is a fully self-contained document that:
 *   1) Unregisters every SW with a 1.5s per-call timeout.
 *   2) Deletes every Cache Storage entry.
 *   3) Clears the kit's reload/hard-refresh/nuke guards.
 *   4) Navigates back to the original URL with a cache-busting marker.
 *
 * Phase timeouts (2.5s) + a top-level 7s safety-net ensure the tab
 * never becomes unresponsive even when the controlling SW is wedged.
 */

export interface RecoveryHtmlOptions {
  /** Display name in the heading. Default: "the app". */
  appName?: string;
  /** Background color. Default: "#0b0b0b". */
  background?: string;
  /** Text color. Default: "#fafafa". */
  foreground?: string;
  /** Progress-bar accent color. Default: "#3b82f6". */
  accent?: string;
  /** Storage prefix the kit uses. Default: "pwakit:". */
  storagePrefix?: string;
  /** Path of THIS recovery document. Default: "/sw-recovery.html". */
  selfPath?: string;
  /** Query parameter the kit stamps on the URL. Default: "pwakit_update". */
  hardRefreshParam?: string;
}

export function buildRecoveryHtml(opts: RecoveryHtmlOptions = {}): string {
  const appName = opts.appName ?? "the app";
  const background = opts.background ?? "#0b0b0b";
  const foreground = opts.foreground ?? "#fafafa";
  const accent = opts.accent ?? "#3b82f6";
  const storagePrefix = opts.storagePrefix ?? "pwakit:";
  const selfPath = opts.selfPath ?? "/sw-recovery.html";
  const hardRefreshParam = opts.hardRefreshParam ?? "pwakit_update";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <meta name="robots" content="noindex" />
    <title>Updating ${escapeHtml(appName)}</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${background}; color: ${foreground}; }
      main { width: min(28rem, calc(100vw - 2rem)); text-align: center; }
      h1 { margin: 0 0 .75rem; font-size: clamp(1.75rem, 6vw, 2.75rem); line-height: 1; }
      p { margin: 0; opacity: .72; }
      .bar { height: .35rem; margin-top: 1.5rem; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,.12); }
      .bar::before { content: ""; display: block; width: 45%; height: 100%; border-radius: inherit; background: ${accent}; animation: load 1.1s ease-in-out infinite alternate; }
      @keyframes load { from { transform: translateX(0); } to { transform: translateX(125%); } }
    </style>
  </head>
  <body>
    <main aria-live="polite">
      <h1>Updating ${escapeHtml(appName)}</h1>
      <p>Clearing the old version and loading the latest one.</p>
      <div class="bar" aria-hidden="true"></div>
    </main>
    <script>
      ${recoveryScript({ storagePrefix, selfPath, hardRefreshParam })}
    </script>
  </body>
</html>
`;
}

function recoveryScript(opts: { storagePrefix: string; selfPath: string; hardRefreshParam: string }): string {
  return `(function () {
  var STORAGE_PREFIX = ${JSON.stringify(opts.storagePrefix)};
  var SELF_PATH = ${JSON.stringify(opts.selfPath)};
  var HARD_REFRESH_PARAM = ${JSON.stringify(opts.hardRefreshParam)};

  var params = new URLSearchParams(location.search);
  var target = params.get("target") || "";
  var fallbackReturn = "/";
  var requestedReturn = params.get("return") || fallbackReturn;
  var returnPath = fallbackReturn;
  try {
    var parsed = new URL(requestedReturn, location.origin);
    if (parsed.origin === location.origin && parsed.pathname !== SELF_PATH) {
      returnPath = parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (_) {}

  var navigated = false;
  function goNext() {
    if (navigated) return;
    navigated = true;
    try {
      var next = new URL(returnPath, location.origin);
      if (target) next.searchParams.set(HARD_REFRESH_PARAM, target);
      next.searchParams.set("pwakit_force", Date.now().toString());
      next.searchParams.set("pwakit_recovery", "1");
      location.replace(next.toString());
    } catch (_) { location.replace("/?pwakit_force=" + Date.now()); }
  }
  setTimeout(goNext, 7000);

  function withTimeout(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).catch(function () { return "error"; }),
      new Promise(function (resolve) { setTimeout(function () { resolve("timeout"); }, ms); }),
    ]);
  }
  function unregisterAll() {
    if (!("serviceWorker" in navigator)) return Promise.resolve();
    return withTimeout(
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (reg) {
          return withTimeout(reg.unregister().catch(function () { return false; }), 1500);
        }));
      }), 2500);
  }
  function purgeCaches() {
    if (typeof caches === "undefined") return Promise.resolve();
    return withTimeout(
      caches.keys().then(function (names) {
        return Promise.all(names.map(function (name) {
          return withTimeout(caches.delete(name).catch(function () { return false; }), 1500);
        }));
      }), 2500);
  }
  function clearGuards() {
    try {
      sessionStorage.removeItem(STORAGE_PREFIX + "hard-refresh-attempted");
      sessionStorage.removeItem(STORAGE_PREFIX + "update-reload-guard");
      sessionStorage.removeItem(STORAGE_PREFIX + "nuke-attempt");
      sessionStorage.removeItem(STORAGE_PREFIX + "sw-recovery-attempted");
    } catch (_) {}
  }
  unregisterAll().then(purgeCaches).then(clearGuards).then(goNext, goNext);
})();`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] as string);
}
