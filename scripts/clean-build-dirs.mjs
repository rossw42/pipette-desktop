#!/usr/bin/env node
/**
 * Remove build output directories, cross-platform.
 *
 * Replaces the `rm -rf out dist` / `if exist out (rd /s /q "out")` prefixes that upstream's
 * build scripts use. Those were broken on Windows in two different ways:
 *
 *   - `rm -rf` isn't a command in cmd.exe at all.
 *   - `if exist out (rd /s /q "out") && if exist dist (...) && electron-vite build && ...`
 *     silently does *nothing* when `out` is absent: cmd.exe binds the whole `&&` chain to the
 *     first `if`, so a missing directory skips the build too — and still exits 0, so it looks
 *     like it worked. That's how `pnpm dist:win` came to "succeed" in 3 seconds while producing
 *     no `dist/` at all.
 *
 * Usage: node scripts/clean-build-dirs.mjs [dir...]   (defaults to `out dist`)
 */

import { rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const targets = process.argv.slice(2)
const dirs = targets.length > 0 ? targets : ['out', 'dist']

for (const dir of dirs) {
  const full = resolve(root, dir)

  // Refuse to delete anything outside the repo, in case of a typo like `../..`.
  if (full !== root && !full.startsWith(root + sep)) {
    console.error(`refusing to remove ${full} — outside the repo`)
    process.exit(1)
  }
  if (full === root) {
    console.error('refusing to remove the repo root')
    process.exit(1)
  }

  rmSync(full, { recursive: true, force: true })
}
