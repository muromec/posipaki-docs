import { build } from "czaczanka";

const pages = await build({
  name: "posipaki",
  clientEntry: "src/client.js",
});

console.log(`built ${pages.length} page(s) → dist`);
