/**
 * Smoke tests for dsh-session-drag-move.
 *
 *   node --test tests/
 *
 * The header tests use a real session log from this machine when one is
 * available, plus a synthetic log, so the frame-splice is exercised both ways.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  projectKey,
  encodeSegment,
  decodeSegment,
  sessionDir,
  readHeader,
  readHeaderPrefix,
  rewriteHeaderCwd,
  findSessionDirs,
  readSessionState,
  relocateSession,
  indexStore
} from '../lib/session-log.js'
import { forkTree, descendantsOf, ancestorsOf, familyOf } from '../lib/fork-tree.js'

test('projectKey matches the directories the shipped backend creates', () => {
  assert.equal(projectKey('E:\\dsh插件开发'), '--E-dsh~63D2~4EF6~5F00~53D1--')
  assert.equal(projectKey('E:\\光影逆向开发'), '--E-~5149~5F71~9006~5411~5F00~53D1--')
  assert.equal(
    projectKey('C:\\Users\\Admin\\Documents\\deepseek-harness\\default-workspace'),
    '--C-Users-Admin-Documents-deepseek-harness-default-workspace--'
  )
  // A separator run collapses to one dash, which is why the default workspace
  // key has no doubled dash after the drive letter.
  assert.equal(projectKey('/srv/a//b'), '--srv-a-b--')
})

test('session ids survive encoding unchanged', () => {
  assert.equal(encodeSegment('session-e1897ec2-ebfa-44c9-b844-fdb09b062249'), 'session-e1897ec2-ebfa-44c9-b844-fdb09b062249')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('decodeSegment inverts encodeSegment, and rejects foreign names', () => {
  for (const raw of ['session-e1897ec2-ebfa-44c9-b844-fdb09b062249', '..', 'a b', '中文 id', '~tilde', 'ünïcøde']) {
    assert.equal(decodeSegment(encodeSegment(raw)), raw, `round-trip ${JSON.stringify(raw)}`)
  }
  // Names this encoder would never emit are skipped, not guessed at.
  for (const bad of ['~0041', '~XYZ1', 'has space', '']) {
    assert.equal(decodeSegment(bad), undefined, `reject ${JSON.stringify(bad)}`)
  }
})

test('sessionDir composes root, project key and session id', () => {
  assert.equal(
    sessionDir('/root', 'E:\\dsh插件开发', 'session-abc'),
    join('/root', '--E-dsh~63D2~4EF6~5F00~53D1--', 'session-abc')
  )
})

/** header frame + two opaque batch frames, like a real log. */
function syntheticLog(header) {
  const line = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')
  const batch = zstdCompressSync(Buffer.from('{"seq":1}\n{"seq":2}\n', 'utf8'))
  return Buffer.concat([zstdCompressSync(line), batch, batch])
}

const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-abc-0001',
  createdAt: 1700000000000,
  cwd: 'C:\\Users\\Admin\\Documents\\deepseek-harness\\default-workspace',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard'
}

test('readHeader finds the first frame and verifies it against the session id', () => {
  const buf = syntheticLog(HEADER)
  const found = readHeader(buf, 'session-abc-0001')
  assert.ok(found !== undefined)
  assert.equal(found.header.cwd, HEADER.cwd)
  assert.equal(found.header.id, 'session-abc-0001')
  // Nothing after the header frame may be consumed by the header read.
  assert.ok(found.frameEnd > 0 && found.frameEnd < buf.length)
})

test('readHeader refuses a header naming a different session', () => {
  assert.equal(readHeader(syntheticLog(HEADER), 'session-other'), undefined)
})

