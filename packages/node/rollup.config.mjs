import { builtinModules } from "node:module";

import { readerConfig } from "../../rollup.reader.mjs";

// Only the node adapter may reach for node builtins (R4).
export default readerConfig({
  browser: false,
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
});
