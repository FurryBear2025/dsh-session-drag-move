/**
 * dsh-session-drag-move — session log file helpers.
 *
 * The shipped session store is a per-session directory of Zstandard frames:
 *
 *   <root>/--<projectKey(cwd)>--/<sessionId>/session.vN.jsonl[.zstd]
 *
 * The FIRST frame is the physical header (one JSONL line carrying `cwd`),
 * every later frame is an appended batch. Frames are independent, so moving a
 * session to another project is "re-encode frame 0 with a new cwd, then copy
 * every byte after it verbatim" — no event is ever re-serialized.
 *
 * `projectKey` and `encodeSegment` are transcribed from
 * @deepseek-ai/dsh-session-persistence-jsonl (lib/index.js) so a target
 * directory is byte-identical to the one the backend itself would choose.
 */
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic number, `0x28B52FFD` little-endian. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Build the readable directory key for a project path.
 * @param {string} cwd - absolute project directory.
 * @returns {string} one filesystem-safe directory name, `--…--`.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Encode a string as one safe path segment (session ids are unbranded input).
 * @param {string} raw - non-empty string to encode.
 * @returns {string} escaped segment; `session-<uuid>` round-trips unchanged.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Inverse of {@link encodeSegment}: recover the id a directory name encodes.
 *
 * Exact inverse only for strings this encoder produced; `undefined` means the
 * segment is not valid encoded output, which is how a foreign directory under
 * the store root is skipped rather than mistaken for a session.
 *
 * @param {string} segment - one directory name under a project directory.
 * @returns {string|undefined} the decoded id, or `undefined` when malformed.
 */
export function decodeSegment(segment) {
  if (segment.length === 0) return undefined
  let out = ''
  for (let i = 0; i < segment.length; ) {
    const ch = segment[i]
    if (ch !== '~') {
      if (!/^[A-Za-z0-9._-]$/.test(ch)) return undefined
      out += ch
      i += 1
      continue
    }
    const hex = segment.slice(i + 1, i + 5)
    if (!/^[0-9A-F]{4}$/.test(hex)) return undefined
    out += String.fromCharCode(Number.parseInt(hex, 16))
    i += 5
  }
  // Re-encode to confirm this segment is canonical (e.g. `~0041` must be `A`).
  return encodeSegment(out) === segment ? out : undefined
}

/** @param {string} root @param {string} cwd @returns {string} project directory. */
export function projectDir(root, cwd) {
  return join(root, projectKey(cwd))
}

/** @param {string} root @param {string} cwd @param {string} id @returns {string} */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/** Whether a path exists at all. */
const exists = async (p) => {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Whether a path exists and is a directory. */
const isDir = async (p) => {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Locate a session's directory on disk. The direct `projectKey(cwd)` guess is
 * tried first; a scan of `<root>/*` covers a cwd that was normalized
 * differently when the log was written.
 *
 * @param {string} root - session store root.
 * @param {string} cwd - the session's recorded cwd.
 * @param {string} sessionId - session id.
 * @returns {Promise<string|undefined>} the directory, when it exists.
 */
export async function locateSessionDir(root, cwd, sessionId) {
  const direct = sessionDir(root, cwd, sessionId)
  if (await isDir(direct)) return direct
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, encodeSegment(sessionId))
    if (await isDir(candidate)) return candidate
  }
  return undefined
}

/** Physical generation number parsed out of `session.vN.jsonl[.zstd]`. */
const generationOf = (name) => {
  const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * The session's current log file — highest released generation, like the
 * backend's own selection.
 * @param {string} dir - session directory.
 * @returns {Promise<{path: string, compressed: boolean}|undefined>}
 */
export async function currentLogFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  let best
  let bestGeneration = -1
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const generation = generationOf(entry.name)
    if (generation === undefined || generation <= bestGeneration) continue
    best = entry.name
    bestGeneration = generation
  }
  if (best === undefined) return undefined
  return { path: join(dir, best), compressed: best.endsWith('.zstd') }
}

/** Every offset where a Zstandard frame magic begins. */
function magicOffsets(buf) {
  const offsets = []
  let at = 0
  for (;;) {
    const hit = buf.indexOf(MAGIC, at)
    if (hit === -1) return offsets
    offsets.push(hit)
    at = hit + 4
  }
}

