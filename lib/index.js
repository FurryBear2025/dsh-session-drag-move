/**
 * dsh-session-drag-move — host half.
 *
 * Adds the one move the shipped workspace domain refuses: re-homing a session
 * into another workspace. Membership is derived, never stored — a workspace
 * owns exactly the sessions whose STORED HEADER cwd is its path — so the move
 * is a storage operation (rewrite that header's cwd and park the log under the
 * new project directory) followed by re-attaching the session on the registry.
 *
 * Exposes `POST /session-drag-move/api/<method>` over the host web server; the
 * browser half calls `move`.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  findSessionDirs,
  indexStore,
  readHeaderPrefix,
  readSessionState,
  relocateSession,
  sessionDir
} from './session-log.js'
import { forkTree, descendantsOf } from './fork-tree.js'

export const name = 'dsh-session-drag-move'

/**
 * Cordis inject is a LIST of service names. Only `webServer` is declared:
 * without it there is nowhere to hang the move route. `workspaceRegistry` is
 * resolved lazily inside the handler instead — declaring it here would leave
 * this entry pending forever (and web boot failing with "1 entry did not
 * activate") on any profile where that service is absent or renamed, which is
 * exactly the failure mode a hard dependency must not have.
 */
export const inject = ['webServer']

/** Load-time defaults; a patch entry's `config` overrides them field by field. */
const DEFAULTS = {
  /** Session store root; the shipped default is `~/.dsh/sessions`. */
  root: '',
  /** Where pre-move session directories are parked. */
  backupRoot: '',
  /** Refuse requests whose Host header is not loopback (LAN deploys opt in). */
  allowRemote: false
}

