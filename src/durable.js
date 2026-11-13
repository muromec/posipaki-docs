// ── the durable-actor widget ────────────────────────────────────────────────
//
// Three 2×2 boards: the first owns the log, the second follows it and defers, the third follows the second and
// guesses.  Between them are four wires, because a board talks to the next one in two directions: records travel
// one way (what the log applied), requests travel the other.  A wire can be carried, slowed or cut, and shows
// what is inside it while a message is there.
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
  { shape: "square", colour: "green" },
];

const PAINT = { red: "#d6544a", blue: "#4a82c9", yellow: "#d9a521", green: "#3f9a5f" };

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

// ── the wires ───────────────────────────────────────────────────────────────

/** How long a slowed wire holds a message. */
const SLOW_MS = 1400;
/** How long a carrying wire shows that something went through it, so a fast hop is still visible. */
const FLASH_MS = 280;

/** One wire: whether it carries, what it is holding, and how much is inside it right now. */
function makeWire(name, toward = "right") {
  const state = ref("up");
  const busy = ref(0);
  const wire = {
    toward,
    name,
    state,
    busy,
    /** Called when a message enters: the indicator lives while the count is above zero. */
    enter() {
      busy.value += 1;
      return () => {
        busy.value = Math.max(0, busy.value - 1);
      };
    },
    /** Click: carrying, then slow, then cut, then carrying again. */
    cycle() {
      state.value = state.value === "up" ? "slow" : state.value === "slow" ? "cut" : "up";
    },
    get label() {
      return state.value === "up" ? "carrying" : state.value === "slow" ? "slow" : "cut";
    },
  };
  return wire;
}

/** Hand something through a wire: it arrives after the wire's delay, or never if the wire is cut. */
function through(wire, deliver) {
  const release = wire.enter();
  if (wire.state.value === "cut") {
    release();
    return;
  }
  setTimeout(
    () => {
      deliver();
      release();
    },
    wire.state.value === "slow" ? SLOW_MS : FLASH_MS,
  );
}

/** A channel whose frames cross a wire. */
function wiredChannel(inner, wire) {
  return {
    async send(record) {
      await inner.send(record);
    },
    onFrame(handler) {
      return inner.onFrame((record) => through(wire, () => handler(record)));
    },
    onClose: (handler) => inner.onClose(handler),
    onError: (handler) => inner.onError(handler),
    close: (reason) => inner.close(reason),
    get info() {
      return inner.info;
    },
    control: (command) => inner.control(command),
  };
}

/** A process a follower talks to over two wires: its requests go out by one, its answers come back by the other. */
function wiredAuthority(authority, out, back) {
  return {
    get state() {
      return authority.state;
    },
    send(message) {
      through(out, () => authority.send(message));
    },
    subscribe(event, handler) {
      if (event === "state") return authority.subscribe("state", handler);
      return authority.subscribe("message", (message) => through(back, () => handler(message)));
    },
  };
}

// ── drawing ─────────────────────────────────────────────────────────────────

function figureSvg(figure, size = "100%") {
  const paint = PAINT[figure.colour];
  const shape = {
    triangle: h("polygon", { points: "50,16 84,82 16,82", fill: paint }),
    diamond: h("polygon", { points: "50,12 86,50 50,88 14,50", fill: paint }),
    circle: h("circle", { cx: 50, cy: 50, r: 34, fill: paint }),
    square: h("rect", { x: 18, y: 18, width: 64, height: 64, rx: 6, fill: paint }),
  }[figure.shape];
  return h("svg", { viewBox: "0 0 100 100", style: { width: size, height: size } }, [shape]);
}

