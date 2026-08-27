import { createApp } from "vue";
import { widgets } from "./widgets.js";

for (const el of document.querySelectorAll("[data-demo]")) {
  const widget = widgets[el.dataset.demo];
  if (widget) createApp(widget).mount(el);
}
