# @rpiette/pwa-kit

Framework-agnostic, **headless** PWA management toolkit. The host renders every pixel; this package owns the brains: install-prompt capture, service-worker lifecycle, update nag/snooze, hard reset, and the auto-update orchestrator.

Zero runtime dependencies. ESM + CJS + `.d.ts`. Works with React, Vue, Svelte, vanilla JS — anything that can call a function and read a value.

## Install

```bash
npm install @rpiette/pwa-kit
```

## Quick start

```ts
import { installPwaAutoUpdate } from "@rpiette/pwa-kit";

installPwaAutoUpdate({
  swUrl: "/sw.js",
  versionUrl: "/version.json",
  buildId: __APP_BUILD_ID__,          // injected by the Vite plugin (see below)
  storagePrefix: "myapp:",
  recoveryUrl: "/sw-recovery.html",

  // Foreground tabs: ask before reloading
  snoozeDurationMs: 5 * 60_000,       // re-prompt after 5 minutes (default)
  onUpdateReady: ({ accept, snooze }) => {
    if (confirm("A new version is ready. Reload now?")) {
      accept();   // reloads immediately
    } else {
      snooze();   // waits snoozeDurationMs, then re-prompts
    }
  },
});
```

**Background tabs reload automatically** — `onUpdateReady` is only called when the tab is visible. If the user switches tabs while the prompt is open, the tab reloads silently.

## Vite setup

```ts
import { defineConfig } from "vite";
import { pwaKit } from "@rpiette/pwa-kit/vite";

export default defineConfig({
  plugins: [
    pwaKit({
      swHelperPath: "public/sw-push.js",
    }),
  ],
});
```

The plugin:
1. Defines `__APP_BUILD_ID__` as a global string constant.
2. Emits `/version.json` (`{ buildId, builtAt }`) to `public/` and your `outDir`.
3. Replaces the literal `__SW_BUILD_ID_PLACEHOLDER__` in your SW helper at build time.

Add a global type once:

```ts
// src/global.d.ts
declare const __APP_BUILD_ID__: string;
```

## Service worker integration

Copy the SW helper into your `public/` (one-time):

```bash
cp node_modules/@rpiette/pwa-kit/sw/sw-push.js public/
```

If you're using Workbox (`vite-plugin-pwa`), have the generated `sw.js` import it:

```ts
VitePWA({
  workbox: {
    importScripts: ["sw-push.js"],
  },
})
```

Then copy the recovery page (one-time):

```bash
cp node_modules/@rpiette/pwa-kit/assets/sw-recovery.html public/
```

Or generate a branded copy at build time:

```ts
import { buildRecoveryHtml } from "@rpiette/pwa-kit";
import fs from "node:fs";

fs.writeFileSync(
  "public/sw-recovery.html",
  buildRecoveryHtml({
    appName: "My App",
    background: "#0b0b0b",
    accent: "#00c805",
    storagePrefix: "myapp:",
  }),
);
```

## Push-triggered updates

The auto-update orchestrator polls `/version.json` every ~30 s. For instant delivery, call `forceUpdateProbe()` from whatever push channel your app already has — a WebSocket message, a Server-Sent Event, a Firebase/Supabase listener, a SignalR hub:

```ts
import { installPwaAutoUpdate, forceUpdateProbe } from "@rpiette/pwa-kit";

installPwaAutoUpdate({ /* ... */ });

// call forceUpdateProbe() whenever your push channel signals a new build
myPushChannel.on("new-build", () => forceUpdateProbe());
```

`forceUpdateProbe()` triggers an immediate version-poll + SW probe, so users are notified within seconds of a release rather than up to 30 s later.

## Install prompt

```ts
import { createInstallController } from "@rpiette/pwa-kit";

const install = createInstallController();
install.subscribe(render);
// install.getState() → { canInstall, isIos, isInstalled, hasNativePrompt }
// await install.prompt();
```

## SW status

```ts
import { createSwStatusController } from "@rpiette/pwa-kit";

const sw = createSwStatusController();
sw.subscribe(render);
// sw.getState() → { state, controllingId, newId, hasUpdate }
```

## React glue example

