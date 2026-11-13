// ── the durable-actor widget ────────────────────────────────────────────────
//
// One log in the middle with a follower either side — one deferring, one guessing — and four wires: records out
// from the middle to each follower, requests in from each follower to the middle.  Laid out in a row the wires
// run across the top and bottom; stacked, they run down the sides.
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
    // From nothing: one PLACE per figure that stands — and a CLEAR when none does, because a follower has to hear
    // something to know the source has spoken.
    if (before === null) {
      const places = after.cells.flatMap((figure, cell) =>
        figure === null ? [] : [{ type: "PLACE", at: after.at, by: after.by, cell, figure }],
      );
      return places.length === 0 ? [{ type: "CLEAR", at: after.at, by: after.by }] : places;
    }
    const empty = after.cells.every((cell) => cell === null);
    const was = before.cells.some((cell) => cell !== null);
    if (empty && was) return [{ type: "CLEAR", at: after.at, by: after.by }];
    for (let cell = 0; cell < CELLS; cell += 1) {
      const had = before.cells[cell] ?? null;
      const has = after.cells[cell] ?? null;
      if (had === null && has !== null) {
        return [{ type: "PLACE", at: after.at, by: after.by, cell, figure: has }];
      }
      if (had !== null && has === null) return [{ type: "LIFT", at: after.at, by: after.by, cell }];
    }
    return [{ type: "CLEAR", at: after.at, by: after.by }];
  },
};

// ── the wires ───────────────────────────────────────────────────────────────

/** How long a slowed wire holds a message. */
const SLOW_MS = 1400;
/** How long a carrying wire shows that something went through it, so a fast hop is still visible. */
const FLASH_MS = 280;

