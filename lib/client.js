/**
 * dsh-session-drag-move — client half (plain JavaScript, no build step).
 *
 * The shipped workspace browser only handles drags INSIDE one workspace: its
 * `onDrop` acts when the drag's account key equals the group's key, and
 * `insertSessionBefore` rejects any session the workspace does not already
 * account for. A cross-workspace drag is therefore inert today.
 *
 * This half intercepts only that inert case — in the CAPTURE phase, ahead of
 * React's delegated handlers — and asks the host half to re-home the session.
 * Same-workspace drags are deliberately left alone so official ordering keeps
 * working exactly as it does now.
 *
 * Anchors come from the official DOM contract: every row carries
 * `data-row-key`, `session:<id>` for sessions and `workspace:<workspaceId>`
 * for workspace headers (the official buildGroup passes workspaceId as the
 * group key). Nothing here depends on hashed CSS module class names.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-drag-move',
  factory: (_require) => {
    const NS = 'dshSessionDragMove'
    const API = '/session-drag-move/api/'
    const SESSION_PREFIX = 'session:'
    const WORKSPACE_PREFIX = 'workspace:'

    const CSS = `
[data-dsh-sm-dragging] { opacity: .45; }
[data-dsh-sm-target] .dsh-sm-row,
[data-dsh-sm-target] > * {
  outline: 1px dashed var(--dsh-accent, #4c8dff);
  outline-offset: -1px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsh-accent, #4c8dff) 10%, transparent);
}
.${NS}-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 2147483000; max-width: 78vw;
  padding: 8px 14px; border-radius: 8px;
  background: rgba(28,28,30,.94); color: #fff;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.28);
}
`

    /* ------------------------------ helpers ------------------------------ */

    const rowKey = (el) => (el instanceof Element ? (el.dataset?.rowKey ?? '') : '')

    const closestKey = (el, prefix) => {
      if (!(el instanceof Element)) return null
      const hit = el.closest(`[data-row-key^="${prefix}"]`)
      return hit
    }

    /** The session row an event was raised on, if any. */
    const sessionRowOf = (target) => closestKey(target, SESSION_PREFIX)

    /**
     * Which workspace a session row belongs to: walk up until an ancestor has
     * a workspace header as one of its own children. The workspace header is
     * the first child of the group section, so the first hit is the owner.
     */
    function owningWorkspaceId(row) {
      let node = row?.parentElement
      while (node instanceof Element) {
        const own = node.querySelector?.(`:scope > [data-row-key^="${WORKSPACE_PREFIX}"]`)
        if (own instanceof Element) return rowKey(own).slice(WORKSPACE_PREFIX.length)
        for (const child of node.children) {
          const key = rowKey(child)
          if (key.startsWith(WORKSPACE_PREFIX)) return key.slice(WORKSPACE_PREFIX.length)
          const nested = child.querySelector?.(`[data-row-key^="${WORKSPACE_PREFIX}"]`)
          if (nested instanceof Element) return rowKey(nested).slice(WORKSPACE_PREFIX.length)
        }
        node = node.parentElement
      }
      return ''
    }

    /** Every session row of a group, in DOM order. */
    function siblingSessionRows(row) {
      let node = row?.parentElement
      while (node instanceof Element) {
        const rows = node.querySelectorAll(`[data-row-key^="${SESSION_PREFIX}"]`)
        if (rows.length > 0) return Array.from(rows)
        node = node.parentElement
      }
      return []
    }

    /**
     * Resolve a drop target from the element under the pointer.
     * @returns {{workspaceId: string, beforeSessionId?: string}|null}
     */
    function dropTargetOf(target, fromWorkspaceId) {
      if (!(target instanceof Element)) return null

      const workspaceRow = closestKey(target, WORKSPACE_PREFIX)
      if (workspaceRow instanceof Element) {
        const workspaceId = rowKey(workspaceRow).slice(WORKSPACE_PREFIX.length)
        if (workspaceId === '' || workspaceId === fromWorkspaceId) return null
        return { workspaceId }
      }

      const row = sessionRowOf(target)
      if (!(row instanceof Element)) return null
      const workspaceId = owningWorkspaceId(row)
      if (workspaceId === '' || workspaceId === fromWorkspaceId) return null

      const rect = row.getBoundingClientRect()
      const below = target instanceof Element
        ? (target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2) > rect.top + rect.height / 2
        : false
      const anchorId = rowKey(row).slice(SESSION_PREFIX.length)

      if (!below) return { workspaceId, beforeSessionId: anchorId }
      const rows = siblingSessionRows(row)
      const next = rows[rows.indexOf(row) + 1]
      const nextId = next instanceof Element ? rowKey(next).slice(SESSION_PREFIX.length) : undefined
      return { workspaceId, beforeSessionId: nextId }
    }

    /* ------------------------------- state ------------------------------- */

    let drag = null
    let marker = null
    let toastTimer = null

    function ensureStyle() {
      if (document.head.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', NS)
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function clearMarker() {
      if (marker instanceof Element) marker.removeAttribute('data-dsh-sm-target')
      marker = null
    }

    function markTarget(target) {
      if (marker === target) return
      clearMarker()
      marker = target
      if (target instanceof Element) target.setAttribute('data-dsh-sm-target', '')
    }

    function toast(message) {
      const existing = document.querySelector(`.${NS}-toast`)
      if (existing instanceof Element) existing.remove()
      const el = document.createElement('div')
      el.className = `${NS}-toast`
      el.textContent = message
      document.body.appendChild(el)
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => el.remove(), 3200)
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
      const row = sessionRowOf(event.target)
      if (!(row instanceof Element)) return
      const workspaceId = owningWorkspaceId(row)
      if (workspaceId === '') return
      drag = {
        row,
        sessionId: rowKey(row).slice(SESSION_PREFIX.length),
        fromWorkspaceId: workspaceId
      }
      row.setAttribute('data-dsh-sm-dragging', '')
    }

    function onDragOver(event) {
      if (drag === null) return
      const target = dropTargetOf(event.target, drag.fromWorkspaceId)
      if (target === null) return
      // The official handler never preventDefaults a cross-workspace drag, so
      // the drop would be rejected as "no drop target" without this.
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      markTarget(sessionRowOf(event.target) ?? closestKey(event.target, WORKSPACE_PREFIX) ?? null)
    }

    function onDrop(event) {
      if (drag === null) return
      const target = dropTargetOf(event.target, drag.fromWorkspaceId)
      if (target === null) return
      event.preventDefault()
      event.stopPropagation()
      const payload = {
        sessionId: drag.sessionId,
        targetWorkspaceId: target.workspaceId,
        beforeSessionId: target.beforeSessionId
      }
      const source = drag
      drag = null
      clearMarker()
      source.row?.removeAttribute('data-dsh-sm-dragging')

      call('move', payload).catch((error) => {
        toast(`移动会话失败：${error.message}`)
      })
    }

    function onDragEnd(event) {
      if (drag !== null) drag.row?.removeAttribute('data-dsh-sm-dragging')
      drag = null
      clearMarker()
    }

    function apply(ctx) {
      ensureStyle()

      // Capture phase: run before React's delegated listeners at the root.
      const options = { capture: true }
      document.addEventListener('dragstart', onDragStart, options)
      document.addEventListener('dragover', onDragOver, options)
      document.addEventListener('drop', onDrop, options)
      document.addEventListener('dragend', onDragEnd, options)

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
      // Deliberately NO inject. This half is a pure DOM enhancement bound to
      // the official row contract; it consumes no client service. Declaring
      // one it does not use makes the boot graph wait forever for a service
      // that never activates, and web boot then fails with
      // "1 entry did not activate".
      apply
    }
  }
})
