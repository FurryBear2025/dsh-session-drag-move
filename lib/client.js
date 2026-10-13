/**
 * dsh-session-drag-move — client half (plain JavaScript, no build step).
 *
 * The shipped workspace browser (`dsh-better-workspace`) only handles drags
 * INSIDE one workspace: its onDrop acts only when the drag's workspace id
 * equals the group's key, and cross-workspace drops are ignored. So a
 * cross-workspace drag never rewrites the session's stored cwd — the session
 * never really changes owner, the file-write path stays the same.
 *
 * This half intercepts ONLY the cross-workspace case — in the CAPTURE phase,
 * ahead of React's delegated handlers — and asks the host half to re-home the
 * session (rewrite header cwd + move the log dir). Same-workspace drags are
 * deliberately left completely alone so official ordering keeps working.
 *
 * Row recognition uses the REAL DOM contract of `dsh-better-workspace`:
 *   - session rows have the class `.bw-session-row`
 *   - workspace header rows have `.bw-row` but NOT `.bw-session-row`
 *   - the session id lives in the row's React props as `node.id`
 *   - the workspace id lives in the header row's React props as
 *     `workspace.workspaceId`
 *   - `dsh-better-workspace` also writes the session id into the drag
 *     dataTransfer (`text/plain`), which we use as a fallback source.
 *
 * Every DOM inspection is wrapped so a failure degrades to "do nothing" rather
 * than throwing (a thrown capture listener must never break native dragging).
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-drag-move',
  factory: (_require) => {
    const NS = 'dshSessionDragMove'
    const API = '/session-drag-move/api/'

    const CSS = `
[data-dsh-sm-dragging] { opacity: .45; }
[data-dsh-sm-target] {
  outline: 2px dashed var(--dsh-accent, #4c8dff) !important;
  outline-offset: -2px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsh-accent, #4c8dff) 12%, transparent);
}
/* Self-drawn highlight: works from coordinates alone, so it does not depend on
   which element the browser reports as the drag target. */