test('rewriteHeaderCwd changes only the cwd and preserves every later byte', () => {
  const buf = syntheticLog(HEADER)
  const { content, header } = rewriteHeaderCwd(buf, 'E:\\光影逆向开发', 'session-abc-0001')
  assert.equal(header.cwd, 'E:\\光影逆向开发')
  assert.equal(header.id, HEADER.id)
  assert.equal(header.createdAt, HEADER.createdAt)
  assert.equal(header.agentPreset, HEADER.agentPreset)

  const again = readHeader(content, 'session-abc-0001')
  assert.ok(again !== undefined)
  assert.equal(again.header.cwd, 'E:\\光影逆向开发')
  // Tail bytes are copied verbatim: the batch frames still decode as before.
  assert.equal(content.length - again.frameEnd, buf.length - readHeader(buf, 'session-abc-0001').frameEnd)
  assert.deepEqual(content.subarray(again.frameEnd), buf.subarray(readHeader(buf, 'session-abc-0001').frameEnd))
})

const SAMPLE = 'C:\\Users\\Admin\\.dsh\\sessions\\--E-dsh~63D2~4EF6~5F00~53D1--\\session-e1897ec2-ebfa-44c9-b844-fdb09b062249\\session.v4.jsonl.zstd'

test('a real session log round-trips through a cwd rewrite', async (t) => {
  if (!existsSync(SAMPLE)) return t.skip(`sample log missing: ${SAMPLE}`)
  const buf = await readFile(SAMPLE)
  const original = readHeader(buf, 'session-e1897ec2-ebfa-44c9-b844-fdb09b062249')
  assert.ok(original !== undefined, 'the real log must yield a session header')
  const { content, header } = rewriteHeaderCwd(buf, 'E:\\光影逆向开发', 'session-e1897ec2-ebfa-44c9-b844-fdb09b062249')
  assert.equal(header.cwd, 'E:\\光影逆向开发')
  const again = readHeader(content, 'session-e1897ec2-ebfa-44c9-b844-fdb09b062249')
  assert.ok(again !== undefined)
  assert.equal(again.header.cwd, 'E:\\光影逆向开发')
  assert.deepEqual(content.subarray(again.frameEnd), buf.subarray(original.frameEnd))
})

/* ---------------------------------------------------------------------------
 * Move mechanics on a real temporary store.
 *
 * These cover the regression that produced
 *   EEXIST: file already exists, open '...\session.v4.jsonl.zstd'
 * — a session whose bytes had already landed in the target project directory
 * while its stored header still named the old one. Re-dropping it must repair
 * the header, not collide with its own file.
 * ------------------------------------------------------------------------- */

const ID = 'session-abc-0001'
const WORK = 'C:\\work\\alpha'
const OTHER = 'E:\\work\\beta'

/** Build a store holding one session under `cwd`, header included. */
async function makeStore(cwd) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  const dir = sessionDir(root, cwd, ID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), syntheticLog({ ...HEADER, id: ID, cwd }))
  return root
}

test('relocateSession moves bytes and rewrites the header cwd', async (t) => {
  const root = await makeStore(WORK)
  t.after(() => rm(root, { recursive: true, force: true }))
  const backupRoot = join(root, '..', `dsh-move-backup-${Date.now()}`)

  const from = sessionDir(root, WORK, ID)
  const result = await relocateSession({ root, dir: from, newCwd: OTHER, sessionId: ID, backupRoot })

  assert.equal(result.relocated, true)
  assert.equal(result.header.cwd, OTHER)
  const to = sessionDir(root, OTHER, ID)
  const moved = await readSessionState(to, ID)
  assert.ok(moved !== undefined, 'the log must exist under the new project directory')
  assert.equal(moved.header.cwd, OTHER)
  assert.equal((await findSessionDirs(root, ID)).length, 1)
  assert.ok(existsSync(result.backup), 'the pre-move directory is parked, never deleted')
})