/**
 * Read the log's physical header without touching anything after it.
 *
 * Frame boundaries are found by magic scan and then VERIFIED: a candidate end
 * counts only when the bytes before it decompress to a JSONL line that is a
 * valid session header for `expectId`. A magic that happens to occur inside
 * compressed data is therefore skipped instead of truncating the log.
 *
 * @param {Buffer} buf - whole log file.
 * @param {string} expectId - session id the header must name.
 * @returns {{frameEnd: number, header: object}|undefined}
 */
export function readHeader(buf, expectId) {
  const candidates = magicOffsets(buf).slice(1)
  candidates.push(buf.length)
  for (const end of candidates) {
    try {
      const text = zstdDecompressSync(buf.subarray(0, end)).toString('utf8')
      const line = text.split('\n')[0]
      const header = JSON.parse(line)
      if (header?.type !== 'session') continue
      if (typeof header.id === 'string' && header.id !== expectId) continue
      if (typeof header.cwd !== 'string') continue
      return { frameEnd: end, header }
    } catch {
      /* not a frame boundary, or not a session header: try the next candidate */
    }
  }
  return undefined
}

/**
 * Every project directory currently holding this session.
 *
 * A cwd-agnostic scan, deliberately: the stored header is what says where a
 * session *belongs*, but the directory listing is what says where its bytes
 * *are*, and a move that failed mid-way leaves those two disagreeing. Returns
 * every hit so the caller can notice a duplicate instead of silently picking
 * one.
 *
 * @param {string} root - session store root.
 * @param {string} sessionId - session id.
 * @returns {Promise<string[]>} matching session directories, in scan order.
 */
export async function findSessionDirs(root, sessionId) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, encodeSegment(sessionId))
    if (await isDir(candidate)) found.push(candidate)
  }
  return found
}

/**
 * Every session id present in the store, with the directory holding it.
 *
 * Reads directory names only — no header decode — so it stays cheap enough to
 * run on every move. `encodeSegment` is injective, so a directory name decodes
 * back to exactly one id.
 *
 * @param {string} root - session store root.
 * @returns {Promise<Map<string, string>>} sessionId → session directory.
 */
export async function indexStore(root) {
  const index = new Map()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return index
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const id = decodeSegment(session.name)
      if (id === undefined) continue
      // First hit wins; a duplicate id in two project directories is the
      // caller's business (relocateSession reports it).
      if (!index.has(id)) index.set(id, join(root, project.name, session.name))
    }
  }
  return index
}

/**
 * Read only a log's header, from a bounded prefix of the file.
 *
 * The header is the log's first frame and runs to a couple hundred bytes, so
 * building the fork tree over a whole store must not read every session's full
 * multi-megabyte log. {@link readHeader} verifies the frame boundary, so a
 * truncated read either yields the header or yields nothing — never a
 * half-decoded one.
 *
 * @param {string} dir - session directory.
 * @param {string} sessionId - session id.
 * @param {number} [maxBytes] - how much of the file to read.
 * @returns {Promise<object|undefined>} the stored header, when readable.
 */
