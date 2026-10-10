/**
 * Full inventory: every session on disk, what its header claims, what the
 * ledger says, and whether it is a fork.
 *
 *   node tools/list-sessions.mjs
 *
 * Built to answer one question precisely: a session whose stored cwd differs
 * from the workspace that lists it can be an interrupted move OR an ordinary
 * fork, and those want opposite repairs. `parentSession` is the tell.
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { findSessionDirs, readSessionState } from '../lib/session-log.js'

const root = join(homedir(), '.dsh', 'sessions')
const projCacheDir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
const ledgerPath = join(homedir(), '.dsh', 'storages', 'workspace.json')

const titleOf = async (id) => {
  try {
    const doc = JSON.parse(await readFile(join(projCacheDir, `${id}.json`), 'utf8'))
    return doc?.record?.rows?.title?.val ?? '(untitled)'
  } catch {
    return '(no cache)'
  }
}

// Ledger: sessionId -> [workspaceId, ...]
const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
const workspaces = ledger?.tables?.workspaces ?? {}
const ledgerOf = new Map()
for (const [wsId, record] of Object.entries(workspaces)) {
  for (const sid of record.sessionIds ?? []) {
    if (!ledgerOf.has(sid)) ledgerOf.set(sid, [])
    ledgerOf.get(sid).push({ wsId, path: record.path })
  }
}

// Disk: sessionId -> directories
const dirsOf = new Map()
for (const project of await readdir(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    if (!dirsOf.has(session.name)) dirsOf.set(session.name, [])
    dirsOf.get(session.name).push({ project: project.name, dir: join(root, project.name, session.name) })
  }
}

console.log(`workspaces:`)
for (const [id, record] of Object.entries(workspaces)) {
  console.log(`  ${id}  path=${record.path}  sessions=${(record.sessionIds ?? []).length}`)
}

console.log(`\n${dirsOf.size} sessions on disk\n`)

for (const [sessionId, places] of dirsOf) {
  const title = await titleOf(sessionId)
  const owners = ledgerOf.get(sessionId) ?? []
  const state = await readSessionState(places[0].dir, sessionId)
  const header = state?.header ?? {}
  const cwd = header.cwd
  const ownersMatch = owners.filter((o) => o.path === cwd)
  const ownersStale = owners.filter((o) => o.path !== cwd)

  const flags = []
  if (places.length > 1) flags.push(`DUPLICATE-DIRS(${places.length})`)
  if (header.parentSession !== undefined) flags.push(`FORK-of=${header.parentSession}`)
  if (header.inheritedEventCount > 0) flags.push(`inherited=${header.inheritedEventCount}`)
  if (owners.length === 0) flags.push('NO-LEDGER-OWNER')
  else if (ownersMatch.length === 0) flags.push('LEDGER-DISAGREES')
  else if (ownersStale.length > 0) flags.push('STALE-LEDGER-ENTRY')

  console.log(`${flags.length > 0 ? '!!' : '  '} ${title}`)
  console.log(`     id       : ${sessionId}`)
  console.log(`     header   : cwd=${cwd ?? '(none)'}${header.parentSession ? ` parent=${header.parentSession}` : ''}`)
  console.log(`     on disk  : ${places.map((p) => p.project).join(' , ')}`)
  console.log(`     ledger   : ${owners.length === 0 ? '(none)' : owners.map((o) => `${o.wsId.slice(0, 8)}${o.path === cwd ? '(match)' : '(MISMATCH)'}`).join(' , ')}`)
  if (flags.length > 0) console.log(`     flags    : ${flags.join(' ')}`)
  console.log('')
}
