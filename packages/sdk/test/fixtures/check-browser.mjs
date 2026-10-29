import { readFile } from "node:fs/promises";

for (const filename of ["browser.js", "browser.cjs"]) {
  const source = await readFile(new URL(`../../dist/${filename}`, import.meta.url), "utf8");
  for (const forbidden of ["@sentry/node", "node:", "process.cwd", "process.on("]) {
    if (source.includes(forbidden)) {
      throw new Error(`${filename} contains forbidden server reference: ${forbidden}`);
    }
  }
}
