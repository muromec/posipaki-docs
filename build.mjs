import { build } from "czaczanka";
import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const pages = await build({
  name: "posipaki",
  clientEntry: "src/client.js",
});

// ── the assets get their content in their name ──────────────────────────────
//
// `assets/client.js` is one name forever, so a browser that has it keeps it and pairs new HTML with an old
// widget.  Each file is renamed to carry ten characters of its digest, and every page that names it is rewritten.

const root = "dist";
const assets = join(root, "assets");
const renamed = new Map();

for (const name of await readdir(assets)) {
  const bytes = await readFile(join(assets, name));
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const hashed = name.replace(/(\.[^.]+)$/, `.${digest}$1`);
  if (hashed === name) continue;
  await rename(join(assets, name), join(assets, hashed));
  renamed.set(`/assets/${name}`, `/assets/${hashed}`);
}

async function pagesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(entry.name === "assets" ? [] : await pagesIn(path)));
    else if (entry.name.endsWith(".html")) found.push(path);
  }
  return found;
}

for (const page of await pagesIn(root)) {
  let html = await readFile(page, "utf8");
  let changed = false;
  for (const [before, after] of renamed) {
    if (!html.includes(before)) continue;
    html = html.split(before).join(after);
    changed = true;
  }
  if (changed) await writeFile(page, html);
}

console.log(`built ${pages.length} page(s) → dist, ${renamed.size} asset(s) hashed`);
