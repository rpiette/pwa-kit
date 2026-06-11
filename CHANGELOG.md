# Changelog

All notable changes to `@rpiette/pwa-kit` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] - 2026-06-11

### Fixed

- `createInstallController()` now persists install state to `localStorage` (namespaced via `storagePrefix`) on `appinstalled` / accepted prompt, and probes `navigator.getInstalledRelatedApps()` at construction. Without this, a regular browser tab opened after install reported `isInstalled=false` because `display-mode` is `browser` and `beforeinstallprompt` no longer fires — surfacing "Install unavailable" in host UIs even though the PWA was already installed.

## [0.1.6] - 2026-06-11

### Fixed

- `pwaKit()` now re-stamps the service-worker helper even after a previous build replaced the original placeholder with a numeric build id. This prevents generated workers from shipping a stale SW build id and causing recovery/update loops after repeated builds.

## [0.1.5] - 2026-06-11

### Fixed

- Republished tarball with the actual 0.1.4 fix compiled into `dist/`. The 0.1.4 tarball shipped a stale `dist/` that still contained the pre-fix code, so the recovery-loop bug was not actually resolved. No source changes vs 0.1.4.

## [0.1.4] - 2026-06-11

### Fixed

- `installPwaAutoUpdate()` now actually reads the compile-time `__APP_BUILD_ID__` constant injected by the `pwaKit()` vite plugin when the caller doesn't pass an explicit `buildId`. Previously the runtime config silently stuck at the `"----"` default, so the orchestrator could never tell the running bundle was current — production sites ended up looping between `/sw-recovery.html` and the original page (`?pwakit_recovery=1`). Callers that already passed `buildId` are unaffected.

## [0.1.3] - 2026-06-11

### Fixed

- Republished tarball so `dist/index.mjs` and `dist/vite.mjs` are actually included. 0.1.2 shipped `.js` files from a stale build, which broke the ESM `exports` map and caused `ERR_MODULE_NOT_FOUND` for consumers.

## [0.1.2] - 2026-06-11

### Fixed

- Removed all brand-specific references from source code and README to keep the toolkit fully framework-agnostic.

## [0.1.1] - 2026-06-11

### Fixed

- ESM build now emits `.mjs` files so the file extensions match the `exports` map in `package.json` (was `.js`). Without this, Node could not resolve the ESM entry under the published `"./dist/index.mjs"` path and consumers got `ERR_MODULE_NOT_FOUND`.

## [0.1.0] - 2025-06-11

### Added

- Initial release of `@rpiette/pwa-kit`.
- Framework-agnostic, headless PWA management toolkit.
- Service-worker lifecycle management and auto-update orchestration.
- Install-prompt capture with `createInstallController`.
- Update nag/snooze system with `snoozeFor`, `isSnoozed`, and `clearSnooze`.
- Hard-reset utility (`runHardReset`) for recovering from broken deployments.
- Vite plugin (`pwaKit`) that injects `__APP_BUILD_ID__`, emits `/version.json`, and replaces SW build placeholders.
- Optional remote version handshake via `checkAppVersion`.
- Recovery page builder (`buildRecoveryHtml`) for branded offline/recovery experiences.
- ESM, CJS, and TypeScript declaration outputs.
- Zero runtime dependencies.