test('re-moving a session already in place repairs the header instead of EEXIST', async (t) => {
  const root = await makeStore(WORK)
  t.after(() => rm(root, { recursive: true, force: true }))
  const backupRoot = join(root, '..', `dsh-move-backup-${Date.now()}`)
  const dir = sessionDir(root, WORK, ID)

  // First drop: bytes land under OTHER.
  await relocateSession({ root, dir, newCwd: OTHER, sessionId: ID, backupRoot })

  // Simulate the interrupted move: bytes are under OTHER, header says WORK.
  const target = sessionDir(root, OTHER, ID)
  const stale = syntheticLog({ ...HEADER, id: ID, cwd: WORK })
  await writeFile(join(target, 'session.v4.jsonl.zstd'), stale)
  await rm(dir, { recursive: true, force: true })

  // Re-drop onto the same target: this is the call that used to throw EEXIST.
  const repaired = await relocateSession({ root, dir: target, newCwd: OTHER, sessionId: ID, backupRoot })
  assert.equal(repaired.relocated, false)
  assert.equal(repaired.header.cwd, OTHER)

  const after = await readSessionState(target, ID)
  assert.equal(after.header.cwd, OTHER, 'the stale header must be rewritten in place')
  // Event bytes are still intact behind the rewritten header.
  const originalTail = stale.subarray(readHeader(stale, ID).frameEnd)
  assert.deepEqual(after.buf.subarray(readHeader(after.buf, ID).frameEnd), originalTail)
})

test('findSessionDirs reports the true location even when the header disagrees', async (t) => {
  const root = await makeStore(WORK)
  t.after(() => rm(root, { recursive: true, force: true }))

  // Bytes under OTHER, header claiming WORK: a cwd-derived lookup would miss.
  const target = sessionDir(root, OTHER, ID)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'session.v4.jsonl.zstd'), syntheticLog({ ...HEADER, id: ID, cwd: WORK }))
  await rm(sessionDir(root, WORK, ID), { recursive: true, force: true })

  const dirs = await findSessionDirs(root, ID)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0], target)
})

test('an occupied destination is a reported conflict, not an overwrite', async (t) => {
  const root = await makeStore(WORK)
  t.after(() => rm(root, { recursive: true, force: true }))
  const backupRoot = join(root, '..', `dsh-move-backup-${Date.now()}`)

  // A different session directory already holds this id under OTHER.
  const target = sessionDir(root, OTHER, ID)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'session.v4.jsonl.zstd'), syntheticLog({ ...HEADER, id: ID, cwd: OTHER }))

  await assert.rejects(
    () => relocateSession({ root, dir: sessionDir(root, WORK, ID), newCwd: OTHER, sessionId: ID, backupRoot }),
    /destination already holds a log/
  )
  const entries = await readdir(target)
  assert.deepEqual(entries, ['session.v4.jsonl.zstd'])
})

/* ---------------------------------------------------------------------------
 * Fork family resolution.
 *
 * Topology mirrors this machine's real one:
 *   光影逆向 df42a8b8            (root)
 *     ├─ 光影逆向 (1) 4ca8395a   (fork of df42a8b8)
 *     └─ 光影逆向 (1) 5a86bbb5   (fork of df42a8b8)
 *          └─ 光影逆向 (2) d65074d5 (fork of 5a86bbb5)
 * ------------------------------------------------------------------------- */

const FAMILY = [
  { id: 'session-df42a8b8', cwd: 'E:\\光影逆向开发' },
  { id: 'session-4ca8395a', cwd: 'E:\\光影逆向开发', parentSession: 'session-df42a8b8' },
  { id: 'session-5a86bbb5', cwd: 'E:\\光影逆向开发', parentSession: 'session-df42a8b8' },
  { id: 'session-d65074d5', cwd: 'E:\\光影逆向开发', parentSession: 'session-5a86bbb5' },
  { id: 'session-unrelated', cwd: 'E:\\光影逆向开发' }
]

