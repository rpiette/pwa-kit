import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vite: "vite/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  splitting: false,
  shims: true,
  // Emit ESM as .mjs and CJS as .cjs so the file extensions match
  // package.json `exports` and Node correctly identifies module format
  // regardless of any consumer's `"type"` field.
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },
  onSuccess: "node scripts/gen-recovery.mjs",
});
