// ── the durable-actor widget ────────────────────────────────────────────────
//
// Three 2×2 boards: the first owns the log, the second follows it and defers, the third follows the second and
// guesses.  The channels between them can be cut, which is what makes the shape visible.
//
// The actors come from `posipaki-durable-actor`; the spec below is the four words the package asks for.

import { h, ref, onMounted } from "vue";
import {
  logChannel,
  makeDurableActor,
  makeDurableProxyActor,
  mirrorChannel,
} from "posipaki-durable-actor";

const CELLS = 4;

const FIGURES = [
  { shape: "triangle", colour: "red" },
  { shape: "diamond", colour: "blue" },
  { shape: "circle", colour: "yellow" },
];

const PAINT = { red: "#d6544a", blue: "#4a82c9", yellow: "#d9a521" };

/** One board: four boxes, who moved it last, and how many records made it. */
const EMPTY = () => ({ cells: Array(CELLS).fill(null), by: "", at: 0, moves: 0 });

/** The four words.  A figure goes into an empty box, a filled box gives its figure back, and two of a figure on
 *  one board clear it. */
const shapes = {
  filter(board, ask) {
    if (ask.cell < 0 || ask.cell >= CELLS) return { refuse: `${ask.cell} is not a box` };
    const taken = board.cells[ask.cell] !== null;
    if (ask.figure === null && !taken) return { refuse: `box ${ask.cell} is empty` };
    if (ask.figure !== null && taken) return { refuse: `box ${ask.cell} is taken` };
    return { pass: true };
  },

  map(_board, ask) {
    if (ask.figure === null) return { type: "LIFT", at: ask.at, by: ask.by, cell: ask.cell };
    return { type: "PLACE", at: ask.at, by: ask.by, cell: ask.cell, figure: ask.figure };
  },

  reduce(board, record) {
    const base = board ?? EMPTY();
    if (record.type === "CLEAR") return { ...EMPTY(), by: record.by, at: record.at, moves: base.moves + 1 };
    if (record.type === "LIFT") {
      const cells = [...base.cells];
      cells[record.cell] = null;
      return { cells, by: record.by, at: record.at, moves: base.moves + 1 };
    }
    const cells = [...base.cells];
    cells[record.cell] = record.figure;
    const twin = cells.findIndex(
      (cell, at) =>
        cell !== null &&
        at !== record.cell &&
        cell.shape === record.figure.shape &&
        cell.colour === record.figure.colour,
    );
    return {
      cells: twin === -1 ? cells : Array(CELLS).fill(null),
      by: record.by,
      at: record.at,
      moves: base.moves + 1,
    };
  },

  diff(before, after) {
    const said = before ?? EMPTY();
    const empty = after.cells.every((cell) => cell === null);
    const was = said.cells.some((cell) => cell !== null);
    if (empty && was) return { type: "CLEAR", at: after.at, by: after.by };
    for (let cell = 0; cell < CELLS; cell += 1) {
      const had = said.cells[cell] ?? null;
      const has = after.cells[cell] ?? null;
      if (had === null && has !== null) {
        return { type: "PLACE", at: after.at, by: after.by, cell, figure: has };
      }
      if (had !== null && has === null) return { type: "LIFT", at: after.at, by: after.by, cell };
    }
    return { type: "CLEAR", at: after.at, by: after.by };
  },
};

/** A channel that can be cut: while it is, nothing it carries arrives and nothing may be sent. */
function gateChannel(inner) {
  const readers = new Set();
  let cut = false;
  inner.onFrame((record) => {
    if (cut) return;
    for (const reader of readers) reader(record);
  });
  return {
    channel: {
      async send(record) {
        if (cut) throw new Error("the channel is cut");
        await inner.send(record);
      },
      onFrame(handler) {
        readers.add(handler);
        return () => readers.delete(handler);
      },
      onClose: (handler) => inner.onClose(handler),
      onError: (handler) => inner.onError(handler),
      close: (reason) => inner.close(reason),
      get info() {
        return inner.info;
      },
      control: (command) => inner.control(command),
    },
    cut: () => {
      cut = true;
    },
    heal: () => {
      cut = false;
    },
    get cutNow() {
      return cut;
    },
  };
}

