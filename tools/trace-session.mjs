/**
 * Trace one session: where its bytes are, what the CURRENT header claims, and
 * what the PRE-MOVE backup header claimed.
 *
 *   node tools/trace-session.mjs <sessionId>
 *
 * The backup's header is the decisive evidence for "did this plugin move the
 * session, and from where": the backup is the original directory renamed
 * aside, so its stored cwd is the state before the move.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { findSessionDirs, readSessionState } from '../lib/session-log.js'

const root = join(homedir(), '.dsh', 'sessions')
const backupRoot = join(dirname(root), 'session-drag-move-backup')
const projCache = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
const sessionId = process.argv[2]

if (!sessionId) {
  console.error('usage: node tools/trace-session.mjs <sessionId>')
  process.exit(2)
}

const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
const brief = (header) => ({
  cwd: header.cwd,
  parent: header.parentSession ?? null,
  isSeeded: header.isSeeded,
  inherited: header.inheritedEventCount,
  createdAt: header.createdAt === undefined ? null : `${header.createdAt} (${local(header.createdAt)})`
})

console.log(`session: ${sessionId}\n`)

console.log('=== bytes on disk ===')
for (const dir of await findSessionDirs(root, sessionId)) {
  const info = await stat(dir)
  console.log(`dir  : ${dir}`)
  console.log(`mtime: ${local(info.mtimeMs)}`)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const f = await stat(join(dir, entry.name))
    console.log(`  ${entry.name}  ${f.size}B  mtime ${local(f.mtimeMs)}`)
  }
  const state = await readSessionState(dir, sessionId)
  console.log(`header: ${JSON.stringify(brief(state?.header ?? {}), null, 2)}`)
  console.log('')
}

console.log('=== backups (pre-move originals) ===')
let seen = 0
try {
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(sessionId)) continue
    seen++
    const dir = join(backupRoot, entry.name)
    const info = await stat(dir)
    const stamp = Number(entry.name.slice(sessionId.length + 1))
    console.log(`dir  : ${entry.name}`)
    console.log(`mtime: ${local(info.mtimeMs)}   stamp=${Number.isFinite(stamp) ? `${stamp} (${local(stamp)})` : 'n/a'}`)
    const state = await readSessionState(dir, sessionId)
    console.log(`header: ${JSON.stringify(brief(state?.header ?? {}), null, 2)}`)
    console.log('')
  }
  if (seen === 0) console.log('(none)\n')
} catch {
  console.log('(backup root missing)\n')
}

console.log('=== projection cache (host-side, may lag) ===')
try {
  const doc = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(join(projCache, `${sessionId}.json`), 'utf8')))
  const identity = doc.record.identity
  console.log(JSON.stringify({
    title: doc.record.rows.title?.val,
    cwd: identity.cwd,
    isSeeded: identity.isSeeded,
    inherited: identity.inheritedEventCount,
    createdAt: local(identity.createdAt)
  }, null, 2))
} catch (error) {
  console.log(`(unreadable: ${error.message})`)
}
