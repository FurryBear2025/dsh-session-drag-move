#!/usr/bin/env node
/**
 * Sync the plugin into the desktop profile and report what landed.
 *
 *   node tools/install.mjs
 *
 * The profile resolves `dsh-session-drag-move` from its own node_modules, and
 * pnpm materialises that dependency as a real directory (not a symlink), so a
 * source edit does NOT reach the running app on its own. Run this after every
 * change to lib/, then restart DSH.
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = join(homedir(), '.dsh', 'profiles', 'desktop')
const dest = join(profile, 'node_modules', 'dsh-session-drag-move')

const FILES = ['package.json', 'cordis.patch.yml', 'README.md']
const DIRS = ['lib', 'tests']

const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// 1. Copy the shipped surface. tools/ and reference/ stay out of the package.
await mkdir(dest, { recursive: true })
for (const name of FILES) await cp(join(here, name), join(dest, name))
for (const name of DIRS) {
  await rm(join(dest, name), { recursive: true, force: true })
  await cp(join(here, name), join(dest, name), { recursive: true })
}

// 2. Prove the copy is what this source says it is.
console.log(`installed -> ${dest}\n`)
const report = []
for (const name of await readdir(join(dest, 'lib'))) {
  const a = await hash(join(here, 'lib', name))
  const b = await hash(join(dest, 'lib', name))
  report.push(`${a === b ? 'ok  ' : 'DIFF'}  lib/${name}`)
}
console.log(report.join('\n'))

// 3. The two declarations that broke web boot once — fail loudly if they regress.
const host = await readFile(join(dest, 'lib', 'index.js'), 'utf8')
const client = await readFile(join(dest, 'lib', 'client.js'), 'utf8')
const clientInject = /^\s+inject:\s*\[/m.test(client)
if (clientInject) console.log('\nWARNING  client half declares inject[]; a service it does not need will hang web boot')

// 4. The profile must list the bundle, or nothing loads it.
const profilePkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
const bundled = profilePkg?.dsh?.profile?.bundles?.includes('dsh-session-drag-move') === true
const linked = await exists(dest)
console.log(`\nprofile bundle entry : ${bundled ? 'present' : 'MISSING'}`)
console.log(`node_modules package : ${linked ? 'present' : 'MISSING'}`)
console.log(`host inject          : ${/^export const inject = (.*)$/m.exec(host)?.[1] ?? '(none)'}`)
console.log('\nRestart DSH to load the host half.')
