// Spec budget: first load under 600 KB gzipped (scene chunk is lazy via next/dynamic).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../.next/static", import.meta.url));
let total = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (/\.(js|css)$/.test(entry)) {
      total += gzipSync(readFileSync(path)).length;
    }
  }
};
try {
  walk(root);
} catch {
  console.error("BUILD FIRST: `npm run build` in website/, then re-run.");
  process.exit(2);
}
console.log(`client gzip total: ${(total / 1024).toFixed(0)} KB`);
if (total > 614_400) {
  console.error("BUDGET EXCEEDED: client gzip total must stay under 600 KB.");
  process.exit(1);
}
console.log("budgets OK");
