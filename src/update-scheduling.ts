/**
 * Pure scheduling math + the timer manager + reload-loop / hard-refresh
 * guards. All DOM/storage I/O
 * is parameterized so the helpers stay unit-testable in isolation.
 */
import { getConfig, HARD_REFRESH_PARAM } from "./config";

export const BASE_INTERVAL_MS = 30_000;
export const JITTER_MS = 7_500;
export const PENDING_BACKOFF_BASE_MS = 60_000;
export const ERROR_BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const NETWORK_AWARE_MAX_MS = 15 * 60_000;
export const BACKGROUND_TAB_PENALTY = 4;
export const MIN_DELAY_MS = 1000;

export type NetworkInfoLike = {
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
};

export interface ConnectionPenaltyInputs {
  online: boolean;
  connection: NetworkInfoLike | null;
}

export function getConnectionPenalty(inputs: ConnectionPenaltyInputs): number {
  if (!inputs.online) return 8;
  const conn = inputs.connection;
  if (!conn) return 1;
  let penalty = 1;
  const eff = conn.effectiveType;
  if (eff === "slow-2g") penalty = Math.max(penalty, 6);
  else if (eff === "2g") penalty = Math.max(penalty, 4);
  else if (eff === "3g") penalty = Math.max(penalty, 2);
  if (conn.saveData) penalty = Math.max(penalty, 3);
  if (typeof conn.rtt === "number" && conn.rtt >= 1500) penalty = Math.max(penalty, 3);
  if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 0.5) {
    penalty = Math.max(penalty, 3);
  }
  return penalty;
}

export function applyNetworkPenalty(delay: number, penalty: number): number {
  if (penalty <= 1) return delay;
  return Math.min(NETWORK_AWARE_MAX_MS, Math.round(delay * penalty));
}

export function applyBackgroundPenalty(delay: number, isBackground: boolean): number {
  if (!isBackground) return delay;
  return Math.min(NETWORK_AWARE_MAX_MS, Math.round(delay * BACKGROUND_TAB_PENALTY));
}

export interface ComputeDelayInputs {
  errorAttempts: number;
  pendingAttempts: number;
  jitter: number;
  connectionPenalty: number;
  isBackground: boolean;
}

export function computeNextDelay(inputs: ComputeDelayInputs): number {
  const { errorAttempts, pendingAttempts, jitter } = inputs;
  const errorBackoff = errorAttempts > 0
    ? Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (errorAttempts - 1), BACKOFF_MAX_MS)
    : 0;
  const pendingBackoff = pendingAttempts > 0
    ? Math.min(PENDING_BACKOFF_BASE_MS * 2 ** (pendingAttempts - 1), BACKOFF_MAX_MS)
    : 0;
  const delay = (errorBackoff > 0 || pendingBackoff > 0)
    ? Math.max(errorBackoff, pendingBackoff) + jitter
    : BASE_INTERVAL_MS + jitter;
  return Math.max(
    MIN_DELAY_MS,
    applyBackgroundPenalty(
      applyNetworkPenalty(delay, inputs.connectionPenalty),
      inputs.isBackground,
    ),
  );
}

export function computeSwProbeDelay(inputs: {
  jitter: number;
  connectionPenalty: number;
  isBackground: boolean;
}): number {
  return Math.max(
    MIN_DELAY_MS,
    applyBackgroundPenalty(
      applyNetworkPenalty(BASE_INTERVAL_MS + inputs.jitter, inputs.connectionPenalty),
      inputs.isBackground,
    ),
  );
}

// ---- Reload-loop guard ----
export const RELOAD_LOOP_MAX = 2;
export const RELOAD_LOOP_WINDOW_MS = 5 * 60 * 1000;
export type ReloadGuard = { buildId: string; count: number; firstAt: number };

export interface ReloadGuardStore {
  read(): ReloadGuard | null;
  write(g: ReloadGuard): void;
  clear(): void;
}

