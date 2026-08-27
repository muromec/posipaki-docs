import { readdir, readFile, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(root, "content");
const SRC = join(root, "src");
const OUT = join(root, "dist");

const md = new MarkdownIt({ html: true, linkify: true });

// Inline rule: ::demo{name} -> <div class="demo" data-demo="name"></div>
md.inline.ruler.before("emphasis", "demo", (state, silent) => {
  const start = state.pos;
  if (!state.src.startsWith("::demo{", start)) return false;
  const end = state.src.indexOf("}", start);
  if (end === -1) return false;
  if (!silent) {
    const name = state.src.slice(start + 7, end);
    const token = state.push("html_inline", "", 0);
    token.content = `<div class="demo" data-demo="${name}"></div>`;
  }
  state.pos = end + 1;
  return true;
});

// "1.guide" -> "guide", "1.index.md" -> "index.md"
const stripPrefix = (s) => s.replace(/^\d+\./, "");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

async function renderPage(file) {
  const raw = await readFile(file, "utf8");
  const html = md.render(raw);
  const title = (raw.match(/^# (.+)$/m) || [])[1] || basename(file, ".md");
  const parts = relative(CONTENT, file).split("/").map(stripPrefix);
  let outRel;
  if (parts[parts.length - 1] === "index.md") {
    outRel = [...parts.slice(0, -1), "index.html"].join("/");
  } else {
    outRel = parts.join("/").replace(/\.md$/, ".html");
  }
  return { outRel, title, html };
}

function layout(title, nav, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · posipaki</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header><a class="brand" href="/">posipaki</a><nav>${nav}</nav></header>
<main>${content}</main>
<script type="module" src="/assets/client.js"></script>
</body>
</html>`;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  const files = await walk(CONTENT);
  const pages = await Promise.all(files.map(renderPage));

  const nav = pages
    .map((p) => {
      const href = "/" + p.outRel.replace(/\/?index\.html$/, "/");
      return `<a href="${href}">${p.title}</a>`;
    })
    .join("");

  for (const p of pages) {
    const dest = join(OUT, p.outRel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, layout(p.title, nav, p.html));
  }

  await mkdir(join(OUT, "assets"), { recursive: true });
  await build({
    entryPoints: [join(SRC, "client.js")],
    bundle: true,
    outfile: join(OUT, "assets", "client.js"),
    format: "esm",
  });
  await copyFile(join(SRC, "style.css"), join(OUT, "assets", "style.css"));

  console.log(`built ${pages.length} page(s) -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
