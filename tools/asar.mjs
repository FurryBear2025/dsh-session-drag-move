/**
 * Minimal Electron ASAR reader — no dependencies.
 *
 *   node tools/asar.mjs list    <archive> [regex]     # list entry paths
 *   node tools/asar.mjs cat     <archive> <innerPath> # print one file to stdout
 *   node tools/asar.mjs extract <archive> <innerPath> <outFile>
 *
 * The ASAR layout: an 8-byte Pickle prefix (uint32 payload size = 4, uint32
 * header size), then the header Pickle — [uint32 payloadSize][uint32
 * jsonLength][json] — so the JSON starts 16 bytes in. File data begins at
 * 8 + headerSize and every entry's `offset` is relative to that base.
 */
import { openSync, readSync, writeFileSync, closeSync, statSync } from 'node:fs'

const [, , cmd, archive, a, b] = process.argv

function readHeader(file) {
  const fd = openSync(file, 'r')
  const prefix = Buffer.alloc(16)
  readSync(fd, prefix, 0, 16, 0)
  const headerSize = prefix.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  const header = JSON.parse(headerBuf.subarray(8).toString('utf8'))
  closeSync(fd)
  return { header, base: 8 + headerSize }
}

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, path, out)
    else out.push({ path, offset: value.offset, size: value.size, unpacked: value.unpacked })
  }
}

function readEntry(file, base, entry) {
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, base + Number(entry.offset))
  closeSync(fd)
  return buf
}

if (cmd === 'list' || cmd === 'ls') {
  const { header } = readHeader(archive)
  const all = []
  walk(header, '', all)
  const re = a ? new RegExp(a, 'i') : null
  for (const e of all) if (!re || re.test(e.path)) console.log(`${e.size}\t${e.path}`)
  console.error(`total entries: ${all.length}`)
} else if (cmd === 'cat') {
  const { header, base } = readHeader(archive)
  const all = []
  walk(header, '', all)
  const entry = all.find(e => e.path === a)
  if (!entry) { console.error('not found'); process.exit(2) }
  process.stdout.write(readEntry(archive, base, entry))
} else if (cmd === 'extract') {
  const { header, base } = readHeader(archive)
  const all = []
  walk(header, '', all)
  const entry = all.find(e => e.path === a)
  if (!entry) { console.error('not found'); process.exit(2) }
  writeFileSync(b, readEntry(archive, base, entry))
  console.error(`wrote ${b} (${statSync(b).size} bytes)`)
} else {
  console.error('usage: list|cat|extract <archive> [args]')
  process.exit(1)
}