const Authority = makeDurableActor(shapes);
const Follower = makeDurableProxyActor(shapes);
const Guesser = makeDurableProxyActor(shapes, { mode: "optimistic" });

function figureSvg(figure, size = "100%") {
  const paint = PAINT[figure.colour];
  const shape = {
    triangle: h("polygon", { points: "50,14 86,84 14,84", fill: paint }),
    diamond: h("polygon", { points: "50,10 88,50 50,90 12,50", fill: paint }),
    circle: h("circle", { cx: 50, cy: 50, r: 38, fill: paint }),
  }[figure.shape];
  return h("svg", { viewBox: "0 0 100 100", style: { width: size, height: size } }, [shape]);
}

const STYLE = `
.durable { margin: 0; display: flex; flex-direction: column; gap: 0.9rem; }
.durable-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.durable-pick {
  width: 40px; height: 40px; padding: 5px;
  border: 1px solid var(--border, #e6ddcc); border-radius: 10px;
  background: var(--surface, #fffcf5); cursor: pointer;
}
.durable-pick.is-picked { border-color: var(--ink, #24201a); box-shadow: inset 0 0 0 2px var(--ink, #24201a); }
.durable-cut {
  padding: 0.3rem 0.7rem; border-radius: 999px;
  border: 1px solid var(--border, #e6ddcc); background: var(--surface, #fffcf5);
  color: var(--ink, #24201a); font-size: 0.8rem; font-weight: 600; cursor: pointer;
}
.durable-cut.is-cut { border-color: #d6544a; color: #d6544a; }
.durable-boards { display: grid; gap: 0.6rem; grid-template-columns: 1fr; }
@media (min-width: 620px) { .durable-boards { grid-template-columns: repeat(3, 1fr); } }
.durable-board {
  border: 1px solid var(--border, #e6ddcc); border-radius: 12px; padding: 0.6rem;
  background: var(--surface, #fffcf5);
}
.durable-name {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted, #857c6e); margin-bottom: 0.45rem;
}
.durable-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
.durable-cell {
  aspect-ratio: 1; display: grid; place-items: center; cursor: pointer;
  border: 1px dashed var(--border, #e6ddcc); border-radius: 10px; background: transparent;
}
.durable-cell.is-filled { border-style: solid; }
.durable-log {
  margin: 0; padding: 0.6rem 0.75rem; max-height: 9rem; overflow: auto;
  background: var(--code-bg, #2b251d); color: var(--code-ink, #f5efe3);
  border-radius: 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.76rem;
  line-height: 1.6; white-space: pre-wrap;
}
`;

