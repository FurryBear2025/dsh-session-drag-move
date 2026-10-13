/**
 * Publish the current plugin tree to GitHub via the Git Data API.
 *
 * One commit carries the whole change set: updated lib/*, README, package.json,
 * the new LICENSE, and the deletion of reference/ plus the tools/ scratch
 * dumps. Using the API (rather than a local git client) keeps the push to a
 * single request against github.com, which is the path that actually works on
 * this network.
 *
 * Usage: GH_TOKEN=... node tools/push-github.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'FurryBear2025'
const REPO = 'dsh-session-drag-move'
const BRANCH = 'main'
// fileURLToPath decodes the percent-escapes a non-ASCII path gets in a URL.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const TOKEN = process.env.GH_TOKEN ?? ''
if (TOKEN === '') {
  console.error('GH_TOKEN is required')
  process.exit(1)
}

/** Paths (repo-relative, posix) that must NOT be published. */
const EXCLUDE_DIRS = ['reference', 'node_modules', 'tools/reference']
const EXCLUDE_SCRATCH = /^tools\/.*\.(txt|err)$/i
const EXCLUDE_NAMES = new Set(['STATUS.md'])

function shouldSkip(rel) {
  const p = rel.split(/[\\/]/).join('/')
  if (EXCLUDE_NAMES.has(p)) return true
  if (EXCLUDE_SCRATCH.test(p)) return true
  for (const dir of EXCLUDE_DIRS) {
    if (p === dir || p.startsWith(`${dir}/`)) return true
  }
  return false
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue
    const full = join(dir, name)
    const rel = relative(ROOT, full)
    if (shouldSkip(rel)) continue
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push({ rel: rel.split(/[\\/]/).join('/'), full, size: st.size })
  }
  return out
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'user-agent': 'dsh-publish',
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json).slice(0, 400)}`)
  }
  return json
}

const files = walk(ROOT)
console.log(`publishing ${files.length} files`)

// 1. current branch head
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const baseCommitSha = ref.object.sha
const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`)
const baseTreeSha = baseCommit.tree.sha
console.log(`base commit ${baseCommitSha.slice(0, 8)}`)

// 2. blobs
const blobs = []
for (const file of files) {
  const content = readFileSync(file.full)
  const isBinary = content.includes(0)
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: isBinary ? content.toString('base64') : content.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf-8'
  })
  blobs.push({ path: file.rel, sha: blob.sha })
  process.stdout.write('.')
}
console.log(`\n${blobs.length} blobs uploaded`)

// 3. new tree built on the base tree. Files absent from `blobs` are dropped,
//    which is how reference/ and the scratch dumps get deleted.
const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
  base_tree: baseTreeSha,
  tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha, content: undefined }))
})

// Explicit deletions: entries present in the base tree but not in ours.
const baseTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`)
const keep = new Set(blobs.map((b) => b.path))
const deletions = []
for (const entry of baseTree.tree ?? []) {
  if (entry.type !== 'blob') continue
  if (!keep.has(entry.path)) deletions.push(entry.path)
}
console.log(`deleting ${deletions.length} stale paths`)

let finalTree = tree
if (deletions.length > 0) {
  finalTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: tree.sha,
    tree: deletions.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }))
  })
}

// 4. commit + move the branch
const message = [
  'fix: recognise the sidebar by data-row-key and report move progress',
  '',
  '- client: identify rows via data-row-key (session:/workspace:) instead of',
  '  CSS-Module class names, which are hashed in the shipped build',
  '- client: resolve the target workspace by geometry, with shape fallbacks',
  '- client: draw the drop highlight from coordinates, not event.target',
  '- client: show a progress card while a move runs',
  '- host: run moves as background jobs with a jobId and a progress endpoint',
  '- session-log: report per-phase and per-file progress during relocation',
  '- docs: describe the DOM contract, the progress API and sidebars',
  '- add LICENSE'
].join('\n')

const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: finalTree.sha,
  parents: [baseCommitSha]
})
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
console.log(`pushed ${commit.sha}`)
console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)
