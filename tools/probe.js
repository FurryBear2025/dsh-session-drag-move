/* dsh-session-drag-move 运行时探针
 *
 * 用法：
 *   1) 在 DSH 窗口按 Ctrl+Shift+I 打开 DevTools，切到 Console
 *   2) 打开 tools/probe.js，全选复制，粘贴进 Console，回车
 *   3) 把打印出来的整段内容发回
 *
 * 它只读取 DOM / React 内部结构并打印，不修改任何东西。
 */
(() => {
  const out = [];
  const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); out.push(s); console.log('[probe]', ...a); };

  log('== 1. 环境 ==');
  log('__ModuleLoader__:', typeof window.__ModuleLoader__);
  log('__DSH_BOOT__:', typeof window.__DSH_BOOT__);
  log('my css injected:', document.querySelector('style[data-plugin-css="dshSessionDragMove"]') !== null);
  log('all plugin css tags:', Array.from(document.querySelectorAll('style[data-plugin-css]')).map(s => s.getAttribute('data-plugin-css')).slice(0, 40));

  log('== 2. 候选行 ==');
  const counts = {};
  for (const sel of ['.bw-session-row', '.bw-row', '[draggable="true"]', '[role="treeitem"]']) {
    counts[sel] = document.querySelectorAll(sel).length;
  }
  log('counts:', counts);

  log('== 3. class 名统计（找会话行真身）==');
  const classHits = {};
  document.querySelectorAll('div,li,button,a').forEach(el => {
    if (el.getAttribute && el.getAttribute('draggable') === 'true') {
      for (const c of el.classList || []) classHits[c] = (classHits[c] || 0) + 1;
    }
  });
  log('classes on draggable elements:', classHits);

  function fiberKeys(el) {
    return Object.keys(el).filter(k => k.startsWith('__react'));
  }

  function describe(el, label) {
    if (!el) { log(label, '-> null'); return; }
    const fk = fiberKeys(el);
    const line = { label, tag: el.tagName, cls: el.className, draggable: el.getAttribute('draggable'), role: el.getAttribute('role'), fiberKeys: fk };
    log(label, JSON.stringify(line));
    for (const k of fk) {
      const v = el[k];
      if (k.startsWith('__reactFiber$') && v && v.memoizedProps) {
        const p = v.memoizedProps;
        log('   props keys:', Object.keys(p).slice(0, 40));
        if (p.node) log('   node keys:', typeof p.node === 'object' ? Object.keys(p.node).slice(0, 40) : String(p.node));
        if (p.node && p.node.id) log('   node.id:', p.node.id);
        if (p.workspace) log('   workspace keys:', typeof p.workspace === 'object' ? Object.keys(p.workspace).slice(0, 40) : String(p.workspace));
        if (p.workspace && p.workspace.workspaceId) log('   workspace.workspaceId:', p.workspace.workspaceId);
        if (p.session) log('   session.id:', p.session && p.session.id);
        if (p.id) log('   props.id:', p.id);
      }
      if (k.startsWith('__reactProps$') && v) {
        log('   reactProps keys:', Object.keys(v).slice(0, 40));
        if (v.node && v.node.id) log('   reactProps.node.id:', v.node.id);
        if (v.workspace && v.workspace.workspaceId) log('   reactProps.workspace.workspaceId:', v.workspace.workspaceId);
      }
    }
  }

  log('== 4. 详查第一个 .bw-session-row ==');
  describe(document.querySelector('.bw-session-row'), 'sessionRow[0]');

  log('== 5. 详查第一个 .bw-row（可能是工作区头）==');
  const rows = Array.from(document.querySelectorAll('.bw-row')).filter(r => !r.classList.contains('bw-session-row'));
  describe(rows[0], 'workspaceRowCandidate[0]');

  log('== 6. 第一个 draggable 元素 ==');
  describe(document.querySelector('[draggable="true"]'), 'draggable[0]');

  log('== 7. 疑似左侧栏容器结构（前 400 字符 outerHTML）==');
  const aside = document.querySelector('aside') || document.querySelector('[class*="sidebar"]') || document.querySelector('[class*="bw-"]');
  if (aside) log((aside.outerHTML || '').slice(0, 400));

  window.__smProbeResult = out.join('\n');
  console.log('[probe] 已保存到 window.__smProbeResult，可执行 copy(window.__smProbeResult) 复制');
})();