.${NS}-hl {
  position: fixed; pointer-events: none; z-index: 2147482999;
  border: 2px dashed var(--dsh-accent, #4c8dff);
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsh-accent, #4c8dff) 14%, transparent);
  box-sizing: border-box;
  display: none;
}
.${NS}-hl-on { display: block; }
.${NS}-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483000; max-width: 78vw;
  padding: 8px 14px; border-radius: 8px;
  background: rgba(28,28,30,.94); color: #fff;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.28);
}
/* Long-move progress card: replaces the toast while a job runs. */
.${NS}-prog {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483000; min-width: 280px; max-width: 78vw;
  padding: 10px 14px 12px; border-radius: 10px;
  background: rgba(28,28,30,.96); color: #fff;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 8px 28px rgba(0,0,0,.34);
}
.${NS}-prog-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.${NS}-prog-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${NS}-prog-pct { flex: none; font-variant-numeric: tabular-nums; color: #b8b8b8; }
.${NS}-prog-track {
  height: 6px; border-radius: 999px; overflow: hidden;
  background: rgba(255,255,255,.14);
}
.${NS}-prog-fill {
  height: 100%; width: 0%;
  background: linear-gradient(90deg, #4c8dff, #6aa9ff);
  transition: width .18s ease-out;
}
.${NS}-prog-indet .${NS}-prog-fill {
  width: 35% !important;
  animation: ${NS}-indet 1.1s ease-in-out infinite;
}
@keyframes ${NS}-indet {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.${NS}-prog-sub {
  margin-top: 6px; color: #8a8a8a; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${NS}-prog-done .${NS}-prog-fill { background: #3fb950; }
.${NS}-prog-fail .${NS}-prog-fill { background: #e5484d; }
.${NS}-prog-fail .${NS}-prog-title { color: #ff9b9e; }
`

    const DIAG = (typeof location !== 'undefined' && /[?&]smdiag=1\b/.test(location.search))

    /* --------------------------- DOM helpers ---------------------------- */

    const isElement = (el) => typeof Element !== 'undefined' && el instanceof Element
    const closestSel = (el, sel) => (isElement(el) ? el.closest(sel) : null)

    /**
     * Row recognition.
     *
     * PRIMARY CONTRACT: `data-row-key`, written straight onto the DOM by
     * `dsh-better-workspace`. Session rows carry `session:<sessionId>`, and
     * workspace header rows carry `workspace:<workspaceId>`. This attribute
     * survives every rebuild and needs no React introspection, so it is the
     * contract we trust first.
     *
     * FALLBACK: the stylesheet is a CSS-Modules build, so the readable class
     * names from the source (`bw-session-row`) are HASHED at build time into
     * things like `hIlkoa_sessionRow`. The hashed name still keeps the
     * semantic `_sessionRow` suffix, which is what we match on when the
     * attribute is absent (an older/other host build).
     */
    const SESSION_SUFFIXES = ['_sessionrow', '_session-row', 'sessionrow']

    const ROW_KEY_ATTR = 'data-row-key'
    const SESSION_KEY_PREFIX = 'session:'
    const WORKSPACE_KEY_PREFIX = 'workspace:'

    function rowKeyOf(el) {
      if (!isElement(el) || !el.getAttribute) return ''
      return el.getAttribute(ROW_KEY_ATTR) || ''
    }

    function classListOf(el) {
      if (!isElement(el) || !el.classList) return []
      return Array.from(el.classList)
    }

    function hasSuffix(cls, suffixes) {
      const lower = cls.toLowerCase()
      for (const s of suffixes) if (lower.endsWith(s)) return true
      return false
    }

    function isSessionRow(el) {
      if (!isElement(el)) return false
      const key = rowKeyOf(el)
      if (key !== '') return key.startsWith(SESSION_KEY_PREFIX)
      return classListOf(el).some((c) => hasSuffix(c, SESSION_SUFFIXES))
    }

    function isWorkspaceRow(el) {
      if (!isElement(el)) return false
      const key = rowKeyOf(el)
      return key !== '' && key.startsWith(WORKSPACE_KEY_PREFIX)
    }

    /** Session id straight off a row's `data-row-key`, when present. */
    function sessionIdFromRow(el) {
      const key = rowKeyOf(el)
      return key.startsWith(SESSION_KEY_PREFIX) ? key.slice(SESSION_KEY_PREFIX.length) : ''
    }

    /** Workspace id straight off a row's `data-row-key`, when present. */
    function workspaceIdFromRow(el) {
      const key = rowKeyOf(el)
      return key.startsWith(WORKSPACE_KEY_PREFIX) ? key.slice(WORKSPACE_KEY_PREFIX.length) : ''
    }

    /** Nearest ancestor (or self) that is a session row. */
    function sessionRowOf(target) {
      if (!isElement(target)) return null
      let el = target
      for (let i = 0; i < 12 && isElement(el); i++) {
        if (isSessionRow(el)) return el
        el = el.parentElement
      }
      const fallback = target.closest('[draggable="true"],[role="treeitem"]')
      return isElement(fallback) ? fallback : null
    }

    /** Nearest ancestor (or self) that is a workspace header row. */
    function workspaceRowOf(target) {
      if (!isElement(target)) return null
      let el = target
      for (let i = 0; i < 14 && isElement(el); i++) {
        if (isWorkspaceRow(el)) return el
        el = el.parentElement
      }
      return null
    }

    /**
     * Read the FIRST-LEVEL React props on a DOM node. React attaches the
     * current props to the fiber under `__reactProps$<hash>` (or as
     * `memoizedProps` on the `__reactFiber$<hash>` fiber). We never recurse
     * into props (that risks stack overflow / infinite loops on the large,
     * cyclic better-workspace state trees), so callers read only known,
     * shallow fields.
     */
    function shallowProps(el) {
      if (!isElement(el)) return undefined
      const keys = Object.keys(el)
      for (const k of keys) {
        if (k.startsWith('__reactProps$')) return el[k]
        if (k.startsWith('__reactFiber$')) {
          const f = el[k]
          if (f && f.memoizedProps) return f.memoizedProps
        }
      }
      const fiberKey = keys.find((k) => k.startsWith('__reactFiber$'))
      if (fiberKey) {
        const f = el[fiberKey]
        if (f && f.memoizedProps) return f.memoizedProps
      }
      return undefined
    }

    /**
     * Collect every UUID-shaped string reachable in the FIRST-LEVEL props of a
     * node (plus one level down for plain objects). The sidebar's components
     * are opaque to us: the session/workspace id may sit under `node.id`,
     * `sessionId`, `workspaceId`, `workspace.workspaceId`, or a plainly
     * destructured prop. Scanning shallowly for the SHAPE of the value is far
     * more robust than hard-coding one path, and it cannot loop because we
     * never descend more than one level.
     */
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const SESSION_ID_RE = /^session-[0-9a-f-]{8,}$/i

    function collectIds(el) {
      const out = { sessionIds: [], workspaceIds: [], raw: {} }
      const p = shallowProps(el)
      if (!p || typeof p !== 'object') return out

      const visit = (obj, prefix, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 1) return
        for (const key of Object.keys(obj)) {
          const v = obj[key]
          if (typeof v === 'string') {
            const path = prefix + key
            out.raw[path] = v.length > 60 ? `${v.slice(0, 57)}...` : v
            if (SESSION_ID_RE.test(v)) out.sessionIds.push({ path, value: v })
            else if (UUID_RE.test(v)) out.workspaceIds.push({ path, value: v })
          } else if (v && typeof v === 'object' && !Array.isArray(v) && !v.$$typeof && depth < 1) {
            visit(v, `${prefix}${key}.`, depth + 1)
          }
        }
      }
      visit(p, '', 0)
      return out
    }

    /**
     * Session id for a session row.
     *
     * `data-row-key="session:<id>"` is the primary and authoritative source
     * (better-workspace writes it directly). Only when that attribute is
     * missing do we fall back to shape-scanning the React props, which some
     * builds populate instead.
     */
    function sessionIdOf(row) {
      if (!isElement(row)) return ''
      const fromKey = sessionIdFromRow(row)
      if (fromKey !== '') return fromKey
      try {
        const ids = collectIds(row)
        if (ids.sessionIds.length > 0) {
          const best = ids.sessionIds.find((x) => /node|session/i.test(x.path)) || ids.sessionIds[0]
          return best.value
        }
      } catch (_) { /* ignore */ }
      return ''
    }

    /**
     * Workspace id for a workspace header row or any element inside it.
     * `data-row-key="workspace:<id>"` first; React props as the fallback.
     */
    function workspaceIdOf(row) {
      if (!isElement(row)) return ''
      const fromKey = workspaceIdFromRow(row)
      if (fromKey !== '') return fromKey
      try {
        const ids = collectIds(row)
        if (ids.workspaceIds.length > 0) {
          const best = ids.workspaceIds.find((x) => /workspace/i.test(x.path)) || ids.workspaceIds[0]
          return best.value
        }
      } catch (_) { /* ignore */ }
      return ''
    }

    /**
     * Workspace id that owns a given session row.
     *
     * Workspace headers and their sessions may be rendered as SIBLINGS
     * (indented flat rows) rather than as nested containers, so a `closest()`
     * ancestor walk is not reliable. We therefore resolve the owner by
     * GEOMETRY/DOCUMENT ORDER, which is correct for both layouts: the owner is
     * the nearest workspace header row above the session row. An ancestor hit
     * is accepted first because it is unambiguous.
     */
    function owningWorkspaceId(sessionRow) {
      if (!isElement(sessionRow)) return ''

      // 1) Unambiguous: a real ancestor workspace header.
      const ancestor = sessionRow.parentElement ? workspaceRowOf(sessionRow.parentElement) : null
      if (isElement(ancestor)) {
        const wid = workspaceIdOf(ancestor)
        if (wid !== '') return wid
      }

      // 2) Document order: the nearest workspace header row above this one.
      //    `data-row-key` makes this a cheap, exact query.
      const scope = sessionRow.closest('aside') || document.body
      const keyed = Array.from(scope.querySelectorAll(`[${ROW_KEY_ATTR}^="${WORKSPACE_KEY_PREFIX}"]`))
      const rect = sessionRow.getBoundingClientRect()
      let best = null
      let bestTop = -Infinity
      for (const h of keyed) {
        const hr = h.getBoundingClientRect()
        if (hr.top <= rect.top + 2 && hr.top > bestTop) {
          bestTop = hr.top
          best = h
        }
      }
      if (isElement(best)) {
        const wid = workspaceIdOf(best)
        if (wid !== '') return wid
      }

      // 3) Class-suffix fallback for a host build without `data-row-key`.
      const headers = Array.from(scope.querySelectorAll('div')).filter((el) => isWorkspaceRow(el))
      bestTop = -Infinity
      for (const h of headers) {
        const hr = h.getBoundingClientRect()
        if (hr.top <= rect.top + 2 && hr.top > bestTop) {
          bestTop = hr.top
          best = h
        }
      }
      if (isElement(best)) {
        const wid = workspaceIdOf(best)
        if (wid !== '') return wid
      }
      return ''
    }

    /* ------------------------------- state ------------------------------- */

    let drag = null
    let marker = null
    let highlight = null
    let toastTimer = null

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.head.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', NS)
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function clearMarker() {
      if (marker instanceof Element) marker.removeAttribute('data-dsh-sm-target')
      marker = null
      if (highlight === null) {
        highlight = document.createElement('div')
        highlight.className = `${NS}-hl`
        document.body.appendChild(highlight)
      }
      highlight.classList.remove(`${NS}-hl-on`)
    }

    function markTarget(target) {
      if (marker === target) return
      if (marker instanceof Element) marker.removeAttribute('data-dsh-sm-target')
      marker = target
      if (target instanceof Element) {
        target.setAttribute('data-dsh-sm-target', '')
        if (highlight !== null) {
          const r = target.getBoundingClientRect()
          highlight.style.left = `${r.left}px`
          highlight.style.top = `${r.top}px`
          highlight.style.width = `${r.width}px`
          highlight.style.height = `${r.height}px`
          highlight.classList.add(`${NS}-hl-on`)
        }
      }
    }

    function toast(message) {
      if (typeof document === 'undefined') return
      const existing = document.querySelector(`.${NS}-toast`)
      if (existing instanceof Element) existing.remove()
      const el = document.createElement('div')
      el.className = `${NS}-toast`
      el.textContent = message
      document.body.appendChild(el)
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => el.remove(), 3200)
    }

    function log(...args) {
      // Logging is ON by default while this feature is being stabilised: the
      // console output is the only way to see which step of the drag fires.
      // Set window.__smQuiet = true to silence it.
      if (DIAG) { console.log('[sm]', ...args); return }
      if (typeof window !== 'undefined' && window.__smQuiet) return
      try { console.log('[sm]', ...args) } catch (_) { /* ignore */ }
    }

    async function call(method, payload) {
      const response = await fetch(API + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {})
      })
      const body = await response.json().catch(() => ({ ok: false, error: { message: 'bad response' } }))
      if (!response.ok || body.ok !== true) {
        throw new Error(body?.error?.message ?? `request failed (${response.status})`)
      }
      return body.result
    }

    /* ------------------------------ listeners ---------------------------- */

    function onDragStart(event) {
      try {
        const t = event.target
        const desc = isElement(t) ? `${t.tagName}.${String(t.className).slice(0, 60)}` : String(t)
        const row = sessionRowOf(t)
        // Recognize the row by ANY of the contracts in play: the better-workspace
        // class, or the generic draggable/treeitem shape the sidebar uses. A
        // miss here is logged (not swallowed) so the real DOM can be seen.
        const fallback = isElement(t)
          ? (t.closest('[draggable="true"]') || t.closest('[role="treeitem"]'))
          : null
        log('dragstart event, target =', desc, '| bw-row =', row !== null, '| fallback =', fallback !== null)
        const sourceRow = isElement(row) ? row : (isElement(fallback) ? fallback : null)
        if (sourceRow === null) {
          if (isElement(t)) {
            const path = []
            let el = t
            for (let i = 0; i < 6 && isElement(el); i++) { path.push(`${el.tagName}.${String(el.className).slice(0, 40)}`); el = el.parentElement }
            log('  ancestors:', path)
          }
          return
        }
        // The source workspace id is a HINT used only to suppress no-op drops.
        // It is deliberately allowed to be empty: recognition of "this is a
        // session row" is what matters, and the host decides the real owner.
        const fromWorkspaceId = owningWorkspaceId(sourceRow)
        drag = { row: sourceRow, fromWorkspaceId, sessionId: sessionIdOf(sourceRow) }
        sourceRow.setAttribute('data-dsh-sm-dragging', '')
        log('dragstart OK', { fromWorkspaceId, sessionId: drag.sessionId })
      } catch (error) {
        // Never break native dragging.
        log('dragstart error:', String(error && error.message || error))
      }
    }

    /**
     * Rows under the pointer, most specific first.
     *
     * `event.target` during a drag is unreliable: an overlay, an empty drop
     * zone, or the browser's own drag image can make it the container or even
     * `document`. `elementsFromPoint` is driven by the pointer coordinates and
     * therefore always names what the user is actually hovering. We try both
     * and take whichever yields a real row.
     */
    function rowsUnder(event) {
      const candidates = []
      try {
        if (event.clientX || event.clientY) {
          const stack = document.elementsFromPoint(event.clientX, event.clientY) || []
          for (const el of stack) candidates.push(el)
        }
      } catch (_) { /* ignore */ }
      if (isElement(event.target)) candidates.push(event.target)
      if (isElement(event.relatedTarget)) candidates.push(event.relatedTarget)

      let session = null
      let workspace = null
      for (const el of candidates) {
        if (session === null) {
          const s = sessionRowOf(el)
          if (isElement(s)) session = s
        }
        if (workspace === null) {
          const w = workspaceRowOf(el)
          if (isElement(w)) workspace = w
        }
        if (session !== null || workspace !== null) break
      }
      return { session, workspace }
    }

    function resolveTarget(event) {
      if (drag === null) return null
      const { session: sessionTarget, workspace: wsRow } = rowsUnder(event)

      // Hovering a session row.
      if (isElement(sessionTarget)) {
        if (sessionTarget === drag.row) return null
        // Several independent routes to the owning workspace, because the row
        // component's props are version-dependent:
        //   1) the session row's own props (it often carries workspaceId),
        //   2) a workspace header row found by geometry above this row,
        //   3) a workspace header row element already found under the pointer.
        let workspaceId = workspaceIdOf(sessionTarget)
        if (workspaceId === '') workspaceId = owningWorkspaceId(sessionTarget)
        if (workspaceId === '' && isElement(wsRow)) workspaceId = workspaceIdOf(wsRow)
        // Same workspace (only when BOTH ids are known and equal) -> let the
        // official reorder handle it. An unknown id is treated as "possibly a
        // different workspace"; the host re-checks the real owner and answers
        // `alreadyThere` for a no-op, so guessing wrong here is harmless.
        const sameKnownWorkspace = workspaceId !== '' && drag.fromWorkspaceId !== '' && workspaceId === drag.fromWorkspaceId
        if (sameKnownWorkspace) {
          log('same-workspace session target -> ignore')
          return null
        }
        const rect = sessionTarget.getBoundingClientRect()
        const below = (event.clientY - rect.top) > (rect.height / 2)
        const anchorId = sessionIdOf(sessionTarget)
        let beforeSessionId
        if (below) {
          const container = sessionTarget.parentElement ?? document.body
          const rows = Array.from(container.querySelectorAll('div')).filter((el) => isSessionRow(el))
          const idx = rows.indexOf(sessionTarget)
          const next = rows[idx + 1]
          beforeSessionId = isElement(next) ? sessionIdOf(next) : undefined
        } else {
          beforeSessionId = anchorId || undefined
        }
        log('target=session', { workspaceId, beforeSessionId })
        return { workspaceId, beforeSessionId, row: sessionTarget, workspaceRow: null }
      }

      // Hovering a workspace header row.
      if (isElement(wsRow)) {
        const workspaceId = workspaceIdOf(wsRow)
        const sameKnownWorkspace = workspaceId !== '' && drag.fromWorkspaceId !== '' && workspaceId === drag.fromWorkspaceId
        if (sameKnownWorkspace) return null
        log('target=workspace', { workspaceId })
        return { workspaceId, beforeSessionId: undefined, row: null, workspaceRow: wsRow }
      }

      return null
    }

    function onDragOver(event) {
      if (drag === null) return
      const target = resolveTarget(event)
      if (target === null) {
        // Diagnostic: dump what IS under the pointer, including the props id
        // structure of the nearest rows, so the real contract can be seen.
        if (!window.__smOverlogged) {
          window.__smOverlogged = true
          try {
            const stack = (document.elementsFromPoint(event.clientX, event.clientY) || []).slice(0, 6)
            console.log('[sm] dragover: no target. under pointer:',
              stack.map((el) => `${el.tagName}.${String(el.className).slice(0, 50)}`))
            const seen = new Set()
            for (const el of stack) {
              let node = el
              for (let i = 0; i < 8 && isElement(node); i++) {
                const cls = String(node.className).slice(0, 50)
                if (cls && !seen.has(cls) && /session|row|group|ws|header/i.test(cls)) {
                  seen.add(cls)
                  const ids = collectIds(node)
                  console.log('[sm]   candidate', `${node.tagName}.${cls}`,
                    'sessionIds=', ids.sessionIds, 'workspaceIds=', ids.workspaceIds,
                    'raw=', ids.raw)
                }
                node = node.parentElement
              }
            }
          } catch (_) { /* ignore */ }
          setTimeout(() => { window.__smOverlogged = false }, 1500)
        }
        return
      }
      // Claim the drop: tell the browser a drop is allowed here, and stop the
      // event from reaching better-workspace (which would otherwise reject a
      // cross-workspace drop and do nothing).
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) {
        try { event.dataTransfer.dropEffect = 'move' } catch (_) { /* ignore */ }
      }
      markTarget(target.row ?? target.workspaceRow)
    }

    function onDrop(event) {
      if (drag === null) return
      const target = resolveTarget(event)
      if (target === null) return
      event.preventDefault()
      event.stopPropagation()

      // Prefer the id better-workspace already placed in the dataTransfer;
      // otherwise the id captured at dragstart; otherwise the row's props.
      let sessionId = ''
      try {
        if (event.dataTransfer && event.dataTransfer.getData) {
          const dt = event.dataTransfer.getData('text/plain')
          if (typeof dt === 'string' && dt.startsWith('session-')) sessionId = dt
        }
      } catch (_) { /* ignore */ }
      if (sessionId === '') sessionId = drag.sessionId || ''
      if (sessionId === '') sessionId = sessionIdOf(drag.row)

      const payload = {
        sessionId,
        targetWorkspaceId: target.workspaceId,
        beforeSessionId: target.beforeSessionId
      }
      log('drop', payload)

      const sourceRow = drag.row
      drag = null
      clearMarker()
      sourceRow?.removeAttribute('data-dsh-sm-dragging')

      if (sessionId === '') {
        toast('无法识别会话，未移动')
        return
      }
      if (!target.workspaceId) {
        toast('无法识别目标工作区，未移动（请把会话拖到目标工作区的标题或会话上）')
        return
      }

      runMove(payload)
    }

    /* --------------------------- move + progress -------------------------- */

    const PHASE_TEXT = {
      starting: '准备迁移…',
      resolve: '定位目标工作区…',
      scan: '查找会话存储目录…',
      index: '读取会话索引…',
      read: '读取会话日志…',
      rewrite: '重写日志头 cwd…',
      'write-main': '写入目标目录…',
      'move-extras': '搬运日志文件…',
      backup: '备份原目录…',
      branches: '迁移分支会话…',
      ledger: '同步工作区账本…',
      done: '完成'
    }

    let progressEl = null
    let progressTimer = null

    function ensureProgress() {
      if (progressEl instanceof Element && document.body.contains(progressEl)) return progressEl
      const el = document.createElement('div')
      el.className = `${NS}-prog`
      el.innerHTML = `
        <div class="${NS}-prog-head">
          <span class="${NS}-prog-title"></span>
          <span class="${NS}-prog-pct"></span>
        </div>
        <div class="${NS}-prog-track"><div class="${NS}-prog-fill"></div></div>
        <div class="${NS}-prog-sub"></div>`
      document.body.appendChild(el)
      progressEl = el
      return el
    }

    function renderProgress({ title, percent, sub, state }) {
      const el = ensureProgress()
      el.classList.toggle(`${NS}-prog-done`, state === 'done')
      el.classList.toggle(`${NS}-prog-fail`, state === 'failed')
      el.classList.toggle(`${NS}-prog-indet`, percent === null && state === 'running')
      el.querySelector(`.${NS}-prog-title`).textContent = title
      el.querySelector(`.${NS}-prog-pct`).textContent = percent === null ? '' : `${percent}%`
      if (percent !== null) el.querySelector(`.${NS}-prog-fill`).style.width = `${percent}%`
      const subEl = el.querySelector(`.${NS}-prog-sub`)
      subEl.textContent = sub || ''
      subEl.style.display = sub ? '' : 'none'
    }

    function hideProgressSoon(delay) {
      clearTimeout(progressTimer)
      progressTimer = setTimeout(() => {
        if (progressEl instanceof Element) progressEl.remove()
        progressEl = null
      }, delay)
    }

    /** Percent for a job snapshot, or null when the phase is not measurable. */
    function percentOf(snapshot) {
      const { phase, detail } = snapshot || {}
      if (phase === 'branches') {
        const total = Number(detail?.total) || 0
        const done = Number(detail?.done) || 0
        return total > 0 ? Math.min(99, Math.round((done / total) * 100)) : null
      }
      if (phase === 'move-extras') {
        const total = Number(detail?.total) || 0
        const done = Number(detail?.done) || 0
        return total > 0 ? Math.min(99, Math.round((done / total) * 100)) : null
      }
      // Coarse phases get a fixed nominal position so the bar still advances.
      const steps = { starting: 3, resolve: 8, scan: 15, index: 25, read: 35, rewrite: 45, 'write-main': 60, backup: 88, ledger: 95, done: 100 }
      return typeof steps[phase] === 'number' ? steps[phase] : null
    }

    function subTextOf(snapshot) {
      const { phase, detail } = snapshot || {}
      if (phase === 'move-extras' || phase === 'branches') {
        const total = Number(detail?.total) || 0
        const done = Number(detail?.done) || 0
        if (total > 0) return `${done} / ${total} 个文件`
      }
      if (detail?.current) return String(detail.current)
      return ''
    }

    async function runMove(payload) {
      renderProgress({ title: '正在迁移会话…', percent: null, sub: '正在启动任务', state: 'running' })
      let jobId = ''
      try {
        const started = await call('move', payload)
        jobId = started?.jobId ?? ''
      } catch (error) {
        renderProgress({ title: `迁移失败：${error.message}`, percent: 100, sub: '', state: 'failed' })
        hideProgressSoon(6000)
        return
      }
      if (jobId === '') {
        renderProgress({ title: '迁移失败：服务未返回任务号', percent: 100, sub: '', state: 'failed' })
        hideProgressSoon(6000)
        return
      }

      const deadline = Date.now() + 10 * 60 * 1000
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        let snapshot
        try {
          snapshot = await call('progress', { jobId })
        } catch (error) {
          renderProgress({ title: `迁移失败：${error.message}`, percent: 100, sub: '', state: 'failed' })
          hideProgressSoon(6000)
          return
        }
        const phase = snapshot?.phase ?? 'starting'
        const percent = percentOf(snapshot)

        if (snapshot?.state === 'done') {
          const result = snapshot.result ?? {}
          const branchNote = Array.isArray(result.branches) && result.branches.length > 0
            ? `，含 ${result.branches.filter((b) => b.moved).length} 个分支会话`
            : ''
          renderProgress({ title: '会话已迁移到目标工作区', percent: 100, sub: branchNote.replace(/^，/, ''), state: 'done' })
          hideProgressSoon(2600)
          return
        }
        if (snapshot?.state === 'failed') {
          const message = snapshot?.error?.message ?? '未知错误'
          renderProgress({ title: `迁移失败：${message}`, percent: 100, sub: '', state: 'failed' })
          hideProgressSoon(8000)
          return
        }

        renderProgress({
          title: PHASE_TEXT[phase] ?? `迁移中（${phase}）…`,
          percent,
          sub: subTextOf(snapshot),
          state: 'running'
        })

        if (Date.now() > deadline) {
          renderProgress({ title: '迁移超时，请查看日志', percent: 100, sub: '', state: 'failed' })
          hideProgressSoon(8000)
          return
        }
      }
    }

    function onDragEnd() {
      if (drag !== null) drag.row?.removeAttribute('data-dsh-sm-dragging')
      drag = null
      clearMarker()
    }

    function apply(ctx) {
      ensureStyle()

      const options = { capture: true }
      document.addEventListener('dragstart', onDragStart, options)
      document.addEventListener('dragover', onDragOver, options)
      document.addEventListener('drop', onDrop, options)
      document.addEventListener('dragend', onDragEnd, options)

      log('client attached')

      ctx?.effect?.(() => () => {
        document.removeEventListener('dragstart', onDragStart, options)
        document.removeEventListener('dragover', onDragOver, options)
        document.removeEventListener('drop', onDrop, options)
        document.removeEventListener('dragend', onDragEnd, options)
        clearMarker()
      })
    }

    return {
      name: 'dsh-session-drag-move',
      apply
    }
  }
})
