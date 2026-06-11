/**
 * Vite plugin — `pwaKit()`.
 *
 * Three jobs:
 *   1. Define `__APP_BUILD_ID__` as a compile-time string constant.
 *   2. Emit `/version.json` at `{ buildId, builtAt }` into public/ and dist/.
 *   3. Inject the build id into the SW helper by replacing
 *      `__SW_BUILD_ID_PLACEHOLDER__` literal in the configured SW file
 *      post-build.
 *
 * Hashing the SW helper (content-addressed import) is host-specific and
 * left out — consumers can add their own follow-up plugin if needed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { buildRecoveryHtml, type RecoveryHtmlOptions } from "../src/recovery";

// Resolves the `sw/sw-push.js` template bundled with this package.
// Works in both ESM (import.meta.url) and CJS (__filename via tsup transform).
const SW_TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../sw/sw-push.js",
);

export interface PwaKitVitePluginOptions {
  /**
   * Path (relative to project root) of the SW helper file containing
   * the literal `__SW_BUILD_ID_PLACEHOLDER__`. Default: "public/sw-push.js".
   */
  swHelperPath?: string;
  /**
   * Directory to emit `version.json` into BEFORE the build, so
   * vite-plugin-pwa can pick it up. Default: "public".
   */
  publicDir?: string;
  /** Output directory. Default: vite's resolved outDir (typically "dist"). */
  outDir?: string;
  /** Override the generated build id. Default: `Date.now().toString()`. */
  buildId?: string;
  /** Log prefix. Default: "pwakit". */
  logLabel?: string;
  /**
   * When set, generates `sw-recovery.html` at the given path (relative to
   * project root) during the build and dev server start. Accepts all options
   * from `buildRecoveryHtml()` — pass `bodyHtml` to supply your own UI.
   */
  recoveryHtml?: RecoveryHtmlOptions & {
    /** Output path relative to project root. Default: "public/sw-recovery.html". */
    path?: string;
  };
}

export function pwaKit(opts: PwaKitVitePluginOptions = {}): Plugin[] {
  const BUILD_ID = opts.buildId ?? Date.now().toString();
  const swHelperPath = opts.swHelperPath ?? "public/sw-push.js";
  const publicDirOption = opts.publicDir ?? "public";
  const logLabel = opts.logLabel ?? "pwakit";
  let resolvedRoot = process.cwd();
  let resolvedOutDir = opts.outDir ?? "dist";

  const writeVersion = (dir: string, builtAt: string) => {
    const payload = JSON.stringify({ buildId: BUILD_ID, builtAt });
    try {
      if (!fs.existsSync(dir)) {
        if (dir.endsWith(publicDirOption) || dir.endsWith("public")) {
          fs.mkdirSync(dir, { recursive: true });
        } else {
          return;
        }
      }
      fs.writeFileSync(path.join(dir, "version.json"), payload);
    } catch (err) {
      console.warn(`[${logLabel}] failed to write ${dir}/version.json`, err);
    }
  };

  const define: Plugin = {
    name: "pwakit:define",
    config() {
      return {
        define: {
          __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
        },
      };
    },
    configResolved(cfg) {
      resolvedRoot = cfg.root;
      resolvedOutDir = path.isAbsolute(cfg.build.outDir)
        ? cfg.build.outDir
        : path.resolve(cfg.root, cfg.build.outDir);
    },
  };

  const emitVersion: Plugin = {
    name: "pwakit:emit-version-json",
    apply: "build",
    buildStart() {
      writeVersion(path.resolve(resolvedRoot, publicDirOption), new Date().toISOString());
    },
    closeBundle() {
      const at = new Date().toISOString();
      writeVersion(path.resolve(resolvedRoot, publicDirOption), at);
      writeVersion(resolvedOutDir, at);
    },
  };

  const writeSw = (dest: string) => {
    try {
      const template = fs.readFileSync(SW_TEMPLATE_PATH, "utf8");
      const injected = template.replace(/__SW_BUILD_ID_PLACEHOLDER__/g, BUILD_ID);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, injected, "utf8");
      console.log(`[${logLabel}] generated ${path.relative(resolvedRoot, dest)} (build id ${BUILD_ID})`);
    } catch (err) {
      throw new Error(`[${logLabel}] failed to write ${dest}: ${String(err)}`);
    }
  };

  const injectSw: Plugin = {
    name: "pwakit:inject-sw-build-id",
    configResolved() {
      // Write to public/ so the dev server serves the correct file.
      writeSw(path.resolve(resolvedRoot, swHelperPath));
    },
    apply: "build",
    enforce: "post",
    closeBundle() {
      // Also write to the build output directory.
      writeSw(path.join(resolvedOutDir, path.basename(swHelperPath)));
    },
  };

  const emitRecovery: Plugin | null = opts.recoveryHtml != null ? {
    name: "pwakit:emit-recovery-html",
    configResolved() {
      const { path: filePath = "public/sw-recovery.html", ...htmlOpts } = opts.recoveryHtml!;
      const out = path.resolve(resolvedRoot, filePath);
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buildRecoveryHtml(htmlOpts), "utf8");
        console.log(`[${logLabel}] generated ${filePath}`);
      } catch (err) {
        console.warn(`[${logLabel}] failed to write ${filePath}`, err);
      }
    },
  } : null;

  return [define, emitVersion, injectSw, ...(emitRecovery ? [emitRecovery] : [])];
}

export default pwaKit;
