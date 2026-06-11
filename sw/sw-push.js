// @rpiette/pwa-kit — SW helper.
//
// Copy this file into your `public/` directory (or `importScripts()` it
// from your generated SW), then add the `pwaKit()` Vite plugin so the
// build-id placeholder below is replaced at build time.
//
// What it does:
//   • Exposes the SW's build id via the `GET_BUILD_ID` MessagePort
//     protocol so the page can distinguish "same-build reinstall" from
//     "real takeover candidate".
//   • Responds to SKIP_WAITING postMessages so the page can deterministically
//     activate a freshly-installed worker.
//   • Tracks per-client build ids (CLIENT_BUILD_ID) so the activate-time
//     rescue navigation skips tabs that already reloaded themselves via
//     `controllerchange`.
//   • Bypasses caches for `/version.json` — critical for update detection.
//
// IMPORTANT: the property NAME `__PWAKIT_SW_BUILD_ID__` is stable and is
// NOT touched by the Vite plugin. Only the literal placeholder string
// (`__SW_BUILD_ID_PLACEHOLDER__`) is replaced — keep both tokens distinct.

self.__PWAKIT_SW_BUILD_ID__ = "__SW_BUILD_ID_PLACEHOLDER__";
self.__PWAKIT_CLIENT_BUILDS__ = self.__PWAKIT_CLIENT_BUILDS__ || new Map();

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "GET_BUILD_ID") {
    const port = event.ports && event.ports[0];
    if (port) {
      try {
        port.postMessage({ buildId: self.__PWAKIT_SW_BUILD_ID__ || null });
      } catch { /* port closed — caller will time out */ }
    }
    return;
  }
  if (data.type === "CLIENT_BUILD_ID") {
    const id = event.source && event.source.id;
    const buildId = typeof data.buildId === "string" ? data.buildId : null;
    if (id && buildId) {
      try { self.__PWAKIT_CLIENT_BUILDS__.set(id, buildId); } catch { /* noop */ }
    }
  }
});

// Last-resort update rescue. Delayed so healthy tabs that reloaded via
// `controllerchange` are no longer in clients.matchAll() by the time
// the rescue runs.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch { /* claim can fail during shutdown */ }
  })());

  const RESCUE_DELAY_MS = 6000;
  setTimeout(() => {
    (async () => {
      try {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
        const myBuildId = self.__PWAKIT_SW_BUILD_ID__;
        await Promise.all(clients.map(async (client) => {
          try {
            const url = new URL(client.url);
            if (url.origin !== self.location.origin) return;
            if (url.pathname === "/sw-recovery.html") return;
            if (url.searchParams.get("pwakit_sw_rescue") === myBuildId) return;
            const clientBuildId = self.__PWAKIT_CLIENT_BUILDS__.get(client.id);
            if (myBuildId && clientBuildId && clientBuildId === myBuildId) return;
            url.searchParams.set("pwakit_update", myBuildId || Date.now().toString());
            url.searchParams.set("pwakit_sw_rescue", myBuildId || "1");
            await client.navigate(url.toString());
          } catch { /* individual client failed — keep rescuing others */ }
        }));
      } catch { /* no clients or navigation unavailable */ }
    })();
  }, RESCUE_DELAY_MS);
});

// Bypass caches for the version endpoint. Even with Workbox NetworkOnly,
// stale responses have been observed during SW takeover; this hard short-
// circuit prevents that class of bug. Adjust the pathname if your host
// uses a non-default versionUrl.
self.addEventListener("fetch", (event) => {
  try {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin && url.pathname === "/version.json") {
      event.respondWith(fetch(url.pathname + url.search, {
        cache: "no-store",
        credentials: "omit",
      }));
    }
  } catch { /* fall through to default handling */ }
});
