(() => {
  const R = {};
  R.moduleLoader = typeof window.__ModuleLoader__;
  R.myCss = document.querySelector('style[data-plugin-css="dshSessionDragMove"]') !== null;
  R.quietFlag = window.__smQuiet === true;

  // count candidate row classes across the whole document
  R.counts = {};
  for (const s of ['.bw-session-row', '.bw-row', '[draggable="true"]', '[role="treeitem"]']) {
    R.counts[s] = document.querySelectorAll(s).length;
  }

  // all distinct classes on elements that look like sidebar rows
  const cls = {};
  document.querySelectorAll('div,li').forEach(el => {
    const c = String(el.className || '');
    if (!c || c.indexOf('bw') < 0) return;
    for (const x of el.classList) cls[x] = (cls[x] || 0) + 1;
  });
  R.bwClasses = cls;

  // what does the sidebar aside contain?
  const aside = document.querySelector('aside') || document.querySelector('[class*="bw-"]');
  R.asideFound = !!aside;
  if (aside) {
    R.asideClass = String(aside.className).slice(0, 120);
    const firstRows = Array.from(aside.querySelectorAll('div')).slice(0, 6).map(el => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 90),
      draggable: el.getAttribute('draggable'),
      role: el.getAttribute('role'),
      text: (el.textContent || '').trim().slice(0, 30),
      fiberKeys: Object.keys(el).filter(k => k.startsWith('__react')).slice(0, 3)
    }));
    R.firstRows = firstRows;
  }

  // any element carrying a session id in its React props?
  let fiberSample = null;
  const all = document.querySelectorAll('div');
  for (const el of all) {
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (!fk) continue;
    const p = el[fk] && el[fk].memoizedProps;
    if (p && (p.node || p.workspace || p.session)) {
      fiberSample = {
        cls: String(el.className).slice(0, 90),
        propKeys: Object.keys(p).slice(0, 30),
        hasNode: !!p.node,
        nodeId: p.node && p.node.id ? p.node.id : null,
        hasWorkspace: !!p.workspace,
        workspaceId: p.workspace && p.workspace.workspaceId ? p.workspace.workspaceId : null,
        hasSession: !!p.session,
        sessionId: p.session && p.session.id ? p.session.id : null
      };
      break;
    }
  }
  R.fiberSample = fiberSample;

  console.log('=== PROBE RESULT ===');
  console.log(JSON.stringify(R, null, 2));
  window.__smProbe = R;
  return R;
})()
