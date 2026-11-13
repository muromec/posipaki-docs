// ── the durable-actor widget ────────────────────────────────────────────────
//
// Three 2×2 boards: the first owns the log, the second follows it and defers, the third follows the second and
// guesses.  The channels between them can be cut, which is what makes the shape visible.
//
// The shipped implementation is `posipaki-durable-actor` (in the email-agent repository, not yet published), and
// this widget runs a copy of the same four words: filter, map, reduce, diff.  It is copied rather than imported
// because this docs tree pins a posipaki that predates `posipaki/port`, which the package needs at run time.

import { h, ref, onMounted } from "vue";

// ── the pattern, inlined ────────────────────────────────────────────────────

/** A log, as a channel: what is sent is appended and handed to every reader of it. */
function logChannel(initial = []) {
  const records = [...initial];
  const readers = new Set();
  return {
    async send(record) {
      records.push(record);
      for (const reader of readers) reader(record);
    },
    onFrame(handler) {
      for (const record of records) handler(record);
      readers.add(handler);
      return () => readers.delete(handler);
    },
    close() {},
    get info() {
      return { records: records.length };
    },
  };
}

/** A record channel derived from a process's state: one record per change, said by `diff`. */
function mirrorChannel(authority, spec) {
  const readers = new Set();
  let known = null;
  authority.subscribe("state", () => {
    const now = authority.state ?? null;
    if (now === null || JSON.stringify(now) === JSON.stringify(known)) return;
    const record = spec.diff(known, now);
    known = now;
    for (const reader of readers) reader(record);
  });
  return {
    async send() {
      throw new Error("this channel is the authority's");
    },
    onFrame(handler) {
      known = authority.state ?? null;
      readers.add(handler);
      return () => readers.delete(handler);
    },
    close() {},
    get info() {
      return { authority: authority.name };
    },
  };
}

/** An authoritative process: it owns the log, so it may write what it filters. */
function authoritative(spec, source, name) {
  const answerers = new Set();
  const stateListeners = new Set();
  const awaiting = new Map();
  let state = null;

  source.onFrame((record) => {
    try {
      state = spec.reduce(state, record);
    } catch {
      return;
    }
    for (const listener of stateListeners) listener();
    const key = JSON.stringify(record);
    const id = awaiting.get(key);
    if (id === undefined) return;
    awaiting.delete(key);
    for (const answerer of answerers) answerer({ type: "ACCEPTED", requestId: id });
  });

  return {
    name,
    get state() {
      return state;
    },
    subscribe(event, handler) {
      const set = event === "state" ? stateListeners : answerers;
      set.add(handler);
      return () => set.delete(handler);
    },
    send(message) {
      if (message.type !== "ASK" || state === null) return;
      const verdict = spec.filter(state, message.request);
      if ("refuse" in verdict) {
        for (const answerer of answerers) {
          answerer({ type: "REJECTED", requestId: message.requestId, reason: verdict.refuse });
        }
        return;
      }
      const record = spec.map(state, verdict.pass);
      awaiting.set(JSON.stringify(record), message.requestId);
      void source.send(record);
    },
  };
}

