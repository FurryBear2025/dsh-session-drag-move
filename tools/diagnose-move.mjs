/**
 * Diagnose a session's on-disk state: every project directory that holds it,
 * the cwd each stored header claims, the workspace ledger, and the backup area.
 *
 *   node tools/diagnose-move.mjs <sessionId>
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const root = join(homedir(), '.dsh', 'sessions')
const backupRoot = join(dirname(root), 'session-drag-move-backup')
const sessionId = process.argv[2]

if (!sessionId) {
  console.error('usage: node tools/diagnose-move.mjs <sessionId>')
  process.exit(2)
}

const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function headerOf(buf) {
  const offsets = []
  let at = 0
  for (;;) {
    const hit = buf.indexOf(MAGIC, at)
    if (hit === -1) break
    offsets.push(hit)
    at = hit + 4
  }
  const candidates = offsets.slice(1)
  candidates.push(buf.length)
  for (const end of candidates) {
    try {
      const text = zstdDecompressSync(buf.subarray(0, end)).toString('utf8')
      const h = JSON.parse(text.split('\n')[0])
      if (h?.type === 'session') return h
    } catch {
      /* not a boundary */
    }
  }
  return undefined
}

console.log(`session: ${sessionId}`)
console.log(`root:    ${root}`)
console.log(`backup:  ${backupRoot}\n`)

console.log('=== project directories holding this session ===')
const projects = await readdir(root, { withFileTypes: true })
let found = 0
for (const project of projects) {
  if (!project.isDirectory()) continue
  const dir = join(root, project.name, sessionId)
  if (!(await exists(dir))) continue
  found++
  const s = await stat(dir)
  console.log(`\n[${found}] ${project.name}`)
  console.log(`    dir mtime : ${s.mtime.toISOString()}`)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const f = await stat(join(dir, entry.name))
    console.log(`    ${entry.name}  ${f.size} bytes  mtime ${f.mtime.toISOString()}`)
    if (/\.jsonl(\.zstd)?$/.test(entry.name)) {
      const buf = await readFile(join(dir, entry.name))
      const h = headerOf(buf)
      console.log(`      -> header.cwd = ${h?.cwd ?? '(unreadable)'}  id=${h?.id ?? '?'}`)
    }
  }
}
if (found === 0) console.log('  (none)')

console.log('\n=== workspace ledger ===')
try {
  const ws = JSON.parse(await readFile(join(homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8'))
  const tables = ws?.tables ?? {}
  for (const [id, record] of Object.entries(tables.workspaces ?? {})) {
    const has = Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)
    console.log(`${has ? '  <-- HERE' : '          '}  ${id}`)
    console.log(`             path=${record.path}`)
    console.log(`             sessionIds=${JSON.stringify(record.sessionIds ?? [])}`)
    if (has) console.log(`             ^ this session is in this ledger`)
  }
  console.log(`  defaultWorkspaceId=${ws?.global?.defaultWorkspaceId}`)
} catch (error) {
  console.log(`  unreadable: ${error.message}`)
}

console.log('\n=== backup area ===')
try {
  const entries = await readdir(backupRoot, { withFileTypes: true })
  for (const entry of entries) {
    const s = await stat(join(backupRoot, entry.name))
    console.log(`  ${entry.name}  (${entry.isDirectory() ? 'dir' : 'file'})  mtime ${s.mtime.toISOString()}`)
  }
  if (entries.length === 0) console.log('  (empty)')
} catch {
  console.log('  (missing)')
}
