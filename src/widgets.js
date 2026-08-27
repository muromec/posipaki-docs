import { h, ref, defineComponent } from "vue";

const Counter = defineComponent({
  setup() {
    const count = ref(0);
    return () =>
      h("div", { class: "demo-widget" }, [
        h("p", `count: ${count.value}`),
        h("button", { onClick: () => count.value++ }, "POKE"),
      ]);
  },
});

export const widgets = { counter: Counter };