const API_PREFIX = '/session-drag-move/api/'

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** Loopback-only by default; a LAN deployment flips `allowRemote`. */
function trusted(req, allowRemote) {
  if (allowRemote) return true
  const authority = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return authority === '' || authority === 'localhost' || authority === '127.0.0.1' || authority === '::1'
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

/**
 * Resolve a service this plugin did not declare in `inject`. `ctx.get` is the
 * documented accessor for undeclared services (the shipped workspace registry
 * itself reads `sessions` this way); a plain property read can miss behind a
 * context proxy.
 */
const serviceOf = (ctx, name) => {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

const isActive = (ctx, sessionId) => {
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions === undefined) return false
  try {
    const live = sessions.get?.(sessionId)
    if (live === undefined) return false
    return live.running === true || live.active === true || live.state === 'running'
  } catch {
    return false
  }
}

/**
 * Make the running process agree with the bytes that just moved.
 *
 * `WorkspaceEntity.attachSession` cannot be used here. It validates the
 * session's cwd by calling `registry.host.readSessionHeader`, which prefers a
 * LIVE session's in-memory header, and a live session keeps the cwd it was
 * opened with. After a move that check therefore compares the OLD cwd against
 * the new workspace path and throws — leaving the bytes moved and the ledger
 * unchanged, which is the inconsistency this function exists to avoid.
 *
 * So the header index is taught the new truth first, and the ledger is then
 * written through the entity's public mutators. `detachSession` runs last: it
 * prunes by `sessionPath(id) === path`, so the source drops the id only once
 * the index already says the session lives elsewhere.
 */
async function reconcile(ctx, registry, target, source, sessionId, header, beforeSessionId) {
  registry.headers?.set(sessionId, header)
  registry.host?.rememberSessionPath?.(sessionId, target.path)
  registry.invalidSessionPaths?.delete(sessionId)

  const accounted = (entity) => entity.record.sessionIds.includes(sessionId)

  if (!accounted(target)) {
    try {
      await target.attachSession(sessionId)
    } catch (error) {
      // The official path re-validates against the live in-memory header and
      // refuses when that header is stale. The index is already correct, so
      // write the ledger through the entity's own single write path instead;
      // `mutate` applies the same idempotence and path pruning as attach.
      ctx.logger?.warn(`dsh-session-drag-move: attachSession refused '${sessionId}' (${error?.message ?? error}); writing the ledger directly`)
      await target.mutate((record) => record.sessionIds.includes(sessionId)
        ? record
        : { ...record, sessionIds: [sessionId, ...record.sessionIds] })
    }
  }

  if (accounted(target)) await target.insertSessionBefore(sessionId, beforeSessionId)
  if (source !== undefined && accounted(source)) await source.detachSession(sessionId)
}

/**
 * Re-home one session into another workspace.
 *
 * Bytes first, ledger second: the stored header's cwd is what a workspace
 * derives membership from, so the storage rewrite is the real move, and the
 * ledger write is bookkeeping that follows it (see {@link reconcile}).
 *
 * `onProgress` (optional) is threaded down to every storage step so a long
 * move can be reported while it runs.
 */
async function move(ctx, config, request, onProgress) {
  const report = (phase, extra) => {
    if (typeof onProgress !== 'function') return
    try { onProgress({ phase, ...extra }) } catch { /* never break the move */ }
  }

  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (registry === undefined) throw new ApiError('no-registry', 'workspace registry is unavailable', 503)

  const sessionId = String(request?.sessionId ?? '')
  const targetWorkspaceId = String(request?.targetWorkspaceId ?? '')
  const beforeSessionId = request?.beforeSessionId === undefined || request?.beforeSessionId === null
    ? undefined
    : String(request.beforeSessionId)

  if (sessionId === '' || !sessionId.startsWith('session-')) throw new ApiError('bad-session', `not a session id: '${sessionId}'`)
  if (targetWorkspaceId === '') throw new ApiError('bad-workspace', 'targetWorkspaceId is required')

  report('resolve')
  const target = registry.get(targetWorkspaceId)
  if (target === undefined) throw new ApiError('no-workspace', `unknown workspace '${targetWorkspaceId}'`, 404)

  // The ledger is NOT membership: a session can sit in one workspace's ledger
  // while its bytes already belong to another (an interrupted move leaves
  // exactly that). Membership is the stored cwd, so source is resolved from
  // the ledger only to know what to detach afterwards.
  const source = registry.list().find((entity) => entity.id !== targetWorkspaceId && entity.record.sessionIds.includes(sessionId))

  const root = config.root === '' ? join(homedir(), '.dsh', 'sessions') : config.root
  const backupRoot = config.backupRoot === '' ? join(dirname(root), 'session-drag-move-backup') : config.backupRoot

  // Where are the bytes, really? Scan the store instead of trusting the
  // in-memory header, which a live session never refreshes after a move.
  report('scan')
  const dirs = await findSessionDirs(root, sessionId)

  if (dirs.length === 0) {
    // Bytes are nowhere under this root: either the session never persisted,
    // or its cwd is a directory this profile cannot see. Both are refused
    // loudly rather than guessed at.
    if (target.record.sessionIds.includes(sessionId)) {
      await target.insertSessionBefore(sessionId, beforeSessionId)
      return { moved: false, reordered: true, workspaceId: targetWorkspaceId }
    }
    throw new ApiError('no-session-dir', `no session directory for '${sessionId}' under '${root}'`, 404)
  }
  if (dirs.length > 1) {
    throw new ApiError('duplicate-session', `'${sessionId}' exists in ${dirs.length} project directories (${dirs.join(', ')}); resolve the duplicate first`, 409)
  }

  const from = dirs[0]
  const state = await readSessionState(from, sessionId)
  if (state === undefined) throw new ApiError('unreadable-session', `session directory '${from}' holds no readable session log`, 422)
  const oldCwd = state.header.cwd

  const alreadyThere = from === sessionDir(root, target.path, sessionId)

  // Which sessions travel with this one. A fork belongs in its parent's
  // workspace, so dragging a session carries its whole branch subtree — a
  // branch left behind would be a fork in a different workspace from the
  // conversation it came out of. Only DESCENDANTS move: dragging a branch must
  // never drag its origin (and therefore its origin's other branches) along.
  report('index')
  const store = await indexStore(root)
  const tree = forkTree(await readHeadersFor(store))
  const branch = descendantsOf(tree, sessionId)

  // A pure ordering request inside one workspace — and the already-in-place
  // case — never touches storage.
  if (alreadyThere) {
    if (oldCwd !== target.path) {
      // Bytes are in the target project directory but the header still names
      // the old one: repair the header, then fix the ledger.
      const result = await relocateSession({ root, dir: from, newCwd: target.path, sessionId, backupRoot, onProgress: report })
      report('ledger')
      await reconcile(ctx, registry, target, source, sessionId, result.header, beforeSessionId)
      return { moved: true, repaired: true, sessionId, workspaceId: targetWorkspaceId, from: source?.id, cwd: { from: oldCwd, to: target.path } }
    }
    await target.insertSessionBefore(sessionId, beforeSessionId)
    if (source !== undefined) await source.detachSession(sessionId)
    const carried = await carryBranches(ctx, registry, root, backupRoot, target, branch, report)
    return { moved: false, reordered: true, workspaceId: targetWorkspaceId, branches: carried }
  }

  if (isActive(ctx, sessionId)) throw new ApiError('session-active', `session '${sessionId}' is running; stop it before moving`, 409)

  const result = await relocateSession({ root, dir: from, newCwd: target.path, sessionId, backupRoot, onProgress: report })
  report('ledger')
  await reconcile(ctx, registry, target, source, sessionId, result.header, beforeSessionId)
  const carried = await carryBranches(ctx, registry, root, backupRoot, target, branch, report)

  return {
    moved: true,
    sessionId,
    workspaceId: targetWorkspaceId,
    from: source?.id,
    cwd: { from: oldCwd, to: target.path },
    backup: result.backup,
    branches: carried
  }
}

/**
 * Read every stored header, so one session can be placed in its fork family.
 *
 * `indexStore` keys are already unique, so this reads each log once. Only a
 * bounded prefix of each file is touched: a header is its first frame, while
 * the log behind it may be many megabytes.
 *
 * @param {Map<string, string>} store - sessionId → directory, from indexStore.
 * @returns {Promise<object[]>} readable headers (unreadable logs are skipped).
 */
async function readHeadersFor(store) {
  const headers = []
  for (const [id, dir] of store) {
    const header = await readHeaderPrefix(dir, id)
    if (header !== undefined) headers.push(header)
  }
  return headers
}

/**
 * Move the branch subtree into the target workspace alongside its origin.
 *
 * Each branch is an independent session, so a failure on one is reported
 * rather than aborting the rest: the dragged session has already moved by the
 * time this runs, and rolling that back because a branch could not follow
 * would be worse than leaving a branch behind with a reason.
 *
 * @returns {Promise<Array<{sessionId: string, moved: boolean, error?: string}>>}
 */
async function carryBranches(ctx, registry, root, backupRoot, target, branchIds, report) {
  const carried = []
  const total = branchIds.length
  let done = 0
  if (typeof report === 'function' && total > 0) report('branches', { done: 0, total })
  for (const branchId of branchIds) {
    try {
      const dirs = await findSessionDirs(root, branchId)
      if (dirs.length !== 1) {
        carried.push({ sessionId: branchId, moved: false, error: dirs.length === 0 ? 'no session directory' : `${dirs.length} session directories` })
        continue
      }
      const state = await readSessionState(dirs[0], branchId)
      if (state === undefined) {
        carried.push({ sessionId: branchId, moved: false, error: 'unreadable session log' })
        continue
      }
      if (state.header.cwd === target.path) {
        carried.push({ sessionId: branchId, moved: false, error: undefined, alreadyThere: true })
        continue
      }
      if (isActive(ctx, branchId)) {
        carried.push({ sessionId: branchId, moved: false, error: 'session is running' })
        continue
      }
      const source = registry.list().find((entity) => entity.id !== target.id && entity.record.sessionIds.includes(branchId))
      const result = await relocateSession({ root, dir: dirs[0], newCwd: target.path, sessionId: branchId, backupRoot, onProgress: report })
      await reconcile(ctx, registry, target, source, branchId, result.header, undefined)
      carried.push({ sessionId: branchId, moved: true })
    } catch (error) {
      ctx.logger?.warn(`dsh-session-drag-move: could not carry branch '${branchId}': ${error?.message ?? error}`)
      carried.push({ sessionId: branchId, moved: false, error: error?.message ?? String(error) })
    }
    done += 1
    if (typeof report === 'function') report('branches', { done, total, current: branchId })
  }
  return carried
}

/* ------------------------------- job registry ----------------------------- */

/**
 * Long moves run as background jobs so the UI can show progress.
 *
 * A drag that re-homes a session with many log generations (and a fork
 * subtree) can take tens of seconds. Blocking the single HTTP response for
 * that long gives the user no feedback at all, so `move` starts a job and
 * returns its id immediately; the client polls `progress` while it runs.
 *
 * Jobs are kept only long enough for a polling client to collect the final
 * state, then evicted: this is transport bookkeeping, not a durable record.
 */
const JOBS = new Map()
const JOB_TTL_MS = 5 * 60 * 1000
const JOB_KEEP_AFTER_SETTLE_MS = 60 * 1000

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of JOBS) {
    const settledAt = job.finishedAt ?? job.startedAt
    if (now - settledAt > JOB_TTL_MS) JOBS.delete(id)
  }
}

