#!/usr/bin/env node
/**
 * sync-upstream.mjs — repeatable "bring in latest from upstream" for this fork.
 *
 * Model: `main` is the fork's own line of development — it carries our commits
 * on top of upstream's. Syncing REBASES it onto `upstream/main`, so our work
 * always ends up as a small, readable set of commits at the tip, and
 * `git diff upstream/main..main` stays easy to review and cherry-pick from.
 *
 * (Rebase, not merge: a merge would bury our commits among upstream's and make
 * "what does this fork actually change?" progressively harder to answer.)
 *
 *   node scripts/sync-upstream.mjs                 # full sync + install
 *   node scripts/sync-upstream.mjs --dry-run       # print every step, change nothing
 *   node scripts/sync-upstream.mjs --branch other  # sync a different branch (default `main`)
 *   node scripts/sync-upstream.mjs --no-install    # skip `pnpm install --force`
 *   node scripts/sync-upstream.mjs --allow-dirty   # don't insist on a clean working tree
 *
 * Invoke via `node`, not `pnpm fork:sync`. pnpm runs its own dependency check
 * before any script, and on this repo that check tries to compile better-sqlite3
 * and fails (no VS C++ build tools) — killing the sync before it starts. The
 * `pnpm fork:sync` alias exists for when the install is healthy.
 *
 * See FORK.md for the manual equivalent of every step below.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'

const UPSTREAM_REMOTE = 'upstream'
const UPSTREAM_URL = 'https://github.com/darakuneko/pipette-desktop.git'
/** The branch on upstream we track. */
const UPSTREAM_BRANCH = 'main'
/** Our branch — the fork's own line of development. */
const DEFAULT_OUR_BRANCH = 'main'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const dryRun = hasFlag('dry-run')
const skipInstall = hasFlag('no-install')
const allowDirty = hasFlag('allow-dirty')

const c = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
}
const step = (msg) => console.log(`\n${c.cyan}${c.bold}==>${c.reset} ${c.bold}${msg}${c.reset}`)
const info = (msg) => console.log(`    ${msg}`)
const warn = (msg) => console.log(`${c.yellow}  ! ${msg}${c.reset}`)
const ok = (msg) => console.log(`${c.green}  \u2713 ${msg}${c.reset}`)

function die(msg, hint) {
  console.error(`\n${c.red}${c.bold}FAILED:${c.reset} ${msg}`)
  if (hint) console.error(`${c.dim}${hint}${c.reset}`)
  process.exit(1)
}

/** Run a command, capture stdout. Throws on non-zero exit. */
function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Run a command with inherited stdio. Respects --dry-run. Returns exit code. */
function run(cmd, args, { mutating = true } = {}) {
  const printable = `${cmd} ${args.join(' ')}`
  if (mutating && dryRun) {
    info(`${c.dim}[dry-run] would run:${c.reset} ${printable}`)
    return 0
  }
  info(`${c.dim}$ ${printable}${c.reset}`)
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false })
  return res.status ?? 1
}

function runOrDie(cmd, args, hint) {
  const code = run(cmd, args)
  if (code !== 0) die(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`, hint)
}

// pnpm is a .cmd shim on Windows; spawnSync without a shell can't find it.
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

// ---------------------------------------------------------------------------

console.log(`${c.bold}Pipette fork \u2192 upstream sync${c.reset}${dryRun ? c.yellow + '  (dry run)' + c.reset : ''}`)

const ourBranch = flagValue('branch') ?? DEFAULT_OUR_BRANCH
const upstreamRef = `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`

// --- 0. sanity ------------------------------------------------------------
step('Checking repository state')
try {
  capture('git', ['rev-parse', '--git-dir'])
} catch {
  die('not inside a git repository')
}

info(`current branch: ${capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])}`)

const dirty = capture('git', ['status', '--porcelain', '--untracked-files=no'])
if (dirty) {
  if (allowDirty) {
    warn('working tree has uncommitted changes (continuing because --allow-dirty)')
  } else {
    die(
      'working tree has uncommitted changes:\n' + dirty,
      'Commit or stash them first (a rebase needs a clean tree), or pass --allow-dirty.'
    )
  }
} else {
  ok('working tree is clean')
}

try {
  capture('git', ['rev-parse', '--verify', `refs/heads/${ourBranch}`])
  ok(`branch \`${ourBranch}\` exists`)
} catch {
  die(`branch \`${ourBranch}\` does not exist`, 'Pass the right one with --branch <name>.')
}

