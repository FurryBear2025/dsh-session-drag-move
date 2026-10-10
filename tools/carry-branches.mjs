/**
 * Move a session's fork branches into a workspace, without moving the session.
 *
 *   node tools/carry-branches.mjs <sessionId> <targetWorkspacePath> [--apply]
 *
 * This is the standalone form of what a drag now does: a fork belongs in its
 * parent's workspace, so the whole branch subtree follows. Used here to reunite
 * a family whose parent was already moved before the rule existed.
 *
 * The target is given as a WORKSPACE PATH (a real directory) rather than a
 * workspace id, because the workspace registry only exists inside the running
 * host; membership is derived from the stored cwd, so writing that cwd is all
 * that is needed and the next start picks it up.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'

import { findSessionDirs, indexStore, readHeaderPrefix, readSessionState, relocateSession } from '../lib/session-log.js'
import { forkTree, descendantsOf, ancestorsOf } from '../lib/fork-tree.js'

const root = join(homedir(), '.dsh', 'sessions')
const backupRoot = join(dirname(root), 'session-drag-move-backup')
const sessionId = process.argv[2]
const targetArg = process.argv[3]
const apply = process.argv.includes('--apply')

if (!sessionId || !targetArg) {
  console.error('usage: node tools/carry-branches.mjs <sessionId> <targetWorkspacePath> [--apply]')
  process.exit(2)
}

let targetPath
try {
  targetPath = await realpath(resolve(targetArg))
} catch (error) {
  console.error(`target workspace path does not resolve: ${targetArg} (${error.message})`)
  process.exit(1)
}

const store = await indexStore(root)
if (!store.has(sessionId)) {
  console.error(`session '${sessionId}' not found under ${root}`)
  process.exit(1)
}

const headers = []
for (const [id, dir] of store) {
  const header = await readHeaderPrefix(dir, id)
  if (header !== undefined) headers.push(header)
}
const tree = forkTree(headers)
const branch = descendantsOf(tree, sessionId)
const ancestors = ancestorsOf(tree, sessionId)

console.log(`origin : ${sessionId}`)
const originHeader = headers.find((h) => h.id === sessionId)
console.log(`         cwd=${originHeader?.cwd}`)
if (ancestors.length > 0) {
  console.log(`ancestors: ${ancestors.join(' , ')}  (not moved — only descendants follow)`)
}
console.log(`target : ${targetPath}`)
console.log(`branches to carry: ${branch.length}`)

const plan = []
for (const id of branch) {
  const dirs = await findSessionDirs(root, id)
  if (dirs.length !== 1) {
    plan.push({ id, action: 'skip', reason: dirs.length === 0 ? 'no directory' : `${dirs.length} directories` })
    continue
  }
  const state = await readSessionState(dirs[0], id)
  const cwd = state?.header?.cwd
  plan.push({ id, dir: dirs[0], cwd, action: cwd === targetPath ? 'already-there' : 'move' })
}

for (const item of plan) {
  console.log(`  ${item.action.padEnd(12)} ${item.id}${item.cwd ? `  (${item.cwd})` : ''}${item.reason ? `  [${item.reason}]` : ''}`)
}

const todo = plan.filter((item) => item.action === 'move')
if (todo.length === 0) {
  console.log('\nNothing to move.')
  process.exit(0)
}
if (!apply) {
  console.log(`\nDry run. Re-run with --apply to move ${todo.length} branch(es).`)
  process.exit(0)
}

console.log('')
for (const item of todo) {
  try {
    const result = await relocateSession({
      root,
      dir: item.dir,
      newCwd: targetPath,
      sessionId: item.id,
      backupRoot
    })
    console.log(`moved ${item.id} -> ${result.to}`)
  } catch (error) {
    console.error(`FAILED ${item.id}: ${error.message}`)
  }
}
console.log('\nRestart DSH so the workspace registry rebuilds membership from the new cwds.')
