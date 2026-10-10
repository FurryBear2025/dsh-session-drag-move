/**
 * Inspect one DSH JSONL session log.
 *
 *   node tools/inspect-session.mjs <path-to-session.vN.jsonl.zstd>
 *
 * Prints the decoded header (the log's first Zstandard frame) and the byte
 * offsets of every frame boundary, so a header rewrite can splice
 * "new header frame + original tail" without touching event data.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const file = process.argv[2]
const buf = readFileSync(file)
console.log(`file: ${file}`)
console.log(`size: ${buf.length} bytes`)

const boundaries = []
let at = 0
for (;;) {
  const hit = buf.indexOf(MAGIC, at)
  if (hit === -1) break
  boundaries.push(hit)
  at = hit + 4
}
console.log(`frame magic offsets: [${boundaries.slice(0, 12).join(', ')}${boundaries.length > 12 ? ', …' : ''}] (${boundaries.length} found)`)

const firstEnd = boundaries[1] ?? buf.length
const headerFrame = buf.subarray(0, firstEnd)
console.log(`header frame: 0..${firstEnd} (${headerFrame.length} bytes)`)

let text
try {
  text = zstdDecompressSync(headerFrame).toString('utf8')
} catch (error) {
  console.log(`header frame decompress failed (${error.message}); trying the whole file`)
  text = zstdDecompressSync(buf).toString('utf8')
}
const firstLine = text.split('\n')[0]
console.log('--- header line ---')
try {
  console.log(JSON.stringify(JSON.parse(firstLine), null, 2))
} catch {
  console.log(firstLine.slice(0, 4000))
}
console.log(`--- decoded header text length: ${text.length} ---`)
console.log(text.slice(0, 200).replace(/\n/g, '\\n'))