// --- 1. upstream remote ---------------------------------------------------
step(`Ensuring \`${UPSTREAM_REMOTE}\` remote points at ${UPSTREAM_URL}`)
const remotes = capture('git', ['remote']).split(/\r?\n/).filter(Boolean)
if (!remotes.includes(UPSTREAM_REMOTE)) {
  warn(`remote \`${UPSTREAM_REMOTE}\` missing — adding it`)
  runOrDie('git', ['remote', 'add', UPSTREAM_REMOTE, UPSTREAM_URL])
} else {
  const url = capture('git', ['remote', 'get-url', UPSTREAM_REMOTE])
  if (url !== UPSTREAM_URL) warn(`remote URL is ${url} (expected ${UPSTREAM_URL}) — leaving as-is`)
  else ok('remote already configured')
}

// --- 2. fetch -------------------------------------------------------------
step('Fetching upstream')
runOrDie('git', ['fetch', UPSTREAM_REMOTE, '--tags', '--prune'])

const newUpstream = capture('git', ['rev-list', '--count', `${ourBranch}..${upstreamRef}`])
const ourCommits = capture('git', ['rev-list', '--count', `${upstreamRef}..${ourBranch}`])
const upstreamDescribe = (() => {
  try {
    return capture('git', ['describe', '--tags', '--abbrev=0', upstreamRef])
  } catch {
    return capture('git', ['rev-parse', '--short', upstreamRef])
  }
})()

info(`upstream is at ${upstreamDescribe}`)
info(`our branch carries ${ourCommits} commit(s) of fork work`)
if (newUpstream === '0') {
  ok('already up to date — no new upstream commits')
} else {
  ok(`${newUpstream} new upstream commit(s) to pick up`)
}

// --- 3. rebase our work onto the new upstream ----------------------------
step(`Rebasing \`${ourBranch}\` onto ${upstreamRef}`)
if (newUpstream === '0') {
  info('nothing to rebase onto — already current')
} else {
  runOrDie('git', ['checkout', ourBranch])
  const rebaseCode = run('git', ['rebase', upstreamRef])
  if (rebaseCode !== 0) {
    die(
      'rebase hit conflicts and stopped.',
      'Resolve them, then:\n' +
        '  git add <files> && git rebase --continue      # keep going\n' +
        '  git rebase --abort                            # bail out, nothing lost\n' +
        `Afterwards just finish the install: ${PNPM} install --force`
    )
  }
  ok('rebase clean')
}

// --- 4. dependencies ------------------------------------------------------
step('Installing dependencies')
if (skipInstall) {
  info('skipped (--no-install)')
} else {
  // --force matters: on a pnpm major bump, plain `install` blocks forever on an
  // interactive "modules directory will be removed — Proceed? (y/N)" prompt.
  runOrDie(PNPM, ['install', '--force'], 'Try running it by hand to see the full output.')
  ok('dependencies installed')
}

// --- 5. summary -----------------------------------------------------------
step('Summary')
if (!dryRun) {
  console.log(`${c.dim}What this fork changes vs ${upstreamRef}:${c.reset}`)
  console.log(capture('git', ['diff', '--stat', `${upstreamRef}..${ourBranch}`]) || '    (no differences)')
  console.log()
  console.log(capture('git', ['log', '--oneline', '-6', '--decorate']))
}

console.log(`
${c.green}${c.bold}Done.${c.reset} Next steps:

  1. ${c.bold}node scripts/verify-fork.mjs${c.reset}   typecheck + unit tests (FORK.md lists the known-failing upstream tests)
  2. ${c.bold}pnpm rebuild${c.reset}                   rebuild native modules if Electron's version changed
  3. ${c.bold}pnpm dev${c.reset}                       smoke-test the app
  4. ${c.bold}git push --force-with-lease origin ${ourBranch}${c.reset}
     (force-with-lease because the rebase rewrote our commits)
`)

if (dryRun) console.log(`${c.yellow}(dry run — nothing was changed)${c.reset}`)