export function canReloadFor(
  targetBuildId: string,
  now: number,
  store: ReloadGuardStore,
): { allowed: boolean; reason?: string } {
  const existing = store.read();
  if (!existing || existing.buildId !== targetBuildId || now - existing.firstAt > RELOAD_LOOP_WINDOW_MS) {
    store.write({ buildId: targetBuildId, count: 1, firstAt: now });
    return { allowed: true };
  }
  if (existing.count >= RELOAD_LOOP_MAX) {
    return {
      allowed: false,
      reason: `loop-detected:${existing.count}@${Math.round((now - existing.firstAt) / 1000)}s`,
    };
  }
  store.write({ ...existing, count: existing.count + 1 });
  return { allowed: true };
}

// ---- Hard-refresh URL builder ----
export { HARD_REFRESH_PARAM };

export function buildHardRefreshUrl(currentHref: string, targetBuildId: string): string {
  let url: URL;
  try { url = new URL(currentHref); }
  catch { return `/?${HARD_REFRESH_PARAM}=${encodeURIComponent(targetBuildId)}`; }
  url.searchParams.set(HARD_REFRESH_PARAM, targetBuildId);
  return url.toString();
}

export function stripHardRefreshParam(currentHref: string): string {
  let url: URL;
  try { url = new URL(currentHref); } catch { return currentHref; }
  if (!url.searchParams.has(HARD_REFRESH_PARAM)) return currentHref;
  url.searchParams.delete(HARD_REFRESH_PARAM);
  return url.toString();
}

// ---- Recovery URL builder ----
export function buildSwRecoveryUrl(currentHref: string, targetBuildId?: string): string {
  const recoveryPath = getConfig().recoveryUrl;
  let current: URL;
  try { current = new URL(currentHref); }
  catch {
    const targetParam = targetBuildId ? `&target=${encodeURIComponent(targetBuildId)}` : "";
    return `${recoveryPath}?return=%2F${targetParam}&t=${Date.now()}`;
  }
  const returnUrl = new URL(current.toString());
  returnUrl.searchParams.delete(HARD_REFRESH_PARAM);
  returnUrl.searchParams.delete("pwakit_force");
  returnUrl.searchParams.delete("pwakit_recovery");

  const recovery = new URL(recoveryPath, current.origin);
  recovery.searchParams.set("return", `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}` || "/");
  if (targetBuildId) recovery.searchParams.set("target", targetBuildId);
  recovery.searchParams.set("t", Date.now().toString());
  return recovery.toString();
}

// ---- Hard-refresh per-build attempt guard ----
export interface HardRefreshAttemptStore {
  read(): string | null;
  write(buildId: string): void;
  clear(): void;
}

export function canHardRefreshFor(
  targetBuildId: string,
  store: HardRefreshAttemptStore,
): { allowed: boolean; reason?: string } {
  const previous = store.read();
  if (previous === targetBuildId) {
    return { allowed: false, reason: "already-attempted-for-build" };
  }
  return { allowed: true };
}

// ---- Single timer manager ----
export type TimerSlot = "poll" | "swProbe";

export interface TimerManager {
  arm(name: TimerSlot, delayMs: number, fire: () => void): void;
  cancel(name: TimerSlot): void;
  has(name: TimerSlot): boolean;
}

export interface TimerEnv {
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

export function createTimerManager(env: TimerEnv): TimerManager {
  const handles = new Map<TimerSlot, number>();
  return {
    arm(name, delayMs, fire) {
      const existing = handles.get(name);
      if (existing != null) { env.clearTimeout(existing); handles.delete(name); }
      const handle = env.setTimeout(() => {
        handles.delete(name);
        fire();
      }, delayMs);
      handles.set(name, handle);
    },
    cancel(name) {
      const existing = handles.get(name);
      if (existing != null) { env.clearTimeout(existing); handles.delete(name); }
    },
    has(name) { return handles.has(name); },
  };
}
