/**
 * Publish this plugin to npm without the npm CLI.
 *
 * The runtime here ships node/pnpm but no npm, so `npm publish` is not
 * available. The registry protocol itself is simple: PUT a gzipped tarball
 * plus the packument document to /<package>. This script builds that tarball
 * from the `files` whitelist in package.json, so a stray local file can never
 * leak into the published package.
 *
 * Usage: NPM_TOKEN=... node tools/publish-npm.mjs [--dry]
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TOKEN = process.env.NPM_TOKEN ?? ''
const DRY = process.argv.includes('--dry')

if (TOKEN === '' && !DRY) {
  console.error('NPM_TOKEN is required')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.name
const VERSION = pkg.version

if (pkg.dsh === undefined || pkg.dsh.bundle === undefined) {
  console.error('package.json must declare dsh.bundle to be installable')
  process.exit(1)
}
if (pkg.repository === undefined || typeof pkg.repository.url !== 'string') {
  console.error('package.json must declare repository.url (the marketplace links the two)')
  process.exit(1)
}

/* ------------------------- build the tarball --------------------------- */

/** Minimal USTAR writer: npm accepts a plain tar.gz. */
function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  const writeStr = (value, offset, length) => {
    const buf = Buffer.from(value, 'utf8')
    buf.copy(header, offset, 0, Math.min(buf.length, length))
  }
  const writeOct = (value, offset, length) => {
    const str = value.toString(8).padStart(length - 1, '0')
    header.write(str, offset, length - 1, 'ascii')
  }
  const nameWithPrefix = `package/${name}`
  writeStr(nameWithPrefix, 0, 100)
  writeOct(0o644, 100, 8)            // mode
  writeOct(0, 108, 8)                // uid
  writeOct(0, 116, 8)                // gid
  writeOct(data.length, 124, 12)     // size
  writeOct(Math.floor(Date.now() / 1000), 136, 12)  // mtime
  header.write('        ', 148, 8, 'ascii')  // checksum placeholder
  header.write('0', 156, 1, 'ascii')  // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, padding])
}

function collectFiles() {
  const out = []
  for (const pattern of pkg.files ?? []) {
    if (pattern.includes('*')) {
      console.warn(`skipping glob pattern in files: ${pattern}`)
      continue
    }
    const full = join(ROOT, pattern)
    if (!existsSync(full)) {
      console.warn(`missing file listed in package.json#files: ${pattern}`)
      continue
    }
    const st = statSync(full)
    if (!st.isFile()) continue
    out.push({ name: pattern.split(/[\\/]/).join('/'), data: readFileSync(full) })
  }
  // npm always includes these when present.
  for (const extra of ['package.json', 'README.md', 'LICENSE']) {
    if (out.some((f) => f.name === extra)) continue
    const full = join(ROOT, extra)
    if (existsSync(full) && statSync(full).isFile()) {
      out.push({ name: extra, data: readFileSync(full) })
    }
  }
  return out
}

const files = collectFiles()
if (files.length === 0) {
  console.error('no files to publish')
  process.exit(1)
}
console.log(`packing ${files.length} files:`)
for (const f of files) console.log(`  ${f.name} (${f.data.length})`)

const tar = Buffer.concat([
  ...files.map((f) => tarEntry(f.name, f.data)),
  Buffer.alloc(1024)  // two zero blocks terminate the archive
])
const tarball = gzipSync(tar, { level: 9 })
const shasum = createHash('sha1').update(tarball).digest('hex')
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64')

console.log(`tarball: ${tarball.length} bytes, sha1 ${shasum}`)

if (DRY) {
  console.log('dry run: not publishing')
  process.exit(0)
}

/* --------------------------- registry PUT ------------------------------ */

const metadata = {
  _id: NAME,
  name: NAME,
  description: pkg.description,
  'dist-tags': { latest: VERSION },
  versions: {
    [VERSION]: {
      ...pkg,
      _id: `${NAME}@${VERSION}`,
      dist: {
        shasum,
        integrity,
        tarball: `https://registry.npmjs.org/${NAME}/-/${NAME}-${VERSION}.tgz`
      }
    }
  },
  readme: existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '',
  _attachments: {
    [`${NAME}-${VERSION}.tgz`]: {
      content_type: 'application/octet-stream',
      data: tarball.toString('base64'),
      length: tarball.length
    }
  }
}

const res = await fetch(`https://registry.npmjs.org/${NAME}`, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    'user-agent': 'dsh-publish'
  },
  body: JSON.stringify(metadata)
})

const text = await res.text()
console.log(`PUT ${NAME}@${VERSION} -> ${res.status}`)
if (!res.ok) {
  console.log(text.slice(0, 1200))
  process.exit(1)
}
console.log('published:', text.slice(0, 400))
