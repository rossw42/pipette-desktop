#!/usr/bin/env node
/**
 * verify-fork.mjs — one command that answers "did the upstream merge break us?"
 *
 * Runs typecheck + the unit test suite, then classifies every failing test as
 * either KNOWN (pre-existing upstream breakage, listed below) or NEW (our
 * problem). Exit code is 0 only when there are zero NEW failures.
 *
 *   node scripts/verify-fork.mjs                # typecheck + tests
 *   node scripts/verify-fork.mjs --tests-only   # skip typecheck
 *   node scripts/verify-fork.mjs --ours         # only the fork's own test files (fast)
 *
 * Invoke via `node`, not `pnpm fork:verify`. pnpm runs its own dependency check
 * before any script, and on this repo that check tries to compile better-sqlite3
 * and fails (no VS C++ build tools) — which has nothing to do with typechecking
 * or unit tests, but would abort them anyway. Same reason tsc/vitest are spawned
 * as `node node_modules/<pkg>/<entry>` below rather than through `pnpm exec`.
 *
 * Why an allowlist? Upstream sometimes ships with failing tests. Without this,
 * every sync ends in "are these 17 failures mine?" archaeology. The cheapest way
 * to check a suspect failure is whether our diff even reaches it:
 *   git diff <upstream-tag>..HEAD --stat -- src/main   # empty ⇒ can't be ours
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

/**
 * Test files that fail on a pristine upstream checkout — NOT our fault.
 *
 * Verified by running these exact files on our branch and on a detached
 * `v0.4.15` checkout: 16 failed / 36 passed, identically, both times.
 * Keep `verified` current — if a sync makes one pass, delete the entry
 * (the script will tell you).
 */
const KNOWN_UPSTREAM_FAILURES = [
  {
    file: 'src/main/__tests__/hub-ipc-favorite.test.ts',
    verified: 'v0.4.15',
    note: '13 failures — handlers return {success:false}; Hub upload/update mocks are stale',
  },
  {
    file: 'src/renderer/components/analyze/__tests__/analyze-streak-goal.test.ts',
    verified: 'v0.4.15',
    note: '2 failures — per-date streak goal resolution disagrees with the fixtures',
  },
  {
    file: 'src/renderer/typing-test/__tests__/romaji-engine-mozc.test.ts',
    verified: 'v0.4.15',
    note: '1 failure — suite-level: no kana spelling starts with pending "b"',
  },
  {
    file: 'src/main/__tests__/sync-service.test.ts',
    verified: 'v0.4.15',
    // `flaky` = passes in some run orderings, fails in others. Suppresses the
    // "now PASSES, delete me" nag, which would otherwise fire ~half the time.
    flaky: true,
    note: 'order-dependent — "runPackGcAfterPass called 1 times, but got 0"; a main-process file we never touch',
  },
]

/** Test files that exist only in this fork — the things a sync could break. */
const FORK_TEST_FILES = [
  'src/renderer/components/editors/__tests__/KeymapEditor.keyNotes.test.tsx',
  'src/renderer/typing-test/__tests__/matrix-layer-latch-toggle.test.ts',
  'src/renderer/typing-test/__tests__/useTypingTest.toggleLayer.test.ts',
]

const argv = process.argv.slice(2)
const testsOnly = argv.includes('--tests-only')
const oursOnly = argv.includes('--ours')

const c = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
}
const step = (m) => console.log(`\n${c.cyan}${c.bold}==>${c.reset} ${c.bold}${m}${c.reset}`)
const ok = (m) => console.log(`${c.green}  \u2713 ${m}${c.reset}`)
const bad = (m) => console.log(`${c.red}  \u2717 ${m}${c.reset}`)
const warn = (m) => console.log(`${c.yellow}  ! ${m}${c.reset}`)

const repoRoot = resolve(import.meta.dirname, '..')

/**
 * Run a locally-installed CLI by handing its JS entry point straight to `node`.
 *
 * Deliberately NOT `pnpm exec` / `npx`: pnpm auto-runs `pnpm install` before any
 * exec, and on this repo that install dies trying to compile better-sqlite3
 * (needs VS C++ build tools). That's irrelevant to typechecking/unit tests, but
 * it would abort the whole verification. Going through node sidesteps it.
 */
function runLocalBin(pkg, entry, args) {
  const bin = join(repoRoot, 'node_modules', pkg, entry)
  if (!existsSync(bin)) {
    return { status: 127, missing: bin }
  }
  return spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', shell: false, cwd: repoRoot })
}

let typecheckFailed = false
const newFailures = []
const knownFailures = []

