/**
 * Hard reset escape hatch — full SW unregister + caches purge happens
 * inside the recovery page itself; this helper only navigates there
 * with the right query params.
 */
import { getConfig } from "./config";
import { buildSwRecoveryUrl } from "./update-scheduling";
import { getRemoteBuildId, setUpdateRefreshing } from "./sw-status";

/**
 * Routes the page to the standalone recovery document, which clears
 * service workers + Cache Storage and then returns the user to the app
 * via a cache-busted URL. Resilient: every step is independently
 * guarded so a partial failure still navigates.
 */
export async function runHardReset(targetBuildId?: string): Promise<void> {
  const target = targetBuildId || getRemoteBuildId() || "";
  setUpdateRefreshing(true);
  const recovery = getConfig().recoveryUrl;
  try {
    if (typeof window !== "undefined") {
      window.location.replace(buildSwRecoveryUrl(window.location.href, target || undefined));
      return;
    }
  } catch {
    /* fall through */
  }
  if (typeof window !== "undefined") {
    window.location.assign(`${recovery}${target ? `?target=${encodeURIComponent(target)}` : ""}`);
  }
}