function startJob(runner) {
  pruneJobs()
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const job = {
    id,
    state: 'running',
    phase: 'starting',
    startedAt: Date.now(),
    finishedAt: undefined,
    result: undefined,
    error: undefined,
    detail: undefined
  }
  JOBS.set(id, job)
  const report = (progress) => {
    if (job.state !== 'running') return
    if (typeof progress?.phase === 'string') job.phase = progress.phase
    const detail = {}
    for (const key of ['done', 'total', 'current']) {
      if (progress?.[key] !== undefined) detail[key] = progress[key]
    }
    job.detail = detail
  }
  // Detached on purpose: the response returns before this settles.
  Promise.resolve()
    .then(() => runner(report))
    .then((result) => {
      job.state = 'done'
      job.result = result
      job.phase = 'done'
    })
    .catch((error) => {
      job.state = 'failed'
      job.error = { code: error instanceof ApiError ? error.code : 'internal', message: error?.message ?? String(error) }
      job.phase = 'failed'
    })
    .finally(() => {
      job.finishedAt = Date.now()
      setTimeout(() => JOBS.delete(id), JOB_KEEP_AFTER_SETTLE_MS).unref?.()
    })
  return job
}

const methods = {
  /**
   * Start a move and return its job id at once. Pass `wait: true` to run it
   * inline and get the final result (used by scripts and tests).
   */
  async move(ctx, config, payload) {
    if (payload?.wait === true) return await move(ctx, config, payload, undefined)
    const job = startJob((report) => move(ctx, config, payload, report))
    return { jobId: job.id, started: true }
  },
  async progress(ctx, config, payload) {
    pruneJobs()
    const id = String(payload?.jobId ?? '')
    const job = JOBS.get(id)
    if (job === undefined) throw new ApiError('no-job', `unknown job '${id}'`, 404)
    return {
      jobId: job.id,
      state: job.state,
      phase: job.phase,
      detail: job.detail,
      result: job.result,
      error: job.error
    }
  },
  async status(ctx, config) {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    return {
      ok: registry !== undefined,
      root: config.root === '' ? join(homedir(), '.dsh', 'sessions') : config.root
    }
  }
}

function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...config }
  const webServer = ctx.webServer
  if (webServer === undefined) {
    ctx.logger?.warn('dsh-session-drag-move: no webServer service; the move API is not mounted')
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/session-drag-move/api',
    handler: async (req, res) => {
      if (!trusted(req, resolved.allowRemote)) return json(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })

      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : undefined
      if (method === undefined || method.includes('/')) return json(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })

      try {
        const handler = methods[method]
        if (handler === undefined) throw new ApiError('not-found', `unknown method "${method}"`, 404)
        const payload = await readBody(req)
        json(res, 200, { ok: true, result: await handler(ctx, resolved, payload) })
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500
        const code = error instanceof ApiError ? error.code : 'internal'
        ctx.logger?.warn(`dsh-session-drag-move: ${method} failed: ${error?.message ?? error}`)
        json(res, status, { ok: false, error: { code, message: error?.message ?? String(error) } })
      }
    }
  }), 'dsh-session-drag-move: /session-drag-move/api routes')
}

export { apply }
