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
import type { Plugin } from "vite";

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

  const injectSwBuildId = (original: string): string => {
    const assignmentRe = /(self\.__PWAKIT_SW_BUILD_ID__\s*=\s*)(["'])([^"']*)(\2)(\s*;)/g;
    let replacedAssignment = false;
    const withAssignment = original.replace(
      assignmentRe,
      (_match, prefix: string, _quote: string, _value: string, _closingQuote: string, suffix: string) => {
        replacedAssignment = true;
        return `${prefix}${JSON.stringify(BUILD_ID)}${suffix}`;
      },
    );
    if (replacedAssignment) return withAssignment;

    const PLACEHOLDER = "__SW_BUILD_ID_PLACEHOLDER__";
    return original.includes(PLACEHOLDER)
      ? original.replace(new RegExp(PLACEHOLDER, "g"), BUILD_ID)
      : original;
  };

  const injectSw: Plugin = {
    name: "pwakit:inject-sw-build-id",
    apply: "build",
    enforce: "post",
    closeBundle() {
      // Try both the source location (in case vite-plugin-pwa copied it
      // verbatim) and the output location.
      const candidates = [
        path.resolve(resolvedRoot, swHelperPath),
        path.join(resolvedOutDir, path.basename(swHelperPath)),
      ];
      for (const target of candidates) {
        try {
          if (!fs.existsSync(target)) continue;
          const original = fs.readFileSync(target, "utf8");
          const replaced = injectSwBuildId(original);
          if (replaced === original) continue;
          if (/self\.\d/.test(replaced)) {
            throw new Error(`[${logLabel}] sw helper post-injection sanity check failed: \`self.<digits>\` access detected. Placeholder over-replaced in ${target}.`);
          }
          fs.writeFileSync(target, replaced);
          console.log(`[${logLabel}] injected build id ${BUILD_ID} into ${path.relative(resolvedRoot, target)}`);
        } catch (err) {
          if (err instanceof Error) throw err;
          throw new Error(`[${logLabel}] failed to inject build id: ${String(err)}`);
        }
      }
    },
  };

  return [define, emitVersion, injectSw];
}

export default pwaKit;
