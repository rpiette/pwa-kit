# @rpiette/pwa-kit

Framework-agnostic, **headless** PWA management toolkit. The host renders every pixel; this package owns the brains: install-prompt capture, service-worker lifecycle, update nag/snooze, hard reset, and the auto-update orchestrator.

Zero runtime dependencies. ESM + CJS + `.d.ts`. Works with React, Vue, Svelte, vanilla JS — anything that can call a function and read a value.

## Install

```bash
npm install @rpiette/pwa-kit
```

## Quick start

```ts
import {
  installPwaAutoUpdate,
  createInstallController,
  createSwStatusController,
  runHardReset,
  snoozeFor,
  isSnoozed,
} from "@rpiette/pwa-kit";

// 1) Boot the orchestrator once at app startup
installPwaAutoUpdate({
  swUrl: "/sw.js",
  versionUrl: "/version.json",
  buildId: __APP_BUILD_ID__,            // injected by the Vite plugin
  storagePrefix: "myapp:",
  recoveryUrl: "/sw-recovery.html",
  onUpdating: (newBuildId) => {
    // optional — show your own "Updating to latest version…" toast
  },
});

// 2) Install button
const install = createInstallController();
install.subscribe(render);
// install.getState() → { canInstall, isIos, isInstalled, hasNativePrompt }
// await install.prompt();

// 3) SW status chip + update button
const sw = createSwStatusController();
sw.subscribe(render);
// sw.getState() → { state, controllingId, newId, hasUpdate }

// 4) Update actions
await runHardReset(sw.getState().newId || undefined);
snoozeFor(5 * 60 * 1000, sw.getState().newId);
```

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
- `installPwaAutoUpdate(opts)` — boot once.
- `forceUpdateProbe()` — trigger an immediate version-poll + SW probe.
- `isRemoteNewer(remote, current)` — strict numeric comparison.

### Install
- `createInstallController()` → `{ getState, subscribe, prompt, destroy }`.

### SW status
- `createSwStatusController(opts?)` → `{ getState, subscribe, destroy }`.
- `getCurrentBuildId()`, `getRemoteBuildId()`, `getUpdateStalled()`, `getUpdateRefreshing()`, `getFunctionsBuildNewer()`.

### Update nag
- `snoozeFor(ms, buildId)`, `clearSnooze()`, `isSnoozed(currentNewBuildId)`, `subscribeSnooze(fn)`, `getSnooze()`.

### Hard reset
- `runHardReset(targetBuildId?)` — navigate to the recovery page.

### Version check
- `checkAppVersion(opts)` — optional remote handshake.

### Recovery
- `buildRecoveryHtml(opts?)` — generate a branded recovery page.

### Scheduling primitives (advanced)
- `computeNextDelay`, `computeSwProbeDelay`, `getConnectionPenalty`, `canReloadFor`, `canHardRefreshFor`, `buildHardRefreshUrl`, `stripHardRefreshParam`, `buildSwRecoveryUrl`, `createTimerManager`.

## License

MIT
