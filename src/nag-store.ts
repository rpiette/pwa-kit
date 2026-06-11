/**
 * Update-nag (snooze) store — in-memory only.
 *
 * NOT persisted to storage:
 *   • A real reload (success case) clears it naturally.
 *   • Long sessions where the user keeps deferring SHOULD re-prompt.
 *   • A newer build id invalidates the snooze immediately so users
 *     never hold off on a now-superseded version.
 */

export interface UpdateNagState {
  /** Epoch ms after which the dialog is allowed to re-open. 0 = no active snooze. */
  snoozedUntil: number;
  /** Build id the snooze was set for. Used to invalidate when a newer build appears. */
  snoozedForBuildId: string;
}

const state: UpdateNagState = { snoozedUntil: 0, snoozedForBuildId: "" };
const listeners = new Set<() => void>();
const emit = () => {
  listeners.forEach((fn) => { try { fn(); } catch { /* noop */ } });
};

export function getSnooze(): UpdateNagState {
  return { ...state };
}

export function snoozeFor(durationMs: number, buildId: string): void {
  state.snoozedUntil = Date.now() + Math.max(0, durationMs);
  state.snoozedForBuildId = buildId || "";
  emit();
}

export function clearSnooze(): void {
  if (state.snoozedUntil === 0 && state.snoozedForBuildId === "") return;
  state.snoozedUntil = 0;
  state.snoozedForBuildId = "";
  emit();
}

export function subscribeSnooze(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * True when the dialog should be suppressed for the given pending build
 * id. The snooze is invalidated as soon as a newer id arrives or the
 * window elapses.
 */
export function isSnoozed(currentNewBuildId: string, now: number = Date.now()): boolean {
  if (!state.snoozedUntil) return false;
  if (now >= state.snoozedUntil) return false;
  if (state.snoozedForBuildId && currentNewBuildId && state.snoozedForBuildId !== currentNewBuildId) {
    return false;
  }
  return true;
}