let injected = false;
function injectStyle() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.id = "durable-widget-style";
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/** The widget: three boards, the figures to place, the channels to cut, and what happened. */
export const DurableDemo = {
  name: "DurableDemo",
  setup() {
    const boards = ref([null, null, null]);
    const picked = ref(FIGURES[0]);
    const cuts = ref([false, false]);
    const events = ref([]);
    const ready = ref(false);

    let procs = [];
    let gates = [];

/** Wait until a process has folded a state: a spawn resolves before its source has been read. */
function folded(proc) {
  return new Promise((resolve) => {
    if (proc.state?.state != null) return resolve();
    const stop = proc.subscribe("state", () => {
      if (proc.state?.state == null) return;
      stop();
      resolve();
    });
  });
}

    const say = (line) => {
      events.value = [`${new Date().toLocaleTimeString()}  ${line}`, ...events.value].slice(0, 30);
    };

    const repaint = () => {
      boards.value = procs.map((proc) => proc.state?.state ?? null);
    };

    /** Build the three processes over a fresh log: the log, a deferred follower, an optimistic one. */
    const build = async () => {
      const log = logChannel([{ type: "CLEAR", at: 0, by: "system" }]);
      const a = await Authority.spawn({ source: log }, { name: "board-a" });
      await folded(a);
      const ab = gateChannel(mirrorChannel(a, shapes));
      const b = await Follower.spawn(
        { authority: a, snapshot: a.state?.state ?? null, source: ab.channel },
        { name: "board-b" },
      );
      // A follower attaches to a state: each one is spawned once the process it follows has folded.
      await folded(b);
      const bc = gateChannel(mirrorChannel(b, shapes));
      const c = await Guesser.spawn(
        { authority: b, snapshot: b.state?.state ?? null, source: bc.channel },
        { name: "board-c" },
      );
      await folded(c);

      procs = [a, b, c];
      gates = [ab, bc];
      cuts.value = [false, false];
      procs.forEach((proc, index) => {
        proc.send({ type: "ATTACH" });
        proc.subscribe("state", repaint);
        proc.subscribe("message", (said) => {
          if (said.type === "REJECTED") say(`board ${"ABC"[index]}: refused — ${said.reason}`);
          if (said.type === "FAILED") say(`board ${"ABC"[index]}: ${said.reason}`);
        });
      });
      repaint();
      ready.value = true;
    };

    onMounted(async () => {
      injectStyle();
      await build();
      say("three boards: A owns the log, B defers to it, C guesses");
    });

    /** A click on a box: place the picked figure there, or lift what stands there. */
    const click = (index, cell) => {
      const proc = procs[index];
      if (proc === undefined) return;
      const board = proc.state?.state ?? null;
      const occupied = board !== null && board.cells[cell] !== null;
      proc.send({
        type: "ASK",
        requestId: `ask-${Date.now()}-${cell}-${index}`,
        request: {
          by: `board ${"ABC"[index]}`,
          at: Date.now(),
          cell,
          figure: occupied ? null : picked.value,
        },
      });
    };

    const cut = (index) => {
      const gate = gates[index];
      if (gate === undefined) return;
      if (gate.cutNow) {
        gate.heal();
        cuts.value = cuts.value.map((value, at) => (at === index ? false : value));
        say(`${["A→B", "B→C"][index]} healed — the boards are re-attached from the state they find`);
        void build();
        return;
      }
      gate.cut();
      cuts.value = cuts.value.map((value, at) => (at === index ? true : value));
      say(`${["A→B", "B→C"][index]} cut — everything behind it stops moving`);
    };

    return () => {
      const palette = FIGURES.map((figure) =>
        h(
          "button",
          {
            class: "durable-pick" + (picked.value === figure ? " is-picked" : ""),
            title: `${figure.colour} ${figure.shape}`,
            onClick: () => {
              picked.value = figure;
              say(`picked the ${figure.colour} ${figure.shape}`);
            },
          },
          [figureSvg(figure)],
        ),
      );

      const switches = ["A→B", "B→C"].map((name, index) =>
        h(
          "button",
          { class: "durable-cut" + (cuts.value[index] ? " is-cut" : ""), onClick: () => cut(index) },
          `${name}: ${cuts.value[index] ? "cut" : "carrying"}`,
        ),
      );

      const panels = ["A — the log", "B — deferred", "C — optimistic"].map((name, index) =>
        h("div", { class: "durable-board" }, [
          h("div", { class: "durable-name" }, name),
          h(
            "div",
            { class: "durable-grid" },
            Array.from({ length: CELLS }, (_unused, cell) => {
              const figure = boards.value[index]?.cells?.[cell] ?? null;
              return h(
                "button",
                {
                  class: "durable-cell" + (figure === null ? "" : " is-filled"),
                  title:
                    figure === null
                      ? `box ${cell}, empty`
                      : `box ${cell}, ${figure.colour} ${figure.shape}`,
                  onClick: () => click(index, cell),
                },
                figure === null ? [] : [figureSvg(figure, "74%")],
              );
            }),
          ),
        ]),
      );

      return h("div", { class: "durable" }, [
        h("div", { class: "durable-bar" }, palette),
        h("div", { class: "durable-bar" }, switches),
        h("div", { class: "durable-boards" }, panels),
        h("pre", { class: "durable-log" }, events.value.join("\n")),
        h(
          "div",
          { style: { color: "var(--muted, #857c6e)", fontSize: "0.84rem" } },
          ready.value
            ? "place a figure in an empty box; click a filled box to lift it; two of a figure clear the board"
            : "starting…",
        ),
      ]);
    };
  },
};