/** One wire: whether it carries, how much is inside it, and which way a message goes. */
function makeWire(name, toward) {
  const state = ref("up");
  const busy = ref(0);
  return {
    name,
    toward,
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

/** A process a follower talks to over a wire: its requests go out and its answers come back over it. */
function wiredAuthority(authority, wire) {
  return {
    get state() {
      return authority.state;
    },
    send(message) {
      through(wire, () => authority.send(message));
    },
    subscribe(event, handler) {
      if (event === "state") return authority.subscribe("state", handler);
      return authority.subscribe("message", (message) => through(wire, () => handler(message)));
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
.durable { margin: 0; display: flex; flex-direction: column; gap: 0.9rem; }
.durable button { all: unset; box-sizing: border-box; cursor: pointer; font: inherit; color: inherit;
  background: transparent; border: 0; padding: 0; }
.durable-bar { display: flex; gap: 0.25rem; flex-wrap: wrap; align-items: center; }
.durable .durable-pick { width: 44px; height: 44px; padding: 5px; border: 1px solid transparent; border-radius: 10px; }
.durable .durable-pick:hover { border-color: var(--border, #e6ddcc); }
.durable .durable-pick.is-picked { border-color: var(--ink, #24201a); background: var(--surface, #fffcf5); }

/* The stage: the boards, and the pipes around them.  In a row the pipes run across the top and bottom; stacked,
   they run down the sides.  Each pipe is two halves meeting at the middle board, and each half is its own wire. */
.durable .durable-stage { position: relative; display: flex; flex-direction: column; gap: 0.35rem; padding: 26px 0; }
@media (min-width: 640px) { .durable .durable-stage { flex-direction: row; align-items: stretch; } }
.durable .durable-lines { position: absolute; inset: 0; pointer-events: none; }
.durable .d-line { position: absolute; pointer-events: auto; width: 50%; height: 10px; }
.durable .d-line::before {
  content: ""; position: absolute; inset: 3px 0; border-radius: 3px; background: var(--border, #e6ddcc);
}
.durable .d-line.records { top: 0; }
.durable .d-line.requests { bottom: 0; }
.durable .d-line.left { left: 0; }
/* A gap where the two halves meet, so a pipe reads as two wires and not one. */
.durable .d-line.left::before { border-radius: 3px 0 0 3px; right: 6px; }
.durable .d-line.right::before { border-radius: 0 3px 3px 0; left: 6px; }
.durable .d-line.right { left: 50%; }
.durable .d-line.is-slow::before {
  background: repeating-linear-gradient(90deg, #d9a521 0 5px, transparent 5px 10px);
}
.durable .d-line.is-cut::before {
  background: repeating-linear-gradient(90deg, #d6544a 0 4px, transparent 4px 10px);
}
.durable .d-line .d-dot {
  position: absolute; top: 50%; left: 0; width: 10px; height: 10px; margin-top: -5px;
  border-radius: 50%; background: var(--ink, #24201a); opacity: 0;
}
.durable .d-line.is-busy .d-dot { opacity: 1; animation: d-line-x var(--wire-ms, 900ms) linear infinite; }
.durable .d-line.is-reverse .d-dot { animation-direction: reverse; }
.durable .d-line.is-slow.is-busy .d-dot { background: #d9a521; }
.durable .d-line.is-cut .d-dot { opacity: 0; }
@keyframes d-line-x { from { left: 0; } to { left: calc(100% - 10px); } }

@media (max-width: 639px) {
  .durable .durable-stage { padding: 0 26px; }
  .durable .d-line { width: 10px; height: 50%; }
  .durable .d-line::before { inset: 0 3px; }
  .durable .d-line.records { top: 0; bottom: auto; }
  .durable .d-line.requests { bottom: 0; top: auto; }
  .durable .d-line.left { left: 0; }
  .durable .d-line.right { left: auto; right: 0; }
  /* Stacked: the halves meet top-to-bottom, so the gap is vertical. */
  .durable .d-line.left::before { right: 0; bottom: 6px; border-radius: 3px 3px 0 0; }
  .durable .d-line.right::before { left: 0; top: 6px; border-radius: 0 0 3px 3px; }
  .durable .d-line.is-slow::before {
    background: repeating-linear-gradient(180deg, #d9a521 0 5px, transparent 5px 10px);
  }
  .durable .d-line.is-cut::before {
    background: repeating-linear-gradient(180deg, #d6544a 0 4px, transparent 4px 10px);
  }
  .durable .d-line .d-dot { left: 50%; top: 0; margin: 0 0 0 -5px; }
  .durable .d-line.is-busy .d-dot { animation-name: d-line-y; }
  @keyframes d-line-y { from { top: 0; } to { top: calc(100% - 10px); } }
}

/* The arrow sits at the far end of its half: the end the message is travelling to. */
.durable .d-lines-hint {
  position: absolute; right: 0; top: -1.5rem; pointer-events: none;
  font-size: 0.7rem; color: var(--muted, #857c6e);
}
@media (max-width: 639px) { .durable .d-lines-hint { top: auto; bottom: -1.5rem; right: auto; left: 0; } }
.durable .d-line-arrow {
  position: absolute; right: 12%; top: 50%; transform: translate(50%, -50%);
  font-size: 0.8rem; line-height: 1; color: var(--muted, #857c6e);
}
.durable .d-line.is-reverse .d-line-arrow { right: auto; left: 12%; transform: translate(-50%, -50%); }
.durable .d-line-title {
  position: absolute; font-size: 0.58rem; white-space: nowrap; opacity: 0;
  transition: opacity 0.15s ease; color: var(--muted, #857c6e);
}
.durable .d-line.records .d-line-title { top: -0.8rem; left: 0.2rem; }
.durable .d-line.requests .d-line-title { bottom: -0.8rem; left: 0.2rem; }
.durable .d-line.is-slow .d-line-title, .durable .d-line.is-cut .d-line-title { opacity: 1; }
.durable .d-line.is-slow .d-line-title, .durable .d-line.is-slow .d-line-arrow { color: #d9a521; }
.durable .d-line.is-cut .d-line-title, .durable .d-line.is-cut .d-line-arrow { color: #d6544a; }

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
  aspect-ratio: 1; display: grid; place-items: center; padding: 8px;
  border: 1px dashed var(--border, #e6ddcc); border-radius: 10px;
}
.durable .durable-cell.is-filled { border-style: solid; }
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

    /** Four wires.  `toward` is the direction a message travels along the pipe. */
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
          if (said.type === "RECORD_REJECTED") say(`board ${"LMR"[index]}: refused — ${said.reason}`);
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
          authority: wiredAuthority(authority, requests),
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

    /** One half of one pipe. */
    const wireEl = (wire, kind, side) =>
      h(
        "button",
        {
          class: [
            "d-line",
            kind,
            side,
            wire.state.value === "slow" ? "is-slow" : "",
            wire.state.value === "cut" ? "is-cut" : "",
            wire.busy.value > 0 ? "is-busy" : "",
            wire.toward === "left" ? "is-reverse" : "",
          ]
            .filter(Boolean)
            .join(" "),
          title: `${wire.name}, ${wire.toward === "left" ? "to the left" : "to the right"} — ${wire.label}`,
          style: { "--wire-ms": wire.state.value === "slow" ? "1400ms" : "280ms" },
          onClick: () => cycle(wire),
        },
        [
          h("span", { class: "d-dot" }),
          h("span", { class: "d-line-arrow" }, wire.toward === "left" ? "←" : "→"),
          h("span", { class: "d-line-title" }, wire.label),
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
          h("div", { class: "d-lines-hint" }, "click a wire: carrying → slow → cut"),
          h("div", { class: "durable-lines" }, [
            wireEl(wires.leftRecords, "records", "left"),
            wireEl(wires.leftRequests, "requests", "left"),
            wireEl(wires.rightRecords, "records", "right"),
            wireEl(wires.rightRequests, "requests", "right"),
          ]),
          board("B — deferred", 0),
          board("A — the log", 1),
          board("C — optimistic", 2),
        ]),
        h("pre", { class: "durable-log" }, events.value.join("\n")),
        h(
          "div",
          { style: { color: "var(--muted, #857c6e)", fontSize: "0.84rem" } },
          ready.value
            ? "pick a figure, then click a box to place it there. To clear a box, click it again. Two of one figure clear the whole board. Click a wire to carry, slow or cut it."
            : "starting…",
        ),
      ]);
    };
  },
};
