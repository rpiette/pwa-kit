/**
 * Install controller — wraps `beforeinstallprompt`, iOS detection, and
 * standalone-mode detection in a framework-agnostic subscribable.
 *
 * Persistence: once installed (via `appinstalled`, standalone display
 * mode, or `navigator.getInstalledRelatedApps()`), the controller writes
 * a key to `localStorage` namespaced by the configured `storagePrefix`.
 * Future page loads in a regular browser tab (where `display-mode` is
 * `browser` and `beforeinstallprompt` no longer fires) seed `isInstalled`
 * from that key, so consumers can render "Installed" instead of
 * "Install unavailable".
 */
import { createStore } from "./events";
import { k } from "./config";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  canInstall: boolean;
  isIos: boolean;
  isInstalled: boolean;
  hasNativePrompt: boolean;
}

export interface InstallController {
  getState(): InstallState;
  subscribe(listener: () => void): () => void;
  /** Trigger the native install prompt. Resolves to `true` if accepted. */
  prompt(): Promise<boolean>;
  /** Detach event listeners. */
  destroy(): void;
}

const INSTALLED_KEY_SUFFIX = "pwa-installed";

function installedStorageKey(): string {
  return k(INSTALLED_KEY_SUFFIX);
}

function readPersistedInstalled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(installedStorageKey()) === "1";
  } catch {
    return false;
  }
}

function writePersistedInstalled(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(installedStorageKey(), "1");
    } else {
      window.localStorage.removeItem(installedStorageKey());
    }
  } catch { /* storage disabled / quota — non-fatal */ }
}

function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msStream = typeof window !== "undefined" && (window as any).MSStream;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !msStream;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch { /* matchMedia unsupported */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (navigator as any).standalone === true;
}

export function createInstallController(): InstallController {
  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  const initialInstalled = detectStandalone() || readPersistedInstalled();
  const store = createStore<InstallState>({
    canInstall: false,
    isIos: detectIos(),
    isInstalled: initialInstalled,
    hasNativePrompt: false,
  });

  const compute = (): InstallState => {
    const isInstalled = detectStandalone() || store.get().isInstalled;
    const hasNativePrompt = !!deferredPrompt;
    const isIos = store.get().isIos;
    return {
      canInstall: !isInstalled && (hasNativePrompt || isIos),
      isIos,
      isInstalled,
      hasNativePrompt,
    };
  };

  const markInstalled = () => {
    writePersistedInstalled(true);
    store.set({
      ...compute(),
      isInstalled: true,
      hasNativePrompt: false,
      canInstall: false,
    });
  };

  const onBeforeInstall = (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    store.set(compute());
  };
  const onAppInstalled = () => {
    deferredPrompt = null;
    markInstalled();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    // Probe the platform API for already-installed PWAs. This catches
    // "installed in this browser, now viewing in a regular tab" — where
    // `display-mode` is `browser` and `beforeinstallprompt` does not fire
    // because the browser already knows the app is installed. Fire-and-
    // forget; if it resolves with related apps, we push a new state.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any;
    if (typeof nav?.getInstalledRelatedApps === "function") {
      try {
        Promise.resolve(nav.getInstalledRelatedApps())
          .then((apps: unknown[]) => {
            if (Array.isArray(apps) && apps.length > 0) markInstalled();
          })
          .catch(() => { /* unsupported / blocked */ });
      } catch { /* synchronous throw — ignore */ }
    }
  }

  return {
    getState: () => store.get(),
    subscribe: (fn) => store.subscribe(fn),
    async prompt(): Promise<boolean> {
      if (!deferredPrompt) return false;
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        const accepted = outcome === "accepted";
        if (accepted) {
          deferredPrompt = null;
          markInstalled();
        }
        return accepted;
      } catch {
        return false;
      }
    },
    destroy(): void {
      if (typeof window === "undefined") return;
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    },
  };
}
