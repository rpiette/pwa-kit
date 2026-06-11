/**
 * PWA auto-update orchestrator (headless).
 *
 * Two-signal flow:
 *   • Signal 1 — /version.json polled adaptively. Remote `buildId`
 *     differs from the bundle's compile-time id ⇒ a new deploy exists.
 *   • Signal 2 — service-worker lifecycle (updatefound / statechange /
 *     controllerchange). Drives takeover and the single reload.
 *
 * Hard rule: Signal 1 alone NEVER triggers a reload — that would just
 * reboot the old bundle (the SW still controls the page). We reload
 * only in response to a concrete SW lifecycle event, or a peer-tab
 * broadcast that has been re-validated.
 *
 * Public entry: `installPwaAutoUpdate(opts)`. Call once at app boot.
 * Idempotent only in the trivial sense — calling twice registers the
 * SW twice and is unsupported. Skip in iframe/preview contexts via
 * `opts.shouldSkip`.
 */
import { getConfig, k, KEYS, setGlobalConfig, HARD_REFRESH_PARAM } from "./config";
import {
  buildSwRecoveryUrl,
  canReloadFor,
  computeNextDelay,
  computeSwProbeDelay,
  createTimerManager,
  getConnectionPenalty,
  JITTER_MS,
  stripHardRefreshParam,
  type NetworkInfoLike,
  type ReloadGuard,
  type ReloadGuardStore,
} from "./update-scheduling";
import {
  setRemoteBuildId,
  setUpdateRefreshing,
  setUpdateStalled,
  getCurrentBuildId,
} from "./sw-status";
import { runHardReset } from "./hard-reset";

// Injected by the `pwaKit()` vite plugin via `config.define`. Guarded
// at call sites with `typeof` so the package remains importable in
// environments that do not run through the plugin (tests, SSR probes).
declare const __APP_BUILD_ID__: string | undefined;

const UPDATE_CHANNEL_NAME = "pwakit:update";
const UPDATE_APPLIED_TYPE = "pwakit:update-applied";
const ACTIVATED_RELOAD_DELAY_MS = 2_000;
const ONLINE_GRACE_MS = 2_000;
const BROADCAST_DEBOUNCE_MS = 3_000;
const SW_PROBE_FAILURE_THRESHOLD = 5;
const SW_FAST_RETRY_OFFSETS_MS = [1_000, 3_000, 7_000];
const WAKE_THROTTLE_MS = 5_000;
const STALLED_RECOVERY_THRESHOLD_MS = 20_000;
const STALLED_RECOVERY_INTERVAL_MS = 30_000;
const ACTIVATION_WATCHDOG_MS = 4_000;

export interface InstallPwaAutoUpdateOptions {
  /** Path to the registered service worker. Default: `${BASE_URL}sw.js`. */
  swUrl?: string;
  /** Path to the JSON build-id endpoint. Default: "/version.json". */
  versionUrl?: string;
  /** Build id baked into the running bundle. Defaults to `__APP_BUILD_ID__`. */
  buildId?: string;
  /** Storage prefix. Default: "pwakit:". */
  storagePrefix?: string;
  /** Recovery page URL. Default: "/sw-recovery.html". */
  recoveryUrl?: string;
  /** Skip wiring entirely when true. Use for preview/iframe contexts. */
  shouldSkip?: () => boolean;
  /**
   * Optional gate — when it returns true, the "Updating to latest…"
   * side effects (toast hook, SKIP_WAITING) are suppressed. Lets hosts
   * defer updates on sensitive routes (e.g. checkout, /tip/).
   */
  shouldSuppressUpdates?: () => boolean;
  /** Called once per pending build id when a real update starts applying. */
  onUpdating?: (buildId: string) => void;
  /** Optional console label. Default: "pwakit:sw". */
  logLabel?: string;
}

export function isRemoteNewer(remote: string, current: string): boolean {
  if (!remote || !current) return false;
  if (remote === current) return false;
  const r = Number(remote);
  const c = Number(current);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return false;
  return r > c;
}

let activeProbe: (() => void) | null = null;

/** Trigger an immediate version-poll + SW probe burst. Safe no-op when uninstalled. */
export function forceUpdateProbe(): void {
  try { activeProbe?.(); } catch { /* noop */ }
}