/** A process that follows another: it reduces the records it is told, and hands requests over. */
function follower(spec, authority, source, name, mode) {
  const answerers = new Set();
  const stateListeners = new Set();
  const asking = new Map();
  const guessing = new Map();
  const guessed = new Set();
  let state = authority.state ?? null;
  let next = 1;

  const publish = () => {
    for (const listener of stateListeners) listener();
  };
  const answer = (message) => {
    for (const answerer of answerers) answerer(message);
  };

  source.onFrame((record) => {
    const key = JSON.stringify(record);
    if (guessed.has(key)) {
      guessed.delete(key);
      return;
    }
    state = spec.reduce(state, record);
    publish();
  });

  authority.subscribe("message", (said) => {
    const guess = guessing.get(said.requestId);
    if (guess !== undefined) {
      guessing.delete(said.requestId);
      if (said.type === "ACCEPTED") return;
      // A guess the authority refused: back to what it was, and the caller is told it was only a guess.
      state = guess.before;
      publish();
      guessed.delete(JSON.stringify(guess.record));
      answer({ type: "FAILED", requestId: guess.callerId, reason: `rolled back: ${said.reason}` });
      return;
    }
    const callerId = asking.get(said.requestId);
    if (callerId === undefined) return;
    asking.delete(said.requestId);
    answer({ ...said, requestId: callerId });
  });

  return {
    name,
    get state() {
      return state;
    },
    subscribe(event, handler) {
      const set = event === "state" ? stateListeners : answerers;
      set.add(handler);
      return () => set.delete(handler);
    },
    send(message) {
      if (message.type !== "ASK") return;
      const own = `p-${next++}`;
      if (mode === "optimistic" && state !== null) {
        const verdict = spec.filter(state, message.request);
        if ("refuse" in verdict) {
          answer({ type: "REJECTED", requestId: message.requestId, reason: verdict.refuse });
          return;
        }
        const record = spec.map(state, verdict.pass);
        const before = state;
        state = spec.reduce(state, record);
        publish();
        answer({ type: "ACCEPTED", requestId: message.requestId });
        guessed.add(JSON.stringify(record));
        guessing.set(own, { callerId: message.requestId, record, before });
      } else {
        asking.set(own, message.requestId);
      }
      authority.send({ type: "ASK", requestId: own, request: message.request });
    },
  };
}

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
      close() {},
      get info() {
        return inner.info;
      },
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

// ── the board ───────────────────────────────────────────────────────────────

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
    return { pass: { ...ask, at: Date.now() } };
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

    const say = (line) => {
      events.value = [`${new Date().toLocaleTimeString()}  ${line}`, ...events.value].slice(0, 30);
    };

    const repaint = () => {
      boards.value = procs.map((proc) => proc.state ?? null);
    };

    /** Build the three processes over a fresh log: the log, a deferred follower, an optimistic one. */
    const build = () => {
      const log = logChannel([{ type: "CLEAR", at: 0, by: "system" }]);
      const a = authoritative(shapes, log, "board-a");
      const ab = gateChannel(mirrorChannel(a, shapes));
      const b = follower(shapes, a, ab.channel, "board-b", "deferred");
      const bc = gateChannel(mirrorChannel(b, shapes));
      const c = follower(shapes, b, bc.channel, "board-c", "optimistic");

      procs = [a, b, c];
      gates = [ab, bc];
      cuts.value = [false, false];
      procs.forEach((proc, index) => {
        proc.subscribe("state", repaint);
        proc.subscribe("message", (said) => {
          if (said.type === "REJECTED") say(`board ${"ABC"[index]}: refused — ${said.reason}`);
          if (said.type === "FAILED") say(`board ${"ABC"[index]}: ${said.reason}`);
        });
      });
      repaint();
      ready.value = true;
    };

    onMounted(() => {
      injectStyle();
      build();
      say("three boards: A owns the log, B defers to it, C guesses");
    });

    /** A click on a box: place the picked figure there, or lift what stands there. */
    const click = (index, cell) => {
      const proc = procs[index];
      if (proc === undefined) return;
      const board = proc.state;
      const occupied = board !== null && board.cells[cell] !== null;
      proc.send({
        type: "ASK",
        requestId: `ask-${Date.now()}-${cell}-${index}`,
        request: { by: `board ${"ABC"[index]}`, cell, figure: occupied ? null : picked.value },
      });
    };

    const cut = (index) => {
      const gate = gates[index];
      if (gate === undefined) return;
      if (gate.cutNow) {
        gate.heal();
        cuts.value = cuts.value.map((value, at) => (at === index ? false : value));
        say(`${["A→B", "B→C"][index]} healed — the boards are re-attached from the state they find`);
        build();
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