test('descendantsOf collects a branch transitively and ignores unrelated sessions', () => {
  const tree = forkTree(FAMILY)
  assert.deepEqual(descendantsOf(tree, 'session-df42a8b8').sort(), ['session-4ca8395a', 'session-5a86bbb5', 'session-d65074d5'])
  // Moving a branch carries its own subtree only — never its siblings.
  assert.deepEqual(descendantsOf(tree, 'session-5a86bbb5'), ['session-d65074d5'])
  assert.deepEqual(descendantsOf(tree, 'session-d65074d5'), [])
  assert.deepEqual(descendantsOf(tree, 'session-unrelated'), [])
  // The moved session is never its own descendant.
  assert.ok(!descendantsOf(tree, 'session-df42a8b8').includes('session-df42a8b8'))
})

test('ancestorsOf walks to the root, nearest first', () => {
  const tree = forkTree(FAMILY)
  assert.deepEqual(ancestorsOf(tree, 'session-d65074d5'), ['session-5a86bbb5', 'session-df42a8b8'])
  assert.deepEqual(ancestorsOf(tree, 'session-4ca8395a'), ['session-df42a8b8'])
  assert.deepEqual(ancestorsOf(tree, 'session-df42a8b8'), [])
})

test('familyOf returns the whole connected family from any member', () => {
  const tree = forkTree(FAMILY)
  const expected = ['session-df42a8b8', 'session-4ca8395a', 'session-5a86bbb5', 'session-d65074d5'].sort()
  for (const member of expected) {
    assert.deepEqual(familyOf(tree, member).sort(), expected, `family from ${member}`)
  }
})

test('an absent or self-referential parent is a root, not a cycle', () => {
  const tree = forkTree([
    { id: 'a', parentSession: 'missing' },
    { id: 'b', parentSession: 'b' },
    { id: 'c', parentSession: 'a' }
  ])
  assert.deepEqual(descendantsOf(tree, 'a'), ['c'])
  assert.deepEqual(descendantsOf(tree, 'b'), [])
  assert.deepEqual(ancestorsOf(tree, 'c'), ['a'])
  // A cycle must terminate rather than hang.
  const cyclic = forkTree([{ id: 'x', parentSession: 'y' }, { id: 'y', parentSession: 'x' }])
  assert.deepEqual(ancestorsOf(cyclic, 'x').sort(), ['y'])
  assert.deepEqual(descendantsOf(cyclic, 'x'), ['y'])
})

/* ---------------------------------------------------------------------------
 * Store-wide reads used to build the fork tree before a move.
 * ------------------------------------------------------------------------- */

test('indexStore maps every session id to its directory, skipping foreign dirs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  await mkdir(sessionDir(root, WORK, 'session-aaa'), { recursive: true })
  await mkdir(sessionDir(root, OTHER, 'session-bbb'), { recursive: true })
  // A directory the encoder would never produce must not look like a session.
  await mkdir(join(root, '--C-work-alpha--', 'not a session id'), { recursive: true })
  // A stray file next to the projects is ignored too.
  await writeFile(join(root, 'loose.txt'), 'x')

  const index = await indexStore(root)
  assert.deepEqual([...index.keys()].sort(), ['session-aaa', 'session-bbb'])
  assert.equal(index.get('session-aaa'), sessionDir(root, WORK, 'session-aaa'))
  assert.equal(index.get('session-bbb'), sessionDir(root, OTHER, 'session-bbb'))
})

test('readHeaderPrefix reads the header from a partial file', async (t) => {
  const root = await makeStore(WORK)
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = sessionDir(root, WORK, ID)

  const header = await readHeaderPrefix(dir, ID)
  assert.ok(header !== undefined, 'a bounded prefix must still yield the header')
  assert.equal(header.id, ID)
  assert.equal(header.cwd, WORK)
  // The whole log is far larger than the prefix, so this proves partial reads.
  const whole = await readSessionState(dir, ID)
  assert.ok(whole.buf.length > 0)
  assert.equal(await readHeaderPrefix(dir, 'session-other'), undefined)
})
