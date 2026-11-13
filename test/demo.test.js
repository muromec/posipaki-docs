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
}, 30_000);

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

// ── the durable-actor widget ────────────────────────────────────────────────
//
// Mounted on its own rather than through the page: the client script is one module and it has already run for the
// guide, so a second import would be a cache hit and mount nothing.

let durable;
let window;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a condition holds, or fail naming what never happened. */
async function until(condition, what, ms = 4000) {
  for (let waited = 0; waited < ms; waited += 25) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`${what} did not happen`);
}

const boxes = () => [...durable.querySelectorAll(".durable-cell")];
const filled = (index, cell) => boxes()[index * 4 + cell].querySelector("svg") !== null;

beforeAll(async () => {
  window = new Window();
  exposeDomGlobals(window);
  window.document.body.innerHTML = '<div id="durable"></div>';
  const { createApp, h } = await import("vue");
  const { DurableDemo } = await import(pathToFileURL(join(root, "src/durable.js")).href);
  createApp({ render: () => h(DurableDemo) }).mount(window.document.querySelector("#durable"));
  await sleep(200);
  durable = window.document.querySelector(".durable");
}, 30_000);

test("mounts three boards, four boxes each, and four wires", () => {
  expect(durable).toBeTruthy();
  const names = [...durable.querySelectorAll(".durable-name")].map((n) => n.textContent);
  expect(names).toEqual(["A — the log", "B — deferred", "C — optimistic"]);
  expect(durable.querySelectorAll(".durable-cell").length).toBe(12);
  // Two directions between each pair of boards.
  expect(durable.querySelectorAll(".d-wire").length).toBe(4);
});

test("a figure placed on the log board reaches both followers, and the wires show it", async () => {
  boxes()[0].click();
  // A holds it at once; the records travel over the wires to B and C.
  await until(() => filled(0, 0), "the log board");
  await until(() => filled(1, 0), "the deferred follower");
  await until(() => filled(2, 0), "the optimistic follower");
});
test("a wire that is cut stops the board behind it", async () => {
  // The second wires group is B⇄C: its first wire carries records, its second carries requests.  Carrying →
  // slow → cut.
  const wires = [...durable.querySelectorAll(".d-wire")];
  const bcRecords = wires[2];
  bcRecords.click();
  await sleep(20);
  expect(bcRecords.classList.contains("is-slow")).toBe(true);
  bcRecords.click();
  await sleep(20);
  expect(bcRecords.classList.contains("is-cut")).toBe(true);

  // A figure the board does not hold yet: two of one shape and colour would clear it instead.
  const palette = [...durable.querySelectorAll(".durable-pick")];
  palette[1].click();
  await sleep(20);
  const before = filled(2, 2);
  boxes()[2].click();
  await until(() => filled(1, 2), "the deferred follower");
  await sleep(400);
  // The cut one has heard nothing.
  expect(filled(2, 2)).toBe(before);
});

test("a wire that carries again brings the board behind it up to date", async () => {
  const wires = [...durable.querySelectorAll(".d-wire")];
  const bcRecords = wires[2];
  bcRecords.click(); // cut → carrying
  await sleep(30);
  expect(bcRecords.classList.contains("is-cut")).toBe(false);
  // The follower is re-attached from the state where it finds the board.
  await until(() => filled(2, 2), "the re-attached follower");
});