const STYLE = `
/* The page has its own button styling; everything here is scoped and reset first. */
.durable { margin: 0; display: flex; flex-direction: column; gap: 0.9rem; }
.durable button {
  all: unset; box-sizing: border-box; cursor: pointer; display: block;
  font: inherit; color: inherit; background: transparent; border: 0; padding: 0; text-align: inherit;
}
.durable-bar { display: flex; gap: 0.25rem; flex-wrap: wrap; align-items: center; }
.durable .durable-pick {
  width: 44px; height: 44px; padding: 5px;
  border: 1px solid transparent; border-radius: 10px;
}
.durable .durable-pick:hover { border-color: var(--border, #e6ddcc); }
.durable .durable-pick.is-picked { border-color: var(--ink, #24201a); background: var(--surface, #fffcf5); }
.durable-stage { display: flex; flex-direction: column; gap: 0.2rem; }
@media (min-width: 640px) { .durable .durable-stage { flex-direction: row; align-items: stretch; } }
.durable .durable-board {
  flex: 1; border: 1px solid var(--border, #e6ddcc); border-radius: 12px; padding: 0.6rem;
  background: var(--surface, #fffcf5);
}
.durable .durable-name {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted, #857c6e); margin-bottom: 0.45rem;
}
.durable .durable-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; }
.durable .durable-cell {
  aspect-ratio: 1; display: grid; place-items: center;
  border: 1px dashed var(--border, #e6ddcc); border-radius: 10px; padding: 8px;
}
.durable .durable-cell.is-filled { border-style: solid; }

.durable .durable-wires { display: flex; gap: 0.5rem; justify-content: center; align-items: center; padding: 0.6rem 0.2rem; }
.durable .d-wire { position: relative; width: 16px; height: 54px; }
@media (min-width: 640px) { .durable .d-wire { height: auto; align-self: stretch; min-height: 110px; } }
.durable .d-wire::before {
  content: ""; position: absolute; inset: 0 6px; border-radius: 4px; background: var(--border, #e6ddcc);
}
.durable .d-wire.is-slow::before {
  background: repeating-linear-gradient(180deg, #d9a521 0 4px, transparent 4px 9px);
}
.durable .d-wire.is-cut::before {
  background: repeating-linear-gradient(180deg, #d6544a 0 3px, transparent 3px 9px);
}
.durable .d-wire .d-dot {
  position: absolute; left: 50%; margin-left: -6px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--ink, #24201a); opacity: 0;
}
/* One pass per message: the ball reaches the far end exactly as the message does, and repeats while the wire is
   still holding something. */
.durable .d-wire.is-busy .d-dot {
  opacity: 1; animation: d-travel var(--wire-ms, 900ms) linear infinite;
}
.durable .d-wire.is-slow.is-busy .d-dot { background: #d9a521; }
.durable .d-wire.is-cut .d-dot { opacity: 0; }
.durable .d-wire-title {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: -0.9rem;
  font-size: 0.58rem; color: var(--muted, #857c6e); white-space: nowrap; text-transform: none;
}
@keyframes d-travel { from { top: -10px; } to { top: calc(100% + 2px); } }
.durable .d-arrow {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-size: 0.8rem; line-height: 1; color: var(--muted, #857c6e); pointer-events: none;
}
.durable .d-wire.is-cut .d-arrow { color: #d6544a; }
.durable .d-wire.is-leftward .d-dot { animation-name: d-travel-left; }
.durable .d-wire.is-slow .d-arrow { color: #d9a521; }
@keyframes d-travel-left { from { top: calc(100% + 2px); } to { top: -10px; } }
.durable .durable-log {
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

const Authority = makeDurableActor(shapes);
const Deferred = makeDurableProxyActor(shapes);
const Optimistic = makeDurableProxyActor(shapes, { mode: "optimistic" });

/** The widget: one log in the middle, a follower either side, four wires with a direction each. */
export const DurableDemo = {
  name: "DurableDemo",
  setup() {
    /** The boards as they stand: left follower, the log, right follower. */
    const boards = ref([null, null, null]);
    const picked = ref(FIGURES[0]);
    const events = ref([]);
    const ready = ref(false);

    /** Four wires, made once so their switches survive a re-attach.  `toward` says which way a message travels. */
    const wires = {
      leftRecords: makeWire("records", "left"),
      leftRequests: makeWire("requests", "right"),
      rightRecords: makeWire("records", "right"),
      rightRequests: makeWire("requests", "left"),
    };
    let procs = [];

    const say = (line) => {
      events.value = [`${new Date().toLocaleTimeString()}  ${line}`, ...events.value].slice(0, 30);
    };

    const repaint = () => {
      boards.value = procs.map((proc) => proc.state?.state ?? null);
    };

    const log = logChannel([{ type: "CLEAR", at: 0, by: "system" }]);
    let authority = null;
    const watching = new Map();

    const watch = (index, proc) => {
      for (const stop of watching.get(index) ?? []) stop();
      watching.set(index, [
        proc.subscribe("state", repaint),
        proc.subscribe("message", (said) => {
          if (said.type === "RECORD_REJECTED") say(`board ${"L-M-R"[index + 1]}: refused — ${said.reason}`);
        }),
      ]);
      procs[index] = proc;
      repaint();
    };

    /** A follower either side of the log: same spec, its own two wires, and the state where it attaches. */
    const attach = async (index, which, records, requests) => {
      if (procs[index] !== undefined) procs[index].send({ type: "STOP" });
      const proc = await which.spawn(
        {
          authority: wiredAuthority(authority, requests, requests),
          snapshot: authority.state?.state ?? null,
          source: wiredChannel(mirrorChannel(authority, shapes), records),
        },
        { name: index === 0 ? "board-left" : "board-right" },
      );
      await folded(proc);
      watch(index, proc);
      return proc;
    };

    const boot = async () => {
      authority = await Authority.spawn({ source: log }, { name: "board-log" });
      await folded(authority);
      watch(1, authority);
      await attach(0, Deferred, wires.leftRecords, wires.leftRequests);
      await attach(2, Optimistic, wires.rightRecords, wires.rightRequests);
      ready.value = true;
    };

    /** A wire that carries again is a link that came back: the follower behind it is re-attached. */
    const reattach = async (wire) => {
      if (wire === wires.leftRecords || wire === wires.leftRequests) {
        await attach(0, Deferred, wires.leftRecords, wires.leftRequests);
        say("the left follower was re-attached from the state it finds");
      }
      if (wire === wires.rightRecords || wire === wires.rightRequests) {
        await attach(2, Optimistic, wires.rightRecords, wires.rightRequests);
        say("the right follower was re-attached from the state it finds");
      }
    };

    onMounted(async () => {
      injectStyle();
      await boot();
      say("the log is in the middle; a follower either side, one deferring and one guessing");
    });

    /** A click on a box: place the picked figure there, or lift what stands there. */
    const click = (index, cell) => {
      const proc = procs[index];
      if (proc === undefined) return;
      const board = proc.state?.state ?? null;
      const occupied = board !== null && board.cells[cell] !== null;
      proc.send({
        type: "ADD_RECORD",
        requestId: `ask-${Date.now()}-${cell}-${index}`,
        request: {
          by: `board ${"LMR"[index]}`,
          at: Date.now(),
          cell,
          figure: occupied ? null : picked.value,
        },
      });
    };

    /** Carrying → slow → cut → carrying; coming back is a link that returned. */
    const cycle = (wire) => {
      const was = wire.state.value;
      wire.cycle();
      say(`${wire.name} ${wire.toward === "left" ? "←" : "→"}: ${wire.label}`);
      if (was !== "up" && wire.state.value === "up") void reattach(wire);
    };

    const wireEl = (wire) =>
      h(
        "button",
        {
          class: [
            "d-wire",
            wire.state.value === "slow" ? "is-slow" : "",
            wire.state.value === "cut" ? "is-cut" : "",
            wire.busy.value > 0 ? "is-busy" : "",
            wire.toward === "left" ? "is-leftward" : "is-rightward",
          ]
            .filter(Boolean)
            .join(" "),
          title: `${wire.name}, ${wire.toward === "left" ? "to the left" : "to the right"} — ${wire.label}`,
          style: { "--wire-ms": wire.state.value === "slow" ? "1400ms" : "280ms" },
          onClick: () => cycle(wire),
        },
        [
          h("span", { class: "d-dot" }),
          h("span", { class: "d-arrow" }, wire.toward === "left" ? "←" : "→"),
          h("span", { class: "d-wire-title" }, wire.label),
        ],
      );

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

      const board = (name, index) =>
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
                figure === null ? [] : [figureSvg(figure)],
              );
            }),
          ),
        ]);

      return h("div", { class: "durable" }, [
        h("div", { class: "durable-bar" }, palette),
        h("div", { class: "durable-stage" }, [
          board("B — deferred", 0),
          h("div", { class: "durable-wires" }, [wireEl(wires.leftRecords), wireEl(wires.leftRequests)]),
          board("A — the log", 1),
          h("div", { class: "durable-wires" }, [wireEl(wires.rightRecords), wireEl(wires.rightRequests)]),
          board("C — optimistic", 2),
        ]),
        h("pre", { class: "durable-log" }, events.value.join("\n")),
        h(
          "div",
          { style: { color: "var(--muted, #857c6e)", fontSize: "0.84rem" } },
          ready.value
            ? "place a figure in an empty box, click a filled one to lift it; two of a figure clear the board. Click a wire to carry, slow or cut it."
            : "starting…",
        ),
      ]);
    };
  },
};
