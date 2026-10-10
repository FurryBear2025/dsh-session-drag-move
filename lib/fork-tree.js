/**
 * Fork family resolution.
 *
 * A fork records where it came from in its session header's `parentSession`,
 * so the family is derived from stored headers — never from a workspace
 * ledger. This is what lets a move keep a branch with its origin: the rule
 * this plugin enforces is that a fork lives in its parent's workspace, and the
 * only way to honour it while moving is to move the subtree together.
 *
 * Pure functions: no filesystem, no services.
 */

/**
 * Build the parent → children relation.
 *
 * A header whose `parentSession` names an id that is not in `headers` is
 * treated as a root: the parent may have been deleted, or may live outside
 * this store. Either way there is nothing to follow.
 *
 * @param {Array<{id?: string, parentSession?: string}>} headers - stored headers.
 * @returns {{byId: Map<string, object>, children: Map<string, string[]>}}
 */
export function forkTree(headers) {
  const byId = new Map()
  for (const header of headers) {
    if (typeof header?.id === 'string' && header.id !== '') byId.set(header.id, header)
  }

  const children = new Map()
  for (const header of byId.values()) {
    const parent = header.parentSession
    if (typeof parent !== 'string' || !byId.has(parent) || parent === header.id) continue
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [header.id])
    else siblings.push(header.id)
  }

  return { byId, children }
}

/**
 * Every session forked from `sessionId`, transitively — the branches to carry
 * along. Breadth-first so the result reads parent-before-child.
 *
 * @param {{children: Map<string, string[]>}} tree - from {@link forkTree}.
 * @param {string} sessionId - the session being moved.
 * @returns {string[]} descendants, excluding `sessionId` itself.
 */
export function descendantsOf(tree, sessionId) {
  const found = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    for (const child of tree.children.get(queue.shift()) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Every ancestor of `sessionId`, nearest first.
 *
 * Not used to move anything: dragging a branch must not silently drag its
 * origin out from under other branches. It exists so a move can REPORT an
 * origin left in another workspace instead of leaving the caller unaware.
 *
 * @param {{byId: Map<string, object>}} tree - from {@link forkTree}.
 * @param {string} sessionId
 * @returns {string[]} ancestors, nearest first.
 */
export function ancestorsOf(tree, sessionId) {
  const found = []
  const seen = new Set([sessionId])
  let current = tree.byId.get(sessionId)?.parentSession
  while (typeof current === 'string' && tree.byId.has(current) && !seen.has(current)) {
    seen.add(current)
    found.push(current)
    current = tree.byId.get(current)?.parentSession
  }
  return found
}

/**
 * The whole connected family: every ancestor, `sessionId`, and every
 * descendant. Available for callers that want the invariant "one family, one
 * workspace" enforced in a single move.
 *
 * @param {object} tree - from {@link forkTree}.
 * @param {string} sessionId
 * @returns {string[]} family members, root-first order not guaranteed.
 */
export function familyOf(tree, sessionId) {
  const ancestors = ancestorsOf(tree, sessionId)
  const root = ancestors.length > 0 ? ancestors[ancestors.length - 1] : sessionId
  return [root, ...descendantsOf(tree, root)]
}
