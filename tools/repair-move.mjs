/**
 * Make the workspace ledger agree with where a session's bytes actually live.
 *
 *   node tools/repair-move.mjs <sessionId> [--apply]
 *
 * Membership is DERIVED, not stored: a workspace owns exactly the sessions
 * whose stored header cwd is its path. The ledger is only the display order
 * within that set — but a workspace's view of its set comes from the ledger,
 * so a session whose bytes moved while its ledger entry did not shows up in
 * the WRONG workspace, and a session with no ledger entry shows up in NONE.
 *
 * This tool therefore does both directions:
 *   1. drop the id from every workspace whose path is not the stored cwd;
 *   2. prepend it to the workspace whose path IS the stored cwd, when that
 *      workspace exists and does not already list it.
 *
 * Without --apply it only reports. With --apply it writes workspace.json after
 * saving a timestamped backup.
 */
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findSessionDirs, readSessionState } from '../lib/session-log.js'

const root = join(homedir(), '.dsh', 'sessions')
const ledgerPath = join(homedir(), '.dsh', 'storages', 'workspace.json')
const sessionId = process.argv[2]
const apply = process.argv.includes('--apply')

if (!sessionId) {
  console.error('usage: node tools/repair-move.mjs <sessionId> [--apply]')
  process.exit(2)
}

// 1. Where the bytes are and what cwd they claim.
const dirs = await findSessionDirs(root, sessionId)
if (dirs.length === 0) {
  console.error(`no session directory for '${sessionId}' under ${root}`)
  process.exit(1)
}
if (dirs.length > 1) {
  console.error(`'${sessionId}' exists in ${dirs.length} project directories:`)
  for (const dir of dirs) console.error(`  ${dir}`)
  console.error('\nResolve the duplicate by hand before repairing.')
  process.exit(1)
}

const state = await readSessionState(dirs[0], sessionId)
if (state === undefined) {
  console.error(`session directory ${dirs[0]} holds no readable log`)
  process.exit(1)
}
const cwd = state.header.cwd
console.log(`bytes      : ${dirs[0]}`)
console.log(`header cwd : ${cwd}\n`)

// 2. Read the ledger.
const raw = await readFile(ledgerPath, 'utf8')
const document = JSON.parse(raw)
const workspaces = document?.tables?.workspaces ?? {}

const owners = Object.entries(workspaces).filter(([, record]) =>
  Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId))
const destination = Object.entries(workspaces).find(([, record]) => record.path === cwd)

console.log('ledger:')
for (const [id, record] of owners) {
  console.log(`  ${record.path === cwd ? 'ok    ' : 'STALE '} ${id}  path=${record.path}`)
}
if (owners.length === 0) console.log('  (no workspace lists this session)')
if (destination === undefined) {
  console.log(`\nNo workspace is registered for '${cwd}'.`)
  console.log('Add that directory as a workspace in the app; it will then adopt this session on its own.')
  process.exit(owners.some(([, r]) => r.path !== cwd) ? 0 : 0)
}
console.log(`  target ${destination[0]}  path=${destination[1].path}${destination[1].sessionIds.includes(sessionId) ? '  (already lists it)' : '  (will adopt it)'}`)

const stale = owners.filter(([, record]) => record.path !== cwd)
const needsAdopt = !destination[1].sessionIds.includes(sessionId)
if (stale.length === 0 && !needsAdopt) {
  console.log('\nLedger already agrees. Nothing to repair.')
  process.exit(0)
}

if (!apply) {
  console.log(`\nDry run: drop ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}, adopt into ${needsAdopt ? destination[0] : '1 workspace (already listed)'}.`)
  console.log('Re-run with --apply to write it.')
  process.exit(0)
}

// 3. Write both directions, touching nothing else.
const backupPath = `${ledgerPath}.bak-repair-${Date.now()}`
await copyFile(ledgerPath, backupPath)

for (const [id, record] of stale) {
  record.sessionIds = record.sessionIds.filter((candidate) => candidate !== sessionId)
  console.log(`dropped '${sessionId}' from workspace ${id}`)
}
if (needsAdopt) {
  // Prepend, the same placement the domain's own attach uses for a new member.
  destination[1].sessionIds = [sessionId, ...(destination[1].sessionIds ?? [])]
  console.log(`adopted '${sessionId}' into workspace ${destination[0]}`)
}

await writeFile(ledgerPath, `${JSON.stringify(document, null, 2)}\n`)
const info = await stat(backupPath)
console.log(`\nbackup: ${backupPath} (${info.size} bytes)`)
console.log('Restart DSH so the workspace registry rebuilds from the repaired ledger.')
