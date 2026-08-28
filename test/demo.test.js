import { test, expect, beforeAll } from "bun:test";
import { build } from "czaczanka";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;

function exposeDomGlobals(window) {
  for (const k of Object.getOwnPropertyNames(window)) {
    if (!(k in globalThis)) {
      try {
        globalThis[k] = window[k];
      } catch {
        /* ignore non-configurable globals */
      }
    }
  }
  globalThis.__VUE_OPTIONS_API__ = true;
  globalThis.__VUE_PROD_DEVTOOLS__ = false;
  globalThis.__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;
}

let demo;

beforeAll(async () => {
  await build({ cwd: root, name: "posipaki", clientEntry: "src/client.js" });

  const html = await readFile(join(root, "dist/guide/index.html"), "utf8");
  const window = new Window();
  exposeDomGlobals(window);
  window.document.write(html);

  await import(pathToFileURL(join(root, "dist/assets/client.js")).href);
  await new Promise((resolve) => setTimeout(resolve, 80));

  demo = window.document.querySelector(".race-demo");
});

test("race demo mounts with three coloured buttons", () => {
  expect(demo).toBeTruthy();
  const names = [...demo.querySelectorAll(".race-btn .race-name")].map((n) => n.textContent);
  expect(names).toEqual(["RED", "GREEN", "BLUE"]);
  expect(demo.querySelectorAll(".race-line").length).toBe(5);
});

test("a click highlights the handler and animates a wave", async () => {
  const red = [...demo.querySelectorAll(".race-btn")].find((b) => b.textContent.includes("RED"));
  red.click();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const active = demo.querySelector(".race-line.is-active");
  expect(active.textContent).toContain("RED");
  // wave + halo circles are rendered while processing
  expect(demo.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(2);
  expect(demo.querySelector(".race-status").textContent).toContain("processing RED");

  // RED sleeps 1500ms, then clears
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(demo.querySelector(".race-line.is-active")).toBeNull();
});

test("messages process one at a time — later colours queue", async () => {
  const btn = (name) =>
    [...demo.querySelectorAll(".race-btn")].find((b) => b.textContent.includes(name));
  btn("RED").click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  btn("GREEN").click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  btn("BLUE").click();
  await new Promise((resolve) => setTimeout(resolve, 150));

  // RED is active; GREEN + BLUE are queued at the entrance (2 wave circles + 2 dots)
  const active = demo.querySelector(".race-line.is-active");
  expect(active.textContent).toContain("RED");
  expect(demo.querySelectorAll("svg circle").length).toBe(4);
});