```tsx
import { useSyncExternalStore, useMemo } from "react";
import { createSwStatusController, createInstallController } from "@rpiette/pwa-kit";

export function useSwStatus() {
  const ctl = useMemo(() => createSwStatusController(), []);
  return useSyncExternalStore(ctl.subscribe, ctl.getState, ctl.getState);
}

export function useInstall() {
  const ctl = useMemo(() => createInstallController(), []);
  const state = useSyncExternalStore(ctl.subscribe, ctl.getState, ctl.getState);
  return { ...state, prompt: ctl.prompt };
}
```

## Optional remote version handshake

For projects with both a frontend bundle and a backend that can drift (edge functions, API), `checkAppVersion` performs a one-shot comparison:

```ts
import { checkAppVersion } from "@rpiette/pwa-kit";

const status = await checkAppVersion({
  url: "https://api.example.com/version",
  headers: { apikey: PUBLIC_API_KEY },
});
// status → "fresh" | "stale" | "unknown"
```

The endpoint should return JSON with a string id under `functionsBuildId` or `buildId`. Pass `extractBuildId` to use a different shape.

## API reference

### Auto-update

#### `installPwaAutoUpdate(opts)`

Boot once at app startup. All options except `swUrl` are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `swUrl` | `string` | — | Path to your service worker |
| `versionUrl` | `string` | `"/version.json"` | Polled every ~30 s for a new `buildId` |
| `buildId` | `string` | — | Current build id (skip check if already up to date) |
| `storagePrefix` | `string` | `""` | Prefix for `localStorage`/`sessionStorage` keys |
| `recoveryUrl` | `string` | `"/sw-recovery.html"` | Shown when a SW update stalls |
| `onUpdateReady` | `(info: UpdateReadyInfo) => void` | — | Called when an update is ready **and the tab is visible**. Omit to always reload silently. |
| `snoozeDurationMs` | `number` | `300000` (5 min) | How long to wait before re-prompting after `snooze()` |
| `onUpdating` | `(newBuildId: string \| null) => void` | — | Called when the new SW starts activating |

#### `UpdateReadyInfo`

```ts
interface UpdateReadyInfo {
  buildId: string | null;  // incoming build id
  accept: () => void;      // reload immediately
  snooze: () => void;      // wait snoozeDurationMs, then re-prompt
}
```

`accept()` and `snooze()` are safe to call multiple times — only the first call has effect. If the user switches tabs while the prompt is open, the tab reloads automatically without waiting for a response.

#### `forceUpdateProbe()`

Trigger an immediate version-poll + SW probe. Use with a push channel for instant update delivery (see above).

#### `isRemoteNewer(remote, current)`

Strict numeric build-id comparison. Returns `true` if `remote` is a higher integer than `current`.

### Install
- `createInstallController()` → `{ getState, subscribe, prompt, destroy }`.

### SW status
- `createSwStatusController(opts?)` → `{ getState, subscribe, destroy }`.
- `getCurrentBuildId()`, `getRemoteBuildId()`, `getUpdateStalled()`, `getUpdateRefreshing()`, `getFunctionsBuildNewer()`.

### Update nag store

These are used internally by `installPwaAutoUpdate` when `onUpdateReady` is set. Export them if you need to build a custom update UI that reads snooze state.

- `snoozeFor(ms, buildId)` — snooze updates for a given duration.
- `clearSnooze()` — clear any active snooze.
- `isSnoozed(buildId)` — returns `true` if the given build id is currently snoozed.
- `subscribeSnooze(fn)`, `getSnooze()` — reactive snooze state.

### Hard reset
- `runHardReset(targetBuildId?)` — navigate to the recovery page (clears caches + re-registers SW).

### Version check
- `checkAppVersion(opts)` — optional remote handshake.

### Recovery
- `buildRecoveryHtml(opts?)` — generate a branded recovery page.

### Scheduling primitives (advanced)
- `computeNextDelay`, `computeSwProbeDelay`, `getConnectionPenalty`, `canReloadFor`, `canHardRefreshFor`, `buildHardRefreshUrl`, `stripHardRefreshParam`, `buildSwRecoveryUrl`, `createTimerManager`.

## License

MIT
