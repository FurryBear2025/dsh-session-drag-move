const { createRequire } = require("node:module");
const req = createRequire("C:/Users/Admin/.dsh/profiles/desktop/package.json");
for (const spec of ["dsh-session-drag-move", "dsh-session-drag-move/client", "dsh-session-drag-move/package.json"]) {
  try { console.log("OK   " + spec + " -> " + req.resolve(spec)); }
  catch (e) { console.log("FAIL " + spec + " :: " + e.code); }
}
