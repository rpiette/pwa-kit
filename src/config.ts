/**
 * @rpiette/pwa-kit — global config & helpers shared across modules.
 *
 * The package is headless. Hosts call `installPwaAutoUpdate(...)` once at
 * boot; that call populates the module-level config used by the
 * controllers and the hard-reset helper.
 */

export interface PwaKitGlobalConfig {
  /** Namespace for all storage keys. Default: "pwakit:". */
  storagePrefix: string;
  /** Compile-time build id of the running bundle. "----" in dev/unknown. */
  buildId: string;
  /** Path to the standalone recovery page. Default: "/sw-recovery.html". */
  recoveryUrl: string;
}

const config: PwaKitGlobalConfig = {
  storagePrefix: "pwakit:",
  buildId: "----",
  recoveryUrl: "/sw-recovery.html",
};

export function setGlobalConfig(patch: Partial<PwaKitGlobalConfig>): void {
  if (patch.storagePrefix) config.storagePrefix = patch.storagePrefix;
  if (patch.buildId) config.buildId = patch.buildId;
  if (patch.recoveryUrl) config.recoveryUrl = patch.recoveryUrl;
}

export function getConfig(): PwaKitGlobalConfig {
  return config;
}

export function k(suffix: string): string {
  return `${config.storagePrefix}${suffix}`;
}

/** Storage key suffixes — keep in one place so docs and tests can refer to them. */
export const KEYS = {
  reloadGuard: "update-reload-guard",
  lastApplied: "last-applied-build-id",
  lastRemote: "last-remote-build-id",
  recoveryAttempt: "sw-recovery-attempted",
  hardRefreshAttempt: "hard-refresh-attempted",
  nukeAttempt: "nuke-attempt",
} as const;

/** Reserved query parameter the auto-updater stamps onto the URL. */
export const HARD_REFRESH_PARAM = "pwakit_update";
