/**
 * @rpiette/pwa-kit — public surface.
 *
 * Framework-agnostic, headless. The host renders every pixel; this
 * package owns service-worker lifecycle, install prompt capture, the
 * update nag store, hard-reset, and the auto-update orchestrator.
 */

export {
  installPwaAutoUpdate,
  forceUpdateProbe,
  isRemoteNewer,
  type InstallPwaAutoUpdateOptions,
} from "./auto-update";

export {
  createInstallController,
  type InstallController,
  type InstallState,
} from "./install";

export {
  createSwStatusController,
  type SwStatusController,
  type SwStatusOptions,
  type SwStatus,
  type SwState,
  getCurrentBuildId,
  setRemoteBuildId,
  getRemoteBuildId,
  setUpdateStalled,
  getUpdateStalled,
  setUpdateRefreshing,
  getUpdateRefreshing,
  setFunctionsBuildNewer,
  getFunctionsBuildNewer,
  subscribeFunctionsBuildNewer,
} from "./sw-status";

export {
  snoozeFor,
  clearSnooze,
  isSnoozed,
  subscribeSnooze,
  getSnooze,
  type UpdateNagState,
} from "./nag-store";

export { runHardReset } from "./hard-reset";

export {
  checkAppVersion,
  type AppVersionStatus,
  type CheckAppVersionOptions,
} from "./version-check";

export { buildRecoveryHtml, type RecoveryHtmlOptions } from "./recovery";

export {
  buildHardRefreshUrl,
  stripHardRefreshParam,
  buildSwRecoveryUrl,
  computeNextDelay,
  computeSwProbeDelay,
  getConnectionPenalty,
  canReloadFor,
  canHardRefreshFor,
  createTimerManager,
  HARD_REFRESH_PARAM,
  BASE_INTERVAL_MS,
  JITTER_MS,
  type NetworkInfoLike,
  type ConnectionPenaltyInputs,
  type ComputeDelayInputs,
  type ReloadGuard,
  type ReloadGuardStore,
  type HardRefreshAttemptStore,
  type TimerEnv,
  type TimerManager,
  type TimerSlot,
} from "./update-scheduling";

export { setGlobalConfig, getConfig, type PwaKitGlobalConfig } from "./config";
