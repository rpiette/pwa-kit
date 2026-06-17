# Changelog

All notable changes to `@rpiette/pwa-kit` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.20] - 2026-06-17

### Changed

- Backfilled CHANGELOG entries for 0.1.8–0.1.17 from git history.

## [0.1.19] - 2026-06-17

### Added

- `repository` field in `package.json` linking to the GitHub repository so the npm package page shows a source link.

## [0.1.18] - 2026-06-17

### Fixed

- `pwaKit()` now writes `public/version.json` at dev server start, not only during build. Previously, when no production build output existed (e.g. after clearing the build directory), the service worker's `/version.json` fetch fell through to the Vite proxy and failed with a network error. The dev stub uses the stable `"dev"` build id so the SW never sees a version mismatch between restarts.

### Changed

- README: updated Vite plugin description to document that `public/version.json` is emitted in both dev and build modes, and that the SW helper rewrite also happens at dev server start.

## [0.1.17] - 2026-06-16

### Changed

- No recorded source changes — internal republish after 0.1.16 validation.

## [0.1.16] - 2026-06-16

### Fixed

- `pwaKit()` now stabilizes `BUILD_ID` to the sentinel `"dev"` when Vite is in serve mode (and no explicit `buildId` option is passed). Previously a fresh timestamp was used on every dev-server start, causing `__APP_BUILD_ID__` to change on each restart and the auto-update orchestrator to see a version mismatch — triggering the rescue-redirect flow continuously during development.

## [0.1.15] - 2026-06-11

### Changed

- README updated to document `onUpdateReady`, `snoozeDurationMs`, and the full `installPwaAutoUpdate` options table.

## [0.1.14] - 2026-06-11

### Fixed

- Replaced single snooze `setTimeout` with a tracked reference so re-triggering clears the previous timer and prevents duplicate reload calls after snooze expiry.
- `onUpdateReady` errors no longer leave `updatePromptPending` and `autoAcceptOnHide` stuck — both are reset in the catch path.
- Added an `activated-fallback` path that schedules a reload when a new worker has already reached the `"activated"` state before the `statechange` listener fires.
- Guard store is no longer cleared when `__APP_BUILD_ID__` is the default `"----"` sentinel (unset build id), preventing false "already up to date" decisions on unbuilt dev bundles.

## [0.1.13] - 2026-06-11

### Changed

- Updated dependencies to resolve reported security vulnerabilities.
- README updated with latest API surface.

## [0.1.12] - 2026-06-11

### Added

- `onUpdateReady` option on `installPwaAutoUpdate()`. When provided, foreground tabs call this callback with `{ buildId, accept, snooze }` instead of reloading silently, letting the host display a custom prompt. Background tabs continue to reload automatically.
- `snoozeDurationMs` option (default 5 minutes) controls how long to wait before re-prompting after `snooze()` is called.
- `UpdateReadyInfo` interface exported for host TypeScript consumers.

## [0.1.11] - 2026-06-11

### Changed

- `pwaKit()` Vite plugin now auto-generates `public/sw-push.js` at `configResolved` time (both build and serve). Consumers no longer need to manually copy the file from `node_modules`.

## [0.1.10] - 2026-06-11

### Fixed

- `pwaKit()` was not emitting `sw-recovery.html` at build time. Added the `recoveryHtml` plugin option (`{ path, bodyHtml, storagePrefix, ... }`) which generates the file during `configResolved` so it is always present in `public/` for both dev and build.

## [0.1.9] - 2026-06-11

### Fixed

- Recovery page no longer enters an infinite reload loop when the returning URL already contains the hard-refresh query parameter.
- Recovery page HTML and script are now generated programmatically at build time via `buildRecoveryHtml()` rather than being checked in as a static asset, ensuring the recovery logic is always in sync with the installed package version.

## [0.1.8] - 2026-06-11

### Changed

- Published source to GitHub. No functional changes from 0.1.7.

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
