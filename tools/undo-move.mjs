/**
 * Undo one move: put a session back where its pre-move backup says it lived.
 *
 *   node tools/undo-move.mjs <sessionId> [--apply]
 *
 * The backup directory is the original session directory renamed aside, so its
 * stored header holds the cwd from BEFORE the move. That makes it the only
 * trustworthy source for "where did this come from" — the current header has
 * already been rewritten, and the projection cache may lag either way.
 *
 * Nothing touches the workspace ledger: membership is derived from the stored
 * cwd, so restoring the cwd restores the original workspace on its own.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { findSessionDirs, readSessionState, relocateSession } from '../lib/session-log.js'

const root = join(homedir(), '.dsh', 'sessions')
const backupRoot = join(dirname(root), 'session-drag-move-backup')
const sessionId = process.argv[2]
const apply = process.argv.includes('--apply')

if (!sessionId) {
  console.error('usage: node tools/undo-move.mjs <sessionId> [--apply]')
  process.exit(2)
}

// 1. Newest backup = the state before the most recent move.
let backups = []
try {
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${sessionId}-`)) continue
    const stamp = Number(entry.name.slice(sessionId.length + 1))
    backups.push({ name: entry.name, dir: join(backupRoot, entry.name), stamp: Number.isFinite(stamp) ? stamp : 0 })
  }
} catch {
  /* no backup area yet */
}
backups.sort((a, b) => b.stamp - a.stamp)

if (backups.length === 0) {
  console.error(`no backup for '${sessionId}' under ${backupRoot} — nothing to undo from`)
  process.exit(1)
}

const newest = backups[0]
const original = await readSessionState(newest.dir, sessionId)
if (original === undefined) {
  console.error(`backup ${newest.name} holds no readable session log`)
  process.exit(1)
}

const current = await findSessionDirs(root, sessionId)
if (current.length === 0) {
  console.error(`no live session directory for '${sessionId}' under ${root}`)
  process.exit(1)
}

const from = current[0]
const now = await readSessionState(from, sessionId)

console.log(`session  : ${sessionId}`)
console.log(`now      : ${now?.header?.cwd ?? '(unreadable)'}`)
console.log(`           ${from}`)
console.log(`restore  : ${original.header.cwd}`)
console.log(`           (from backup ${newest.name}, ${new Date(newest.stamp).toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' })})`)
console.log(`other backups: ${backups.slice(1).map((b) => b.name).join(', ') || '(none)'}`)

if ((now?.header?.cwd ?? '') === original.header.cwd) {
  console.log('\nAlready at the original cwd — nothing to undo.')
  process.exit(0)
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to move it back.')
  process.exit(0)
}

const result = await relocateSession({
  root,
  dir: from,
  newCwd: original.header.cwd,
  sessionId,
  backupRoot
})

console.log(`\nrestored to ${result.to}`)
console.log(`previous location parked at ${result.backup}`)
const after = await readSessionState(result.to, sessionId)
console.log(`header.cwd is now ${after?.header?.cwd}`)
console.log('\nRestart DSH so the workspace registry rebuilds membership from the restored cwd.')