export function installPwaAutoUpdate(opts: InstallPwaAutoUpdateOptions = {}): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (opts.shouldSkip?.()) return;

  // Resolve the build id from (in order): caller-provided opts → the
  // compile-time constant defined by `pwaKit()` → undefined. Without
  // this fallback the runtime config sticks at "----" and the orchestrator
  // can't tell the bundle is current, producing an sw-recovery loop.
  const resolvedBuildId =
    opts.buildId ??
    (typeof __APP_BUILD_ID__ !== "undefined" ? __APP_BUILD_ID__ : undefined);

  setGlobalConfig({
    storagePrefix: opts.storagePrefix,
    buildId: resolvedBuildId,
    recoveryUrl: opts.recoveryUrl,
  });

  const versionUrl = opts.versionUrl ?? "/version.json";
  const baseUrl = (typeof document !== "undefined" && (document as any).baseURI)
    ? new URL(".", (document as any).baseURI).pathname
    : "/";
  const swUrl = opts.swUrl ?? `${baseUrl}sw.js`;
  const logLabel = opts.logLabel ?? "pwakit:sw";

  const CURRENT_BUILD_ID = getCurrentBuildId();
  let reloading = false;
  let lastNotifiedBuildId: string | null = null;
  let updateInitiated = false;

  const log = (msg: string, extra?: Record<string, unknown>) => {
    try {
      if (extra) console.info(`[${logLabel}] ${msg}`, extra);
      else console.info(`[${logLabel}] ${msg}`);
    } catch { /* noop */ }
  };

  const guardStore: ReloadGuardStore = {
    read(): ReloadGuard | null {
      try {
        const raw = sessionStorage.getItem(k(KEYS.reloadGuard));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ReloadGuard;
        if (!parsed || typeof parsed.buildId !== "string"
          || typeof parsed.count !== "number" || typeof parsed.firstAt !== "number") {
          return null;
        }
        return parsed;
      } catch { return null; }
    },
    write(g) { try { sessionStorage.setItem(k(KEYS.reloadGuard), JSON.stringify(g)); } catch { /* noop */ } },
    clear() { try { sessionStorage.removeItem(k(KEYS.reloadGuard)); } catch { /* noop */ } },
  };

  const readLastApplied = (): string | null => {
    try { return localStorage.getItem(k(KEYS.lastApplied)); } catch { return null; }
  };
  const writeLastApplied = (id: string) => {
    try { localStorage.setItem(k(KEYS.lastApplied), id); } catch { /* noop */ }
  };

  // Clear stale reload guard on boot.
  {
    const existing = guardStore.read();
    const lastApplied = readLastApplied();
    const isNewlyApplied = lastApplied !== CURRENT_BUILD_ID;
    if (existing && (existing.buildId === CURRENT_BUILD_ID || isNewlyApplied)) guardStore.clear();
    if (isNewlyApplied && CURRENT_BUILD_ID && CURRENT_BUILD_ID !== "----") writeLastApplied(CURRENT_BUILD_ID);
  }

  // Inspect URL for prior hard-refresh attempt.
  let bootHardRefreshOutcome: "success" | "failed" | "none" = "none";
  let bootHardRefreshTarget: string | null = null;
  {
    let bootUrl: URL | null = null;
    try { bootUrl = new URL(window.location.href); } catch { bootUrl = null; }
    const markerValue = bootUrl?.searchParams.get(HARD_REFRESH_PARAM) ?? null;
    if (markerValue) {
      bootHardRefreshTarget = markerValue;
      if (markerValue === CURRENT_BUILD_ID) {
        bootHardRefreshOutcome = "success";
        try {
          const cleaned = stripHardRefreshParam(window.location.href);
          if (cleaned !== window.location.href) {
            window.history.replaceState(window.history.state, "", cleaned);
          }
        } catch { /* noop */ }
      } else {
        bootHardRefreshOutcome = "failed";
      }
    }
  }

  const targetBuildIdForGuard = (): string => {
    try {
      const stored = sessionStorage.getItem(k(KEYS.lastRemote));
      if (stored) return stored;
    } catch { /* noop */ }
    return CURRENT_BUILD_ID;
  };

  const reloadGuardCheck = (target: string): boolean => {
    const result = canReloadFor(target, Date.now(), guardStore);
    if (!result.allowed && result.reason) {
      console.warn(`[${logLabel}] update reload skipped for build ${target}: ${result.reason}.`);
    }
    return result.allowed;
  };

  const triggerSwRecovery = (target: string | undefined, source: string): boolean => {
    if (reloading) return false;
    const keyTarget = target || "unknown";
    try {
      const existing = sessionStorage.getItem(k(KEYS.recoveryAttempt));
      if (existing === keyTarget) {
        log("SW recovery skipped: already attempted", { target: keyTarget, source });
        return false;
      }
      sessionStorage.setItem(k(KEYS.recoveryAttempt), keyTarget);
    } catch { /* noop */ }
    log("routing to standalone SW recovery", { target: keyTarget, source });
    reloading = true;
    setUpdateRefreshing(true);
    try {
      window.location.replace(buildSwRecoveryUrl(window.location.href, target));
    } catch {
      window.location.assign(`${getConfig().recoveryUrl}${target ? `?target=${encodeURIComponent(target)}` : ""}`);
    }
    return true;
  };

  const triggerReload = (o?: { bypassGuard?: boolean; source?: string }) => {
    if (reloading) return;
    const target = targetBuildIdForGuard();
    if (o?.bypassGuard) {
      try { guardStore.clear(); } catch { /* noop */ }
    } else if (!reloadGuardCheck(target)) {
      return;
    }
    log("triggering reload", { source: o?.source ?? "unknown", target });
    reloading = true;
    window.location.reload();
  };

  const notifyUpdatingFor = (targetBuildId: string) => {
    if (lastNotifiedBuildId === targetBuildId) return;
    if (opts.shouldSuppressUpdates?.()) return;
    lastNotifiedBuildId = targetBuildId;
    try { opts.onUpdating?.(targetBuildId); } catch { /* noop */ }
  };

  log("registering service worker", { swUrl, currentBuildId: CURRENT_BUILD_ID });

  const announceBuildIdToController = (reason: string) => {
    try {
      const controller = navigator.serviceWorker.controller;
      if (!controller) return;
      if (!CURRENT_BUILD_ID || CURRENT_BUILD_ID === "----") return;
      controller.postMessage({ type: "CLIENT_BUILD_ID", buildId: CURRENT_BUILD_ID });
      log("announced build id to controller", { reason, buildId: CURRENT_BUILD_ID });
    } catch { /* noop */ }
  };
  announceBuildIdToController("boot");
  window.setTimeout(() => announceBuildIdToController("boot+500ms"), 500);

  navigator.serviceWorker
    .register(swUrl, { updateViaCache: "none" })
    .then((registration) => {
      log("registration ready", {
        hasInstalling: !!registration.installing,
        hasWaiting: !!registration.waiting,
        hasActive: !!registration.active,
      });
      const wiredWorkers = new WeakSet<ServiceWorker>();
      const skipWaitingPosted = new WeakSet<ServiceWorker>();
      const newerBuildWorkers = new WeakSet<ServiceWorker>();

      const queryWorkerBuildId = (worker: ServiceWorker): Promise<string | null> => {
        return new Promise((resolve) => {
          let settled = false;
          const finish = (value: string | null) => { if (settled) return; settled = true; resolve(value); };
          let channel: MessageChannel;
          try { channel = new MessageChannel(); } catch { finish(null); return; }
          const timer = window.setTimeout(() => {
            try { channel.port1.close(); } catch { /* noop */ }
            finish(null);
          }, 1500);
          channel.port1.onmessage = (event) => {
            window.clearTimeout(timer);
            const data = event.data as { buildId?: string | null } | null;
            const id = data && typeof data.buildId === "string" ? data.buildId : null;
            if (!id || id === "__SW_BUILD_ID__" || id === "__SW_BUILD_ID_PLACEHOLDER__") finish(null);
            else finish(id);
            try { channel.port1.close(); } catch { /* noop */ }
          };
          try {
            worker.postMessage({ type: "GET_BUILD_ID" }, [channel.port2]);
          } catch {
            window.clearTimeout(timer);
            finish(null);
          }
        });
      };

      const isRealUpdateCandidate = (incomingBuildId: string | null): boolean => {
        if (!incomingBuildId) return true;
        if (incomingBuildId === CURRENT_BUILD_ID) return false;
        const inc = Number(incomingBuildId);
        const cur = Number(CURRENT_BUILD_ID);
        if (Number.isFinite(inc) && Number.isFinite(cur) && inc <= cur) return false;
        return true;
      };

      const tellWaitingToSkip = () => {
        const waiting = registration.waiting;
        if (!waiting) return;
        if (!newerBuildWorkers.has(waiting)) {
          log("skipping SKIP_WAITING — waiting worker not verified newer");
          return;
        }
        if (skipWaitingPosted.has(waiting)) return;
        if (opts.shouldSuppressUpdates?.()) {
          log("skipping SKIP_WAITING — host suppressed updates");
          return;
        }
        skipWaitingPosted.add(waiting);
        try {
          log("posting SKIP_WAITING to waiting worker");
          waiting.postMessage({ type: "SKIP_WAITING" });
        } catch (err) {
          log("SKIP_WAITING postMessage failed", { err: String(err) });
        }
      };

      const wireIncomingWorker = (newWorker: ServiceWorker) => {
        if (wiredWorkers.has(newWorker)) return;
        wiredWorkers.add(newWorker);
        log("wiring incoming worker", { initialState: newWorker.state });
        let activationWatchdogTimer: number | null = null;
        let activationRetryDone = false;

        const cancelActivationWatchdog = () => {
          if (activationWatchdogTimer != null) {
            window.clearTimeout(activationWatchdogTimer);
            activationWatchdogTimer = null;
          }
        };

        const armActivationWatchdog = (label: string) => {
          cancelActivationWatchdog();
          activationWatchdogTimer = window.setTimeout(() => {
            activationWatchdogTimer = null;
            const state = newWorker.state;
            if (state === "activating" || state === "activated") {
              log("activation watchdog: worker progressed", { state });
              return;
            }
            if (!activationRetryDone) {
              activationRetryDone = true;
              log("activation watchdog: nudging again", { state, label });
              void registration.update().catch(() => { /* network blip */ });
              try {
                if (registration.waiting) {
                  registration.waiting.postMessage({ type: "SKIP_WAITING" });
                  log("activation watchdog: re-posted SKIP_WAITING");
                }
              } catch (err) {
                log("activation watchdog: re-post failed", { err: String(err) });
              }
              armActivationWatchdog(`${label}-retry`);
              return;
            }
            log("activation watchdog: still waiting after retry — stalled", { state, label });
            setUpdateStalled(true);
          }, ACTIVATION_WATCHDOG_MS);
        };

        const onProgressedPastWaiting = () => {
          cancelActivationWatchdog();
          setUpdateStalled(false);
        };

        void queryWorkerBuildId(newWorker).then((id) => {
          const real = isRealUpdateCandidate(id);
          log("incoming worker build id resolved", {
            workerBuildId: id,
            currentBuildId: CURRENT_BUILD_ID,
            isRealUpdate: real,
          });
          if (real) {
            newerBuildWorkers.add(newWorker);
            if (newWorker.state === "installed") {
              updateInitiated = true;
              notifyUpdatingFor(targetBuildIdForGuard());
              tellWaitingToSkip();
              armActivationWatchdog("post-resolve-installed");
            } else if (newWorker.state === "activated") {
              updateInitiated = true;
              onProgressedPastWaiting();
            }
          }
        });

        const onState = () => {
          log("incoming worker state change", { state: newWorker.state });
          if (!navigator.serviceWorker.controller) return;
          if (!newerBuildWorkers.has(newWorker)) return;
          if (newWorker.state === "installed") {
            updateInitiated = true;
            notifyUpdatingFor(targetBuildIdForGuard());
            tellWaitingToSkip();
            armActivationWatchdog("statechange-installed");
          }
          if (newWorker.state === "activating") onProgressedPastWaiting();
          if (newWorker.state === "activated") {
            updateInitiated = true;
            onProgressedPastWaiting();
            window.setTimeout(() => {
              if (!reloading) triggerReload({ bypassGuard: true, source: "activated-fallback" });
            }, ACTIVATED_RELOAD_DELAY_MS);
          }
          if (newWorker.state === "redundant") cancelActivationWatchdog();
        };
        newWorker.addEventListener("statechange", onState);
        onState();
      };

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        log("updatefound event", { hasInstalling: !!newWorker });
        if (!newWorker) return;
        wireIncomingWorker(newWorker);
      });

      if (registration.installing) wireIncomingWorker(registration.installing);
      if (registration.waiting) {
        log("waiting worker present at registration time");
        wireIncomingWorker(registration.waiting);
      }

      // ---- State ----
      let pendingAttempts = 0;
      let errorAttempts = 0;
      let swProbeErrorAttempts = 0;
      let pendingFirstSeenAt: number | null = null;
      let lastRecoveryAt = 0;

      const timers = createTimerManager({
        setTimeout: (cb, ms) => window.setTimeout(cb, ms),
        clearTimeout: (h) => window.clearTimeout(h),
      });

      const jitter = () => Math.floor((Math.random() * 2 - 1) * JITTER_MS);

      const collectConnInputs = () => ({
        online: typeof navigator !== "undefined" ? navigator.onLine !== false : true,
        connection: ((navigator as unknown as { connection?: NetworkInfoLike }).connection ?? null),
      });

      const isBackgroundTab = (): boolean => {
        try { return typeof document !== "undefined" && document.visibilityState === "hidden"; }
        catch { return false; }
      };

      const computePollDelay = (): number =>
        computeNextDelay({
          errorAttempts, pendingAttempts,
          jitter: jitter(),
          connectionPenalty: getConnectionPenalty(collectConnInputs()),
          isBackground: isBackgroundTab(),
        });

      const swProbeDelay = (): number =>
        computeSwProbeDelay({
          jitter: jitter(),
          connectionPenalty: getConnectionPenalty(collectConnInputs()),
          isBackground: isBackgroundTab(),
        });

      const scheduleNextPoll = () => {
        timers.arm("poll", computePollDelay(), () => { void runVersionCheck(); });
      };

      const scheduleSwProbe = (o?: { force?: boolean }) => {
        if (!o?.force && timers.has("swProbe")) return;
        timers.arm("swProbe", swProbeDelay(), () => {
          void runSwProbe();
          scheduleSwProbe({ force: true });
        });
      };

      const resetBackoff = () => { pendingAttempts = 0; errorAttempts = 0; };

      const isOffline = (): boolean => {
        try { return typeof navigator !== "undefined" && navigator.onLine === false; }
        catch { return false; }
      };

      const safeSwUpdate = async (): Promise<boolean> => {
        if (isOffline()) return true;
        try {
          await registration.update();
          swProbeErrorAttempts = 0;
          return true;
        } catch {
          swProbeErrorAttempts++;
          if (swProbeErrorAttempts === SW_PROBE_FAILURE_THRESHOLD
              && isRemoteNewer(targetBuildIdForGuard(), CURRENT_BUILD_ID)) {
            console.warn(`[${logLabel}] registration.update() has failed ${swProbeErrorAttempts}× in a row; new SW may be unreachable.`);
          }
          return false;
        }
      };

      let stalledStoreLastWritten = false;

      if (bootHardRefreshOutcome === "failed") {
        log("boot detected hard-refresh failure; routing to SW recovery", { target: bootHardRefreshTarget });
        setUpdateStalled(true);
        stalledStoreLastWritten = true;
        triggerSwRecovery(bootHardRefreshTarget || targetBuildIdForGuard(), "boot-hard-refresh-failed");
      }

      const hasIncomingWorker = (): boolean => !!(registration.installing || registration.waiting);

      const maybeRunPoisonedSwRecovery = async (): Promise<void> => {
        try {
          const already = sessionStorage.getItem(k(KEYS.nukeAttempt));
          if (already) return;
        } catch { /* noop */ }
        const wedged = bootHardRefreshOutcome === "failed"
          || (isRemoteNewer(targetBuildIdForGuard(), CURRENT_BUILD_ID) && !hasIncomingWorker());
        if (!wedged) return;
        let body = "";
        try {
          const res = await fetch(`/sw-push.js?nuke=${Date.now()}`, { cache: "no-store", credentials: "omit" });
          if (!res.ok) return;
          body = await res.text();
        } catch { return; }
        if (body.includes("__PWAKIT_SW_BUILD_ID__")) return;
        try { sessionStorage.setItem(k(KEYS.nukeAttempt), "1"); } catch { /* noop */ }
        log("poisoned sw-push.js detected — running one-shot hard reset", { target: targetBuildIdForGuard() });
        const target = isRemoteNewer(targetBuildIdForGuard(), CURRENT_BUILD_ID)
          ? targetBuildIdForGuard() : undefined;
        await runHardReset(target);
      };
      void maybeRunPoisonedSwRecovery();

      const runStalledRecovery = async (): Promise<void> => {
        if (isOffline()) return;
        if (bootHardRefreshOutcome === "failed") {
          log("hard-refresh fallback skipped: boot detected previous failure");
          return;
        }
        const now = Date.now();
        if (now - lastRecoveryAt < STALLED_RECOVERY_INTERVAL_MS) return;
        lastRecoveryAt = now;
        const target = targetBuildIdForGuard();
        if (hasIncomingWorker()) {
          log("hard-refresh fallback skipped: incoming worker present");
          return;
        }
        log("stalled fallback: routing to standalone SW recovery", {
          target, currentBuildId: CURRENT_BUILD_ID, path: window.location.pathname,
        });
        triggerSwRecovery(target, "stalled-threshold");
      };

      const evaluateStalled = (): void => {
        const remoteIsNewer = isRemoteNewer(targetBuildIdForGuard(), CURRENT_BUILD_ID);
        if (!remoteIsNewer || hasIncomingWorker()) {
          if (pendingFirstSeenAt !== null) pendingFirstSeenAt = null;
          if (stalledStoreLastWritten) {
            setUpdateStalled(false);
            stalledStoreLastWritten = false;
          }
          return;
        }
        const now = Date.now();
        if (pendingFirstSeenAt === null) { pendingFirstSeenAt = now; return; }
        if (now - pendingFirstSeenAt >= STALLED_RECOVERY_THRESHOLD_MS) {
          if (!stalledStoreLastWritten) {
            log("stalled threshold crossed", {
              target: targetBuildIdForGuard(),
              elapsedMs: now - pendingFirstSeenAt,
            });
            setUpdateStalled(true);
            stalledStoreLastWritten = true;
          }
          void runStalledRecovery();
        }
      };

      // ---- In-flight guards ----
      let pollBusy = false;
      let pollWanted = false;
      const runVersionCheck = async (): Promise<void> => {
        if (pollBusy) { pollWanted = true; return; }
        pollBusy = true;
        try { await checkRemoteVersion(); }
        finally {
          pollBusy = false;
          if (pollWanted && isOffline()) pollWanted = false;
          if (pollWanted) { pollWanted = false; queueMicrotask(() => { void runVersionCheck(); }); }
        }
      };

      let swProbeBusy = false;
      let swProbeWanted = false;
      const runSwProbe = async (): Promise<void> => {
        if (swProbeBusy) { swProbeWanted = true; return; }
        swProbeBusy = true;
        try { await safeSwUpdate(); }
        finally {
          swProbeBusy = false;
          evaluateStalled();
          if (swProbeWanted && isOffline()) swProbeWanted = false;
          if (swProbeWanted) { swProbeWanted = false; queueMicrotask(() => { void runSwProbe(); }); }
        }
      };

      activeProbe = () => { void runVersionCheck(); void runSwProbe(); };

      const onOfflineTransition = () => { pollWanted = false; swProbeWanted = false; };

      scheduleSwProbe();

      const checkRemoteVersion = async () => {
        if (isOffline()) { scheduleNextPoll(); return; }
        try {
          const res = await fetch(`${versionUrl}${versionUrl.includes("?") ? "&" : "?"}ts=${Date.now()}`, {
            cache: "reload", credentials: "omit",
          });
          if (!res.ok) { errorAttempts++; return; }
          const data = (await res.json()) as { buildId?: string };
          const remote = typeof data.buildId === "string" ? data.buildId : null;
          if (!remote) { errorAttempts++; return; }

          errorAttempts = 0;
          setRemoteBuildId(remote);
          try { sessionStorage.setItem(k(KEYS.lastRemote), remote); } catch { /* noop */ }

          if (isRemoteNewer(remote, CURRENT_BUILD_ID)) {
            const isFirstDetection = pendingAttempts === 0;
            if (isFirstDetection) log("remote build detected", { remote, current: CURRENT_BUILD_ID });
            pendingAttempts++;
            void runSwProbe();
            tellWaitingToSkip();
            if (isFirstDetection) {
              for (const offset of SW_FAST_RETRY_OFFSETS_MS) {
                window.setTimeout(() => {
                  if (reloading) return;
                  if (!isRemoteNewer(targetBuildIdForGuard(), CURRENT_BUILD_ID)) return;
                  void runSwProbe();
                  tellWaitingToSkip();
                }, offset);
              }
            }
          } else {
            pendingAttempts = 0;
          }
        } catch { errorAttempts++; }
        finally {
          evaluateStalled();
          scheduleNextPoll();
        }
      };

      registration.addEventListener("updatefound", () => {
        pendingFirstSeenAt = null;
        if (stalledStoreLastWritten) {
          setUpdateStalled(false);
          stalledStoreLastWritten = false;
        }
        resetBackoff();
        scheduleNextPoll();
      });

      if (isBackgroundTab()) scheduleNextPoll();
      else void runVersionCheck();

      let lastVisibilityState: DocumentVisibilityState = document.visibilityState;
      document.addEventListener("visibilitychange", () => {
        const next = document.visibilityState;
        if (next === lastVisibilityState) return;
        lastVisibilityState = next;
        if (next !== "visible") { scheduleNextPoll(); scheduleSwProbe({ force: true }); return; }
        scheduleSwProbe({ force: true });
        if (isOffline()) { scheduleNextPoll(); return; }
        void runSwProbe();
        resetBackoff();
        void runVersionCheck();
      });

      let lastWakeAt = 0;
      const onWake = () => {
        const now = Date.now();
        if (now - lastWakeAt < WAKE_THROTTLE_MS) return;
        lastWakeAt = now;
        if (isOffline()) return;
        scheduleSwProbe({ force: true });
        void runSwProbe();
        void runVersionCheck();
      };
      window.addEventListener("focus", () => onWake());
      window.addEventListener("pageshow", (e: PageTransitionEvent) => {
        if (e.persisted) lastWakeAt = 0;
        onWake();
      });

      let onlineGraceTimer: number | null = null;
      window.addEventListener("online", () => {
        if (onlineGraceTimer != null) clearTimeout(onlineGraceTimer);
        onlineGraceTimer = window.setTimeout(() => {
          onlineGraceTimer = null;
          if (isOffline()) return;
          resetBackoff();
          timers.cancel("poll");
          timers.cancel("swProbe");
          void runSwProbe();
          void runVersionCheck();
          scheduleSwProbe({ force: true });
        }, ONLINE_GRACE_MS);
      });

      window.addEventListener("offline", () => {
        if (onlineGraceTimer != null) { clearTimeout(onlineGraceTimer); onlineGraceTimer = null; }
        onOfflineTransition();
      });

      try {
        const conn = (navigator as unknown as {
          connection?: { addEventListener?: (t: string, l: () => void) => void };
        }).connection;
        conn?.addEventListener?.("change", () => scheduleNextPoll());
      } catch { /* Network Information API unavailable */ }
    })
    .catch((err) => {
      console.error("SW registration failed:", err);
    });

  // ---- Cross-tab update broadcast ----
  let updateChannel: BroadcastChannel | null = null;
  let lastBroadcastHandledAt = 0;

  if (typeof BroadcastChannel !== "undefined") {
    try {
      updateChannel = new BroadcastChannel(UPDATE_CHANNEL_NAME);
      updateChannel.addEventListener("message", (event) => {
        const data = event.data as { type?: string; buildId?: string } | null;
        if (!data || data.type !== UPDATE_APPLIED_TYPE) return;
        const announced = typeof data.buildId === "string" ? data.buildId : null;
        if (!announced) return;
        const now = Date.now();
        if (now - lastBroadcastHandledAt < BROADCAST_DEBOUNCE_MS) return;
        lastBroadcastHandledAt = now;
        if (!isRemoteNewer(announced, CURRENT_BUILD_ID)) return;
        updateInitiated = true;
        triggerReload({ bypassGuard: true, source: "peer-broadcast" });
      });
    } catch { updateChannel = null; }
  }

  const broadcastUpdateApplied = () => {
    if (!updateChannel) return;
    let buildId = CURRENT_BUILD_ID;
    try {
      const stored = sessionStorage.getItem(k(KEYS.lastRemote));
      if (stored) buildId = stored;
    } catch { /* noop */ }
    try { updateChannel.postMessage({ type: UPDATE_APPLIED_TYPE, buildId }); } catch { /* noop */ }
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    try { console.info(`[${logLabel}] controllerchange event`, { updateInitiated }); } catch { /* noop */ }
    broadcastUpdateApplied();
    announceBuildIdToController("controllerchange");
    if (!updateInitiated) return;
    triggerReload({ bypassGuard: true, source: "controllerchange" });
  });
}
