#!/usr/bin/env node
/**
 * postinstall — rebuild native modules, then make sure Electron's binary is
 * actually on disk.
 *
 * Replaces a bare `electron-rebuild ...` call, which had two failure modes that
 * together made `pnpm dev` unusable on a machine without Visual Studio:
 *
 *  1. `electron-rebuild` compiles from source and dies on `better-sqlite3`
 *     (`gyp ERR! find VS`). A non-zero postinstall FAILS the whole install —
 *     even though better-sqlite3, node-hid and active-window all ship working
 *     prebuilt `win32-x64` binaries that don't need rebuilding at all.
 *  2. Every install re-links `node_modules`, which deletes the unpacked
 *     `node_modules/electron/dist/`. Electron's own install script normally
 *     re-extracts it, but the abort in (1) meant it never finished — leaving no
 *     `electron.exe` and an app that simply cannot start. Worse, it happened on
 *     every `pnpm dev`, since pnpm re-runs the install before any script.
 *
 * So: attempt the rebuild, treat failure as a WARNING rather than fatal (the
 * prebuilds are there), and then verify/repair the Electron binary — which is
 * genuinely required, so that part is still fatal.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const c = { reset: '\u001b[0m', dim: '\u001b[2m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m' }
const ok = (m) => console.log(`${c.green}postinstall: ${m}${c.reset}`)
const warn = (m) => console.log(`${c.yellow}postinstall: ${m}${c.reset}`)
const fail = (m) => console.error(`${c.red}postinstall: ${m}${c.reset}`)

const NATIVE = 'better-sqlite3,node-hid,@paymoapp/active-window'

// --- 1. native modules (best effort) ---------------------------------------
// `--force` is upstream's flag; kept so behaviour matches when a compiler IS
// available and a genuine rebuild is wanted.
const rebuildBin = join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js')
if (existsSync(rebuildBin)) {
  const res = spawnSync(process.execPath, [rebuildBin, '-f', '-w', NATIVE], {
    cwd: root, stdio: 'inherit', shell: false,
  })
  if (res.status === 0) {
    ok('native modules rebuilt')
  } else {
    warn('electron-rebuild failed — continuing on the shipped prebuilt binaries.')
    warn('  This is expected without Visual Studio C++ build tools. If a native')
    warn('  module later complains about an ABI mismatch, install them and rerun')
    warn('  `pnpm rebuild`:')
    warn('    winget install Microsoft.VisualStudio.2022.BuildTools')
  }
} else {
  warn(`@electron/rebuild not found at ${rebuildBin} — skipping native rebuild`)
}

// --- 2. Electron binary (required) ----------------------------------------
const electronDir = join(root, 'node_modules', 'electron')
const exe = process.platform === 'win32'
  ? join(electronDir, 'dist', 'electron.exe')
  : join(electronDir, 'dist', process.platform === 'darwin' ? 'Electron.app' : 'electron')

if (!existsSync(electronDir)) {
  warn('electron is not installed — skipping binary check')
  process.exit(0)
}

if (existsSync(exe) && existsSync(join(electronDir, 'path.txt'))) {
  ok('electron binary present')
  process.exit(0)
}

warn('electron binary missing (the install re-linked node_modules) — re-extracting…')
const installJs = join(electronDir, 'install.js')
if (!existsSync(installJs)) {
  fail(`cannot repair: ${installJs} not found`)
  process.exit(1)
}

// Extracts from the download cache when present, so this is normally a fast
// unzip rather than a ~110MB download.
const res = spawnSync(process.execPath, [installJs], { cwd: electronDir, stdio: 'inherit', shell: false })
if (res.status !== 0 || !existsSync(exe)) {
  fail('failed to extract the Electron binary. Try by hand:')
  fail('  node node_modules/electron/install.js')
  process.exit(1)
}
ok('electron binary restored')
