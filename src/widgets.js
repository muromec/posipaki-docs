import { h, ref, onMounted, onBeforeUnmount, defineComponent } from "vue";
import { defineActor } from "posipaki";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each message type sleeps for a different length — slower = longer pause.
const COLORS = {
  RED: { hex: "#d6544a", delay: 1500, label: "1.5s" },
  GREEN: { hex: "#4fae6a", delay: 900, label: "0.9s" },
  BLUE: { hex: "#4a82c9", delay: 450, label: "0.45s" },
};

const CODE_LINES = [
  { text: "handlers: {", color: null },
  { text: "  RED:   async () => { await sleep(1500); },", color: "RED" },
  { text: "  GREEN: async () => { await sleep(900);  },", color: "GREEN" },
  { text: "  BLUE:  async () => { await sleep(450);  },", color: "BLUE" },
  { text: "},", color: null },
];

const STYLE = `
.race-demo { margin: 0; }
.race-btns { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 1rem; }
.race-btn {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.85rem;
  border: 1px solid var(--border, #e6ddcc); border-radius: 999px;
  background: var(--surface, #fffcf5); color: var(--ink, #24201a);
  font-weight: 600; font-size: 0.9rem; cursor: pointer;
  transition: transform 0.08s ease, box-shadow 0.08s ease;
}
.race-btn:hover { transform: translateY(-1px); box-shadow: 0 2px 10px rgba(36,32,26,0.14); }
.race-btn:active { transform: translateY(0); }
.race-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.race-delay { color: var(--muted, #857c6e); font-weight: 500; font-size: 0.8rem; }
.race-tunnel { width: 100%; height: auto; display: block; }
.race-label { font-size: 10px; fill: var(--muted, #857c6e); }
.race-code {
  margin-top: 1rem; padding: 0.75rem 0.9rem;
  background: var(--code-bg, #2b251d); border-radius: 10px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.82rem; color: var(--code-ink, #f5efe3); line-height: 1.7;
  overflow-x: auto;
}
.race-line { display: block; padding: 0 0.45rem; border-radius: 6px; white-space: pre; transition: background 0.12s ease; }
.race-status { margin-top: 0.75rem; color: var(--muted, #857c6e); font-size: 0.88rem; font-variant-numeric: tabular-nums; }
`;

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const el = document.createElement("style");
  el.id = "race-demo-style";
  el.textContent = STYLE;
  document.head.appendChild(el);
}

const TUNNEL_START = 68;
const TUNNEL_END = 612;

const RaceDemo = defineComponent({
  setup() {
    injectStyle();

    const activeColor = ref(null);
    const progress = ref(0);
    const pending = ref([]);
    let proc = null;
    let rafId = null;
    let startedAt = 0;

    const spawn = async () => {
      if (proc) return;
      const actor = defineActor({
        setup: () => ({}),
        handlers: {
          async RED() {
            this.emit({ type: "STARTED", color: "RED" });
            await sleep(COLORS.RED.delay);
            this.emit({ type: "FINISHED", color: "RED" });
          },
          async GREEN() {
            this.emit({ type: "STARTED", color: "GREEN" });
            await sleep(COLORS.GREEN.delay);
            this.emit({ type: "FINISHED", color: "GREEN" });
          },
          async BLUE() {
            this.emit({ type: "STARTED", color: "BLUE" });
            await sleep(COLORS.BLUE.delay);
            this.emit({ type: "FINISHED", color: "BLUE" });
          },
        },
      });

      proc = await actor.spawn(null, {
        toParent: (msg) => {
          if (msg.type === "STARTED") {
            if (pending.value[0] === msg.color) pending.value.shift();
            activeColor.value = msg.color;
            progress.value = 0;
            startedAt = performance.now();
            cancelAnimationFrame(rafId);
            const tick = (now) => {
              progress.value = Math.min(1, (now - startedAt) / COLORS[msg.color].delay);
              if (progress.value < 1) rafId = requestAnimationFrame(tick);
            };
            rafId = requestAnimationFrame(tick);
          } else if (msg.type === "FINISHED") {
            cancelAnimationFrame(rafId);
            activeColor.value = null;
            progress.value = 0;
          }
        },
      });
    };

    const send = async (color) => {
      await spawn();
      pending.value.push(color);
      proc.send({ type: color });
    };

    onMounted(spawn);
    onBeforeUnmount(() => cancelAnimationFrame(rafId));

    return () => {
      const cx = () =>
        activeColor.value
          ? TUNNEL_START + progress.value * (TUNNEL_END - TUNNEL_START)
          : 0;

      const buttons = Object.entries(COLORS).map(([key, c]) =>
        h("button", { class: "race-btn", onClick: () => send(key) }, [
          h("span", { class: "race-dot", style: { background: c.hex } }),
          h("span", { class: "race-name" }, key),
          h("span", { class: "race-delay" }, c.label),
        ])
      );

      const svg = h("svg", { class: "race-tunnel", viewBox: "0 0 660 80", "aria-label": "message processing tunnel" }, [
        h("rect", { x: 60, y: 28, width: 560, height: 24, rx: 12, fill: "#2b251d", stroke: "#3a332a", "stroke-width": 1 }),
        h("rect", { x: 66, y: 34, width: 548, height: 12, rx: 6, fill: "rgba(0,0,0,0.28)" }),
        h("text", { x: 58, y: 20, class: "race-label", "text-anchor": "middle" }, "in"),
        h("text", { x: 622, y: 20, class: "race-label", "text-anchor": "middle" }, "out"),
        ...pending.value.map((key, i) =>
          h("circle", { cx: 50 - i * 14, cy: 40, r: 6, fill: COLORS[key].hex, opacity: 0.85 })
        ),
        ...(activeColor.value
          ? [
              h("line", {
                x1: cx() - 42, y1: 40, x2: cx() - 6, y2: 40,
                stroke: COLORS[activeColor.value].hex, "stroke-width": 5,
                "stroke-linecap": "round", opacity: 0.35,
              }),
              h("circle", { cx: cx(), cy: 40, r: 14, fill: COLORS[activeColor.value].hex, opacity: 0.25 }),
              h("circle", { cx: cx(), cy: 40, r: 8, fill: COLORS[activeColor.value].hex }),
            ]
          : []),
      ]);

      const code = h("div", { class: "race-code" }, CODE_LINES.map((line) => {
        const isActive = line.color !== null && line.color === activeColor.value;
        return h("span", {
          class: "race-line" + (isActive ? " is-active" : ""),
          style: isActive ? { background: COLORS[line.color].hex + "44", color: "#ffffff" } : {},
        }, line.text);
      }));

      const status = h("div", { class: "race-status" },
        activeColor.value
          ? `processing ${activeColor.value}\u2026 (${COLORS[activeColor.value].label})`
          : pending.value.length
            ? `${pending.value.length} queued`
            : "idle \u2014 press a button");

      return h("div", { class: "race-demo" }, [
        h("div", { class: "race-btns" }, buttons),
        svg,
        code,
        status,
      ]);
    };
  },
});

export const widgets = { race: RaceDemo };