// --- 1. typecheck ---------------------------------------------------------
if (testsOnly) {
  console.log(`${c.dim}(skipping typecheck: --tests-only)${c.reset}`)
} else {
  step('Typecheck (tsc, main + renderer)')
  // Same two projects as `pnpm typecheck`, but run directly so a broken
  // native-module install can't block us.
  let anyFailed = false
  for (const project of ['tsconfig.main.json', 'tsconfig.renderer.json']) {
    console.log(`    ${c.dim}tsc -p ${project}${c.reset}`)
    const res = runLocalBin('typescript', 'bin/tsc', ['-p', project])
    if (res.missing) {
      bad(`typescript not installed at ${res.missing} — run \`pnpm install\` first`)
      anyFailed = true
      break
    }
    if (res.status !== 0) anyFailed = true
  }
  if (anyFailed) {
    bad('typecheck failed (see output above)')
    typecheckFailed = true
  } else {
    ok('0 type errors')
  }
}

// --- 2. tests -------------------------------------------------------------
step(oursOnly ? "Unit tests (fork's own files only)" : 'Unit tests (full suite)')

const tmp = mkdtempSync(join(tmpdir(), 'pipette-verify-'))
const jsonPath = join(tmp, 'vitest.json')

const vitestArgs = ['run', '--reporter=default', '--reporter=json', `--outputFile=${jsonPath}`]
if (oursOnly) vitestArgs.push(...FORK_TEST_FILES)

const testRun = runLocalBin('vitest', 'vitest.mjs', vitestArgs)
if (testRun.missing) {
  bad(`vitest not installed at ${testRun.missing} — run \`pnpm install\` first`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf8'))
} catch {
  console.error(`\n${c.red}Could not read the vitest JSON report at ${jsonPath}.${c.reset}`)
  console.error('The suite probably crashed before writing it — scroll up for the real error.')
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

rmSync(tmp, { recursive: true, force: true })

const isKnown = (name) => KNOWN_UPSTREAM_FAILURES.find((k) => name.replace(/\\/g, '/').includes(k.file))

for (const suite of report.testResults ?? []) {
  const known = isKnown(suite.name)
  const failed = (suite.assertionResults ?? []).filter((a) => a.status === 'failed')

  // A suite that blew up during collection reports status 'failed' with zero
  // assertions (e.g. a module-level throw). Count it as one failure, otherwise
  // it vanishes from the tally and looks like it passed.
  if (failed.length === 0) {
    if (suite.status === 'failed') {
      const entry = { file: suite.name, title: suite.message || '(suite failed to run)' }
      if (known) knownFailures.push({ ...entry, known })
      else newFailures.push(entry)
    }
    continue
  }

  for (const a of failed) {
    const entry = { file: suite.name, title: a.fullName || a.title }
    if (known) knownFailures.push({ ...entry, known })
    else newFailures.push(entry)
  }
}

const total = report.numTotalTests ?? 0
const passed = report.numPassedTests ?? 0
console.log()
console.log(`  ${passed}/${total} tests passed`)

if (knownFailures.length > 0) {
  warn(`${knownFailures.length} known upstream failure(s) — ignored:`)
  for (const k of KNOWN_UPSTREAM_FAILURES) {
    const n = knownFailures.filter((f) => f.known.file === k.file).length
    if (n > 0) console.log(`      ${c.dim}${k.file} (${n}) — ${k.note}, last verified ${k.verified}${c.reset}`)
  }
}

// An allowlisted file that no longer fails is worth knowing about — otherwise
// the list rots and starts hiding real regressions. Entries marked `flaky` are
// expected to pass sometimes, so nagging about those would be noise.
for (const k of KNOWN_UPSTREAM_FAILURES) {
  if (k.flaky) continue
  const stillFails = knownFailures.some((f) => f.known.file === k.file)
  const wasRun = (report.testResults ?? []).some((s) => s.name.replace(/\\/g, '/').includes(k.file))
  if (wasRun && !stillFails) {
    warn(`${k.file} now PASSES — remove its entry from KNOWN_UPSTREAM_FAILURES in scripts/verify-fork.mjs`)
  }
}

if (newFailures.length > 0) {
  bad(`${newFailures.length} NEW failure(s) — these are ours to fix:`)
  for (const f of newFailures) console.log(`      ${c.red}${f.file}${c.reset}\n        ${f.title}`)
} else if (testRun.status !== 0 && knownFailures.length === 0) {
  // Non-zero exit with no parsed failures usually means a suite-level crash.
  bad('vitest exited non-zero but reported no individual failures (suite-level error?)')
  newFailures.push({ file: '(suite-level)', title: 'vitest exited non-zero' })
} else {
  ok('no new failures')
}

// --- 3. verdict -----------------------------------------------------------
step('Verdict')
const problems = []
if (typecheckFailed) problems.push('typecheck errors')
if (newFailures.length > 0) problems.push(`${newFailures.length} new test failure(s)`)

if (problems.length === 0) {
  console.log(`${c.green}${c.bold}  PASS${c.reset} — fork is healthy on top of upstream.`)
  process.exit(0)
} else {
  console.log(`${c.red}${c.bold}  FAIL${c.reset} — ${problems.join(' and ')}.`)
  process.exit(1)
}