export async function readHeaderPrefix(dir, sessionId, maxBytes = 8192) {
  const log = await currentLogFile(dir)
  if (log === undefined) return undefined
  let handle
  try {
    handle = await open(log.path, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const prefix = buffer.subarray(0, bytesRead)
    if (log.compressed) return readHeader(prefix, sessionId)?.header
    return readRawHeader(prefix, sessionId).header
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * Read a session directory's current log and stored header, without writing.
 *
 * @param {string} dir - session directory.
 * @param {string} sessionId - session id.
 * @returns {Promise<{log: {path: string, compressed: boolean}, header: object, buf: Buffer}|undefined>}
 */
export async function readSessionState(dir, sessionId) {
  const log = await currentLogFile(dir)
  if (log === undefined) return undefined
  const buf = await readFile(log.path)
  try {
    const found = log.compressed ? readHeader(buf, sessionId) : readRawHeader(buf, sessionId)
    if (found === undefined) return undefined
    return { log, header: found.header, buf }
  } catch {
    return undefined
  }
}

/**
 * Rebuild a log with the same header except for a new `cwd`.
 *
 * @param {Buffer} buf - original log bytes.
 * @param {string} newCwd - the project directory the session moves to.
 * @param {string} sessionId - session id.
 * @returns {{content: Buffer, header: object, frameEnd: number}}
 */
export function rewriteHeaderCwd(buf, newCwd, sessionId) {
  const found = readHeader(buf, sessionId)
  if (found === undefined) throw new Error(`session log holds no readable header for '${sessionId}'`)
  const header = { ...found.header, cwd: newCwd }
  const line = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')
  return {
    content: Buffer.concat([zstdCompressSync(line), buf.subarray(found.frameEnd)]),
    header,
    frameEnd: found.frameEnd
  }
}

/**
 * Read the plain-text (compression: none) first line as a header.
 * @param {Buffer} buf @param {string} sessionId
 */
export function readRawHeader(buf, sessionId) {
  const newline = buf.indexOf(0x0a)
  const text = buf.subarray(0, newline === -1 ? buf.length : newline).toString('utf8')
  const header = JSON.parse(text)
  if (header?.type !== 'session' || header.id !== sessionId) throw new Error('not a session header')
  return { frameEnd: newline === -1 ? buf.length : newline + 1, header }
}

/**
 * Re-encode a log's header with a new cwd.
 * @param {Buffer} buf @param {string} newCwd @param {string} sessionId
 * @param {boolean} compressed
 * @returns {{content: Buffer, header: object}}
 */
function rewriteHeader(buf, newCwd, sessionId, compressed) {
  if (compressed) return rewriteHeaderCwd(buf, newCwd, sessionId)
  const found = readRawHeader(buf, sessionId)
  return {
    content: Buffer.concat([
      Buffer.from(`${JSON.stringify({ ...found.header, cwd: newCwd })}\n`, 'utf8'),
      buf.subarray(found.frameEnd)
    ]),
    header: { ...found.header, cwd: newCwd }
  }
}

/**
 * Move a session's bytes into the project directory of `newCwd`, rewriting the
 * stored header's cwd on the way.
 *
 * Idempotent by construction: when the session is already in the target
 * directory it rewrites the header in place instead of copying onto itself,
 * and an occupied destination is a reported conflict rather than an
 * overwrite. The old directory is relocated (never copied-and-deleted), so a
 * crash can leave at most one of the two.
 *
 * @param {object} args
 * @param {string} args.root - session store root.
 * @param {string} args.dir - the session directory found on disk.
 * @param {string} args.newCwd - project directory to move the session to.
 * @param {string} args.sessionId
 * @param {string} args.backupRoot - where the pre-move directory is parked.
 * @returns {Promise<{header: object, from: string, to: string, backup?: string, relocated: boolean}>}
 */
export async function relocateSession({ root, dir, newCwd, sessionId, backupRoot }) {
  const state = await readSessionState(dir, sessionId)
  if (state === undefined) throw new Error(`session directory '${dir}' holds no readable session log`)

  const { log, buf } = state
  const name = log.path.slice(dir.length + 1)
  const to = sessionDir(root, newCwd, sessionId)

  // Bytes already sit in the target project directory: rewrite the header
  // where it lies, whether or not the header agrees yet. This is the repair
  // path for a move that landed the bytes and then failed before the header
  // (or the ledger) caught up — the exact state that used to collide with
  // itself and fail EEXIST on a re-drop.
  if (to === dir) {
    const { content, header } = rewriteHeader(buf, newCwd, sessionId, log.compressed)
    if (!buf.equals(content)) await writeFile(log.path, content)
    return { header, from: dir, to, relocated: false }
  }

  // A different directory already holds a log for this session: refuse rather
  // than clobber it.
  if ((await isDir(to)) && (await exists(join(to, name)))) {
    throw new Error(`destination already holds a log for '${sessionId}': ${join(to, name)}`)
  }

  const { content, header } = rewriteHeader(buf, newCwd, sessionId, log.compressed)
  if (log.compressed) {
    const again = readHeader(content, sessionId)
    if (again === undefined || again.header.cwd !== newCwd || again.header.id !== sessionId) {
      throw new Error('rewritten session log failed its own header re-read')
    }
  }

  await mkdir(to, { recursive: true })
  await writeFile(join(to, name), content, { flag: 'wx' })

  // Everything else the session owns (older generations, side artifacts).
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === name) continue
    await rename(join(dir, entry.name), join(to, entry.name))
  }

  await mkdir(backupRoot, { recursive: true })
  const backup = join(backupRoot, `${sessionId}-${Date.now()}`)
  await rename(dir, backup)

  return { header, from: dir, to, backup, relocated: true }
}
