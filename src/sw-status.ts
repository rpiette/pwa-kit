/**
 * SW status controller — live-tracks the page's service worker
 * registration and surfaces a compact state shape the host can render.
 *
 * Module-level stores at the bottom are written by the auto-update
 * orchestrator (remote build id, stalled, refreshing, functionsNewer)
 * and read by every subscribed controller.
 */
import { createStore } from "./events";
import { getConfig } from "./config";

export type SwState =
  | "none"
  | "checking"
  | "installing"
  | "waiting"
  | "active"
  | "redundant"
  | "refreshing"
  | "stalled";

export interface SwStatus {
  state: SwState;
  controllingId: string;
  newId: string;
  hasUpdate: boolean;
}

// ---- Module-level cross-controller stores (written by auto-update) ----
const remoteBuildIdStore = createStore<string | null>(null);
const stalledStore = createStore<boolean>(false);
const refreshingStore = createStore<boolean>(false);
const functionsNewerStore = createStore<string | null>(null);

export function setRemoteBuildId(id: string | null): void { remoteBuildIdStore.set(id); }
export function getRemoteBuildId(): string | null { return remoteBuildIdStore.get(); }

export function setUpdateStalled(stalled: boolean): void { stalledStore.set(stalled); }
export function getUpdateStalled(): boolean { return stalledStore.get(); }

export function setUpdateRefreshing(refreshing: boolean): void { refreshingStore.set(refreshing); }
export function getUpdateRefreshing(): boolean { return refreshingStore.get(); }

export function setFunctionsBuildNewer(id: string | null): void { functionsNewerStore.set(id); }
export function getFunctionsBuildNewer(): string | null { return functionsNewerStore.get(); }
export function subscribeFunctionsBuildNewer(fn: () => void): () => void {
  return functionsNewerStore.subscribe(fn);
}

export function getCurrentBuildId(): string {
  return getConfig().buildId || "----";
}

function normalize(s: ServiceWorker["state"] | string | undefined): SwState {
  switch (s) {
    case "installing": return "installing";
    case "installed":  return "waiting";
    case "waiting":    return "waiting";
    case "activating":
    case "activated":
    case "active":     return "active";
    case "redundant":  return "redundant";
    default:           return "none";
  }
}

export interface SwStatusController {
  getState(): SwStatus;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export interface SwStatusOptions {
  /** Skip wiring when true (preview/iframe). Default: auto-detect via `shouldSkip` if provided. */
  disabled?: boolean;
  /** Caller-supplied predicate, e.g. preview/iframe check. */
  shouldSkip?: () => boolean;
}

export function createSwStatusController(opts: SwStatusOptions = {}): SwStatusController {
  const store = createStore<SwStatus>({
    state: "none",
    controllingId: getCurrentBuildId(),
    newId: "",
    hasUpdate: false,
  });

  const disabled = opts.disabled === true
    || (opts.shouldSkip ? opts.shouldSkip() : false)
    || typeof navigator === "undefined"
    || !("serviceWorker" in navigator);

  if (disabled) {
    return {
      getState: () => store.get(),
      subscribe: (fn) => store.subscribe(fn),
      destroy: () => { /* nothing wired */ },
    };
  }

  let cancelled = false;
  const cleanups: Array<() => void> = [];

  const recompute = (reg: ServiceWorkerRegistration | null) => {
    if (cancelled) return;
    // Re-read on every recompute: installPwaAutoUpdate() sets the config after
    // module-level singletons are created, so the first call may see "----".
    const currentBuildId = getCurrentBuildId();
    const incoming = reg?.installing || reg?.waiting || null;
    const remote = remoteBuildIdStore.get();
    const hasRemoteUpdate = !!remote && remote !== currentBuildId;
    const showIncoming = !!incoming || hasRemoteUpdate;

    if (showIncoming) {
      let incomingState: SwState;
      if (refreshingStore.get()) incomingState = "refreshing";
      else if (incoming) incomingState = normalize(incoming.state);
      else if (stalledStore.get()) incomingState = "stalled";
      else incomingState = "checking";
      store.set({
        state: incomingState,
        controllingId: currentBuildId,
        newId: hasRemoteUpdate ? (remote as string) : "",
        hasUpdate: !!reg?.waiting,
      });
    } else {
      store.set({
        state: normalize(reg?.active?.state ?? "active"),
        controllingId: currentBuildId,
        newId: "",
        hasUpdate: false,
      });
    }
  };

  const onStoreChange = () => {
    navigator.serviceWorker.getRegistration().then((reg) => recompute(reg ?? null));
  };
  cleanups.push(remoteBuildIdStore.subscribe(onStoreChange));
  cleanups.push(stalledStore.subscribe(onStoreChange));
  cleanups.push(refreshingStore.subscribe(onStoreChange));

  const lateCleanups: Array<() => void> = [];
  const wire = (reg: ServiceWorkerRegistration, w: ServiceWorker | null) => {
    if (cancelled || !w) return;
    const onChange = () => recompute(reg);
    w.addEventListener("statechange", onChange);
    lateCleanups.push(() => w.removeEventListener("statechange", onChange));
  };

  navigator.serviceWorker.getRegistration().then((reg) => {
    if (cancelled) return;
    recompute(reg ?? null);
    if (!reg) return;
    wire(reg, reg.installing);
    wire(reg, reg.waiting);
    wire(reg, reg.active);
    if (cancelled) return;

    const onUpdateFound = () => { recompute(reg); wire(reg, reg.installing); };
    reg.addEventListener("updatefound", onUpdateFound);
    lateCleanups.push(() => reg.removeEventListener("updatefound", onUpdateFound));

    const onController = () => recompute(reg);
    navigator.serviceWorker.addEventListener("controllerchange", onController);
    lateCleanups.push(() => navigator.serviceWorker.removeEventListener("controllerchange", onController));
  });

  cleanups.push(() => { lateCleanups.forEach((fn) => fn()); lateCleanups.length = 0; });

  return {
    getState: () => store.get(),
    subscribe: (fn) => store.subscribe(fn),
    destroy(): void {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    },
  };
}
