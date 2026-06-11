/**
 * Optional remote build-id handshake. Hosts call `checkAppVersion(...)`
 * to ask a deployed endpoint for its build id and compare it to the
 * running bundle. Returns:
 *   • "stale"   — remote is strictly newer, host should fast-track update
 *   • "fresh"   — remote matches or older
 *   • "unknown" — handshake unavailable / network error / no ids
 *
 * Never throws.
 */
import { getCurrentBuildId, setFunctionsBuildNewer } from "./sw-status";
import { isRemoteNewer, forceUpdateProbe } from "./auto-update";

export type AppVersionStatus = "fresh" | "stale" | "unknown";

export interface CheckAppVersionOptions {
  /** URL of the endpoint returning `{ functionsBuildId: string }`. */
  url: string;
  /** Optional headers (e.g. anon key). */
  headers?: Record<string, string>;
  /** Cache TTL for the in-memory result. Default: 60_000ms. */
  ttlMs?: number;
  /**
   * Custom extractor if your endpoint shape differs. Receives the parsed
   * JSON body and must return a string id (or null/undefined for unknown).
   */
  extractBuildId?: (body: unknown) => string | null | undefined;
}

interface CachedResult {
  status: AppVersionStatus;
  at: number;
}

const cache = new Map<string, CachedResult>();
const inflight = new Map<string, Promise<AppVersionStatus>>();

export async function checkAppVersion(opts: CheckAppVersionOptions): Promise<AppVersionStatus> {
  const ttl = opts.ttlMs ?? 60_000;
  const cached = cache.get(opts.url);
  if (cached && Date.now() - cached.at < ttl) return cached.status;
  const existing = inflight.get(opts.url);
  if (existing) return existing;

  const promise = (async (): Promise<AppVersionStatus> => {
    try {
      const res = await fetch(opts.url, {
        method: "GET",
        headers: opts.headers ?? {},
        cache: "no-store",
        credentials: "omit",
      });
      if (!res.ok) return "unknown";
      const body: unknown = await res.json();
      const extract = opts.extractBuildId ?? defaultExtract;
      const remoteId = extract(body);
      if (!remoteId || remoteId === "0") return "unknown";

      const current = getCurrentBuildId();
      if (!current || current === "----") return "unknown";

      const stale = isRemoteNewer(remoteId, current);
      if (stale) {
        setFunctionsBuildNewer(remoteId);
        forceUpdateProbe();
      }
      const status: AppVersionStatus = stale ? "stale" : "fresh";
      cache.set(opts.url, { status, at: Date.now() });
      return status;
    } catch {
      return "unknown";
    } finally {
      inflight.delete(opts.url);
    }
  })();

  inflight.set(opts.url, promise);
  return promise;
}

function defaultExtract(body: unknown): string | null {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.functionsBuildId === "string") return b.functionsBuildId;
    if (typeof b.buildId === "string") return b.buildId;
  }
  return null;
}

/** Test helper — clears the module-level cache. Not part of the stable API. */
export function _resetVersionCheckCache(): void {
  cache.clear();
  inflight.clear();
}
