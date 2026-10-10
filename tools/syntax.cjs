const fs=require("fs"),vm=require("vm");
for (const f of ["lib/index.js","lib/session-log.js","lib/client.js"]) {
  const src=fs.readFileSync(f,"utf8");
  try { new vm.SourceTextModule(src); console.log("OK   "+f); }
  catch(e){ console.log("FAIL "+f+" :: "+e.message); }
}
// client.js must actually register through the module loader contract
global.window={__ModuleLoader__:{load(m){ if(typeof m.factory!=="function") throw new Error("no factory");
  const p=m.factory(()=>({})); if(p.name!=="dsh-session-drag-move") throw new Error("bad name:"+p.name);
  if(typeof p.apply!=="function") throw new Error("no apply"); console.log("OK   client contract -> "+p.name+" inject="+JSON.stringify(p.inject)); }}};
vm.runInThisContext(fs.readFileSync("lib/client.js","utf8"));
