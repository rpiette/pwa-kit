import { buildRecoveryHtml } from "../dist/index.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../assets");
const outFile = join(outDir, "sw-recovery.html");

await mkdir(outDir, { recursive: true });
await writeFile(outFile, buildRecoveryHtml(), "utf8");
console.log("[pwa-kit] generated assets/sw-recovery.html");
