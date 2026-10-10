/**
 * Byte scanner for large archives (Electron .asar and friends).
 *
 *   node tools/scan.mjs dumphdr <archive>
 *   node tools/scan.mjs find    <archive> <needle> [before] [after] [maxHits]
 *
 * `find` locates every byte occurrence of `needle` and prints the surrounding
 * UTF-8 text — asar stores each file's bytes contiguously and uncompressed, so
 * a hit is enough to read the enclosing source without extracting the file.
 */
import { openSync, readSync, readFileSync, closeSync, statSync, writeFileSync } from 'node:fs'

const [, , cmd, archive, ...rest] = process.argv

if (cmd === 'dumphdr') {
  const fd = openSync(archive, 'r')
  const buf = Buffer.alloc(96)
  readSync(fd, buf, 0, 96, 0)
  closeSync(fd)
  console.log(buf.toString('hex').replace(/(.{32})/g, '$1\n'))
  console.log('--- ascii ---')
  console.log(JSON.stringify(buf.toString('utf8', 0, 96)))
} else if (cmd === 'find') {
  const needle = rest[0]
  const before = Number(rest[1] ?? 400)
  const after = Number(rest[2] ?? 1200)
  const maxHits = Number(rest[3] ?? 8)
  const hay = readFileSync(archive)
  const nb = Buffer.from(needle, 'utf8')
  let from = 0
  let hits = 0
  while (hits < maxHits) {
    const at = hay.indexOf(nb, from)
    if (at === -1) break
    hits += 1
    const start = Math.max(0, at - before)
    const end = Math.min(hay.length, at + nb.length + after)
    console.log(`\n===== hit ${hits} @ byte ${at} (0x${at.toString(16)}) =====`)
    console.log(hay.toString('utf8', start, end))
    from = at + nb.length
  }
  console.log(`\n[scan] total hits printed: ${hits}`)
} else if (cmd === 'extract') {
  const offset = Number(rest[0])
  const size = Number(rest[1])
  const out = rest[2]
  const fd = openSync(archive, 'r')
  const buf = Buffer.alloc(size)
  readSync(fd, buf, 0, size, offset)
  closeSync(fd)
  writeFileSync(out, buf)
  console.log(`wrote ${out} (${statSync(out).size} bytes)`)
} else {
  console.error('usage: dumphdr <archive> | find <archive> <needle> [before] [after] [maxHits] | extract <archive> <offset> <size> <out>')
  process.exit(1)
}
