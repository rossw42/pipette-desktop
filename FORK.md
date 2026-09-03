# Pipette (rossw42 fork)

A fork of [darakuneko/pipette-desktop](https://github.com/darakuneko/pipette-desktop) — the
Vial-compatible keyboard configurator — with a few additions of my own.

Everything upstream does, this does. See [README.md](./README.md) for the upstream feature set,
install instructions and license (GPL-3.0-or-later). **This file only covers what's different.**

| | |
|---|---|
| Upstream | `https://github.com/darakuneko/pipette-desktop` (remote name: `upstream`) |
| This fork | `https://github.com/rossw42/pipette-desktop` (remote name: `origin`) |
| Currently based on | upstream **v0.4.20** |
| Our changes live on | **`main`** — the fork's own line of development, our commits sitting on top of upstream's |
| Comparing against upstream | `git diff upstream/main..main` |

---

## What this fork adds

### 1. Key Notes — user-editable semantic key labels

Vial/QMK keycodes tell you *which key* is pressed, not *what it does*. On a gaming layer,
`KC_B` might be "Bulldoze", `KC_G` might be "Guard Tower". Key Notes lets you write those
meanings down and see them **drawn on the keys** — in the editor, in Typing View, and in the
floating always-on-top overlay while you play.

**How to use it**

1. Open a keyboard in the Keymap editor.
2. Click the **tag icon** (🏷) in the toolbar to open the *Key Notes* panel. It replaces the
   keycode picker while it's open.
3. Click a key on the board, type a label, and it appears on the key immediately.
4. Click the **eye icon** (👁) to show/hide all labels without deleting them.
5. Switch to Typing View / the floating overlay — labels follow you, including the overlay's
   view-only menu which has its own *Labels* toggle (the overlay has no toolbar).

**How it behaves**

- Labels are stored **per keyboard, per layer, per matrix position** (`row,col`). Two keys with
  the same keycode on the same layer can have different labels — which is the whole point, and
  something upstream's keycode-global "Key Labels" packs can't express.
- Labels are **purely cosmetic**. Key Notes never writes a keycode, never touches your keymap,
  and never talks to the device. Worst case you lose some text.
- Long labels wrap onto two lines at the most balanced space (`formatLegend`).
- Stored in `localStorage` under `pipette:key-notes:<uid>`, with visibility under
  `pipette:key-notes-visible:<uid>`. Nothing leaves your machine.
- Where a label would collide with a View Matrix `row,col` legend, **View Matrix wins** — those
  legends are diagnostic and need to stay truthful (`mergeLabelOverrides`).

**Save / Load** — `localStorage` is per-machine and per-Electron-profile, so labels wouldn't
survive a reinstall or reach a second computer, and they appear in none of Pipette's existing
exports (a `.vil` carries keycodes, not annotations). The panel therefore has **Save** and
**Load** buttons:

- **Save** writes every label for the keyboard to a pretty-printed `.json` (small, hand-editable,
  diffs well in a dotfiles repo). Disabled when there's nothing to save.
- **Load** *merges* by default — labels the file doesn't mention are kept. **Shift-click** to
  *replace* instead, for "restore this backup exactly".
- The result appears inline under the buttons (`key-notes-io-result`). Cancelling the file dialog
  says nothing, because cancelling isn't an error.
- The file is a **sidecar**, deliberately not folded into `.vil`: that format is read by Vial
  itself and other tools, and smuggling non-standard keys into it risks confusing them.
- Import is strict about the envelope (`kind: "pipette-key-notes"`, `version`) so picking the
  wrong file is rejected rather than wiping your labels, but lenient inside `notes` — malformed
  entries are skipped and *counted*, and the count is reported, so one bad key can't cost you
  the rest of the file.
- Uses the pre-existing `exportJson` / `sideloadJson` IPC, so this added **no new IPC channel and
  no main-process code**.

The file looks like this:

```json
{
  "kind": "pipette-key-notes",
  "version": 1,
  "keyboard": "<uid>",
  "exportedAt": "2026-08-06T15:51:00.000Z",
  "notes": {
    "0": { "2,1": { "legend": "Bulldoze" } },
    "1": { "2,1": { "legend": "Zoom In", "desc": "optional long form" } }
  }
}
```

`keyboard` is informational — import does **not** require it to match, so labels can be moved
onto a rebuilt or renamed board (a common reason to have a backup at all).

**Implementation** (10 files, ~1.9k lines added, mostly new — tests are two of them)

| File | Role |
|---|---|
| `src/renderer/components/editors/key-notes-store.ts` | store, `useKeyNotes()` hook, `formatLegend`, `buildKeyNoteOverrides`, `mergeLabelOverrides`, plus the file layer (`serializeKeyNotes`, `parseKeyNotesFile`, `mergeKeyNotes`) |
| `src/renderer/components/editors/KeyNotesPanel.tsx` | the editing panel |
| `src/renderer/components/editors/KeymapEditor.tsx` | wires the hook into editor + typing view |
| `src/renderer/components/editors/keymap-editor-toolbar.tsx` | tag + eye toolbar buttons |
| `src/renderer/components/editors/KeymapTypingTestPane.tsx`, `TypingTestPane.tsx`, `typing-test-pane-types.ts` | prop threading down to `KeyboardPane` |
| `src/renderer/components/editors/TypingTestPaneViewOnlyMenu.tsx` | overlay's own Labels toggle |

It rides on the pre-existing `labelOverrides?: Map<string, {outer, inner, masked}>` renderer
contract (`KeyboardPane` → `KeyboardWidget` → `KeyWidget`), so no rendering code was rewritten.

### 2. Bug fix — Typing View now follows `TG()`/`TO()`/`TT()`/`DF()` layer switches

Upstream's typing view only tracked *momentary* layer keys (`MO`, `LT`, `LM`). Pressing a
**toggle** like `TG(2)` changed the layer on the keyboard but the on-screen layer indicator kept
showing layer 0, so the displayed keymap silently disagreed with reality.

Now handled: `MO`/`LT`/`LM` (momentary), `TG` (toggle), `TO` (switch-to), `TT` (tap-toggle),
`DF`/`PDF` (default layer) — across **both** VIA protocol v5 and v6 encodings.

| File | Change |
|---|---|
| `src/renderer/typing-test/matrix-layers.ts` | new `classifyLayerAction()` + `LayerActionKind`; per-protocol sticky-op tables |
| `src/renderer/typing-test/matrix-layer-latch.ts` | tracks a `toggled` set alongside momentary latches; `toggleLayer()`, `moveToLayer()`, `hasToggles()` |
| `src/renderer/typing-test/use-typing-test-matrix.ts` | dispatches on the classified action instead of assuming momentary |

Worth knowing if you touch this: the encodings are decoded with **numeric bit math**, not
`serialize()`. `serialize()` returns raw hex (e.g. `"0x5302"`) for codes it doesn't recognise,
which silently breaks parsing. Also `TO(n)` sets the `ON_PRESS` bit on **both** protocols
(v6 `TO(3)` = `0x5213`), so it must be matched before the other v6 ops or you get "layer 19".

### 3. Windows build & launch fixes

Upstream's Windows scripts didn't work on this machine, and one of them failed *silently*. All
three fixes are in `package.json` / `pnpm-workspace.yaml` / `scripts/`, none touch app code:

| File | Fix |
|---|---|
| `scripts/clean-build-dirs.mjs` | replaces the `if exist out (rd /s /q "out") && ...` cmd.exe chain in `build:win` / `dist:win`. cmd bound the whole `&&` chain to the first `if`, so when `out\` was absent **the build and packaging steps were skipped and the script still exited 0** — a 3-second "successful" build that produced no `dist\`. The Node version deletes the directories and refuses to touch anything outside the repo. |
| `scripts/postinstall.mjs` | upstream's `postinstall` was a bare `electron-rebuild`, whose (expected) failure without VS C++ build tools aborted the install. Now the rebuild failure is a *warning*, and only a missing `node_modules/electron/dist/electron.exe` is fatal — which it also repairs by re-running electron's `install.js`. |
| `pnpm-workspace.yaml` | `better-sqlite3: false` in `allowBuilds` (its `node-gyp` build killed the whole install before the `.bin` shims were written) and `verifyDepsBeforeRun: false` (pnpm 11's pre-run re-link was deleting `node_modules/electron/dist/`). |

Net effect: `pnpm install` → `pnpm dev` and `pnpm dist:win` both work with **no Visual Studio C++
build tools installed** — every native dep ships a Windows x64 prebuild. Full story in
[Gotchas](#gotchas-on-this-machine-windows).

### 4. Fork maintenance tooling

`scripts/sync-upstream.mjs` and `scripts/verify-fork.mjs` — see below.

### Tests

97 tests across 4 files cover the above and run in CI-less isolation:

- `src/renderer/components/editors/__tests__/KeymapEditor.keyNotes.test.tsx` (31) — renders the
  **real** `KeyboardWidget` and asserts on SVG `<text>` scoped by `data-key-pos`. All four test
  keys deliberately hold the *same* keycode (`KC_A`), so only genuinely position-keyed data can
  make them differ.
- `src/renderer/components/editors/__tests__/key-notes-file.test.ts` (37) — the save/load sidecar
  layer: serialize round-trips, envelope rejection, merge vs replace, and malformed-entry counting.
- `src/renderer/typing-test/__tests__/matrix-layer-latch-toggle.test.ts` (23) — every layer op on
  both protocols.
- `src/renderer/typing-test/__tests__/useTypingTest.toggleLayer.test.ts` (6) — end-to-end through
  the real hook.

Run just these: `node scripts/verify-fork.mjs --ours` (~7 s; last run 97/97, 0 type errors).

---

## Keeping this fork current with upstream

Two commands. The model is: **`main` is the fork's own line of development**, carrying our
commits on top of upstream's. Syncing **rebases `main` onto `upstream/main`**, so our work always
ends up as a small set of commits at the tip, and `git diff upstream/main..main` stays easy to
review.

Rebase rather than merge, on purpose: a merge would bury our commits among upstream's and make
"what does this fork actually change?" progressively harder to answer.

```bash
node scripts/sync-upstream.mjs    # fetch upstream → rebase main onto upstream/main → install
node scripts/verify-fork.mjs      # typecheck + tests, with upstream's own broken tests filtered out
```

> **Prefer `node` over `pnpm fork:sync` / `pnpm fork:verify`.** pnpm 11 runs its own dependency
> check before *any* script, and that re-link is both slow and (historically) destructive here —
> see [Gotchas](#gotchas-on-this-machine-windows). `verifyDepsBeforeRun: false` in
> `pnpm-workspace.yaml` disables it, so the aliases work now, but invoking `node` directly can't
> regress.

### `sync-upstream.mjs`

| Flag | Effect |
|---|---|
| *(none)* | full sync + `pnpm install --force` |
| `--dry-run` | print every step, change nothing — **start here** |
| `--branch <name>` | sync a different branch (default `main`) |
| `--no-install` | skip the install step |
| `--allow-dirty` | don't insist on a clean working tree |

It refuses to continue rather than do something surprising: a dirty working tree or a missing
branch both stop with an explanation, since a rebase needs a clean tree. It also prints how many
commits of fork work it is about to replay, so a surprising number is visible before anything
moves.

**If the rebase hits conflicts** it stops and tells you the two ways out:

```bash
git add <files> && git rebase --continue   # resolve and keep going
git rebase --abort                         # bail out, nothing lost
```

### `verify-fork.mjs`

| Flag | Effect |
|---|---|
| *(none)* | typecheck (both tsconfigs) + full test suite |
| `--tests-only` | skip typecheck |
| `--ours` | only the fork's 4 test files — seconds instead of minutes |

Exits 0 only if there are **zero new failures**. Upstream ships some already-failing tests, so
the script carries an allowlist (`KNOWN_UPSTREAM_FAILURES`) and reports failures as either
*known upstream* or *NEW — ours to fix*. Without that, every sync turns into "wait, are these
17 failures mine?" archaeology.

**Known-broken upstream tests as of v0.4.15** (re-confirmed on v0.4.20 — same 17 failures, still none ours):

| File | Failures | Symptom |
|---|---|---|
| `src/main/__tests__/hub-ipc-favorite.test.ts` | 13–14 | handlers return `{success:false}`; Hub upload/update mocks are stale |
| `src/renderer/components/analyze/__tests__/analyze-streak-goal.test.ts` | 2 | per-date streak goal resolution disagrees with the fixtures |
| `src/renderer/typing-test/__tests__/romaji-engine-mozc.test.ts` | 1 | suite-level: *no kana spelling starts with pending "b"* |
| `src/main/__tests__/sync-service.test.ts` | 0–1 | **order-dependent**: `runPackGcAfterPass` *called 1 times, but got 0* — passes in some full-suite orderings, fails in others |

The first three were confirmed by running those exact files on our branch **and** on a detached
`v0.4.15` checkout: **16 failed / 36 passed both times, identically.**

### The fastest way to tell whose failure it is

Before running anything, check whether our diff even *reaches* the failing code:

```bash
git diff upstream/main..main --stat -- src/main   # empty ⇒ every src/main file is byte-identical to upstream
git diff upstream/main..main --name-only          # the full list of what we changed
```

Our application changes are **renderer-only** — everything else we touch is build tooling
(`package.json`, `pnpm-workspace.yaml`, `scripts/`), and `src/main/**` is byte-identical to
upstream. So any failure in `src/main/**` cannot be caused by this fork — that's how
`sync-service.test.ts` was ruled out in seconds without a single test run. Reach for this first;
only fall back to an A/B test run when the failing file *is* one we touch.

If you do need the A/B run, use a **worktree** rather than `git stash` + `git checkout`:

```bash
git worktree add -f --detach ../pipette-upstream upstream/main
# ...run tests in ../pipette-upstream (needs its own `pnpm install`)...
git worktree remove ../pipette-upstream
```

`git stash -u` will try to sweep up untracked files, and if any are locked by another process it
stops on an **interactive** *"Unlink of file X failed. Should I try again? (y/n)"* prompt —
leaving your work half-stashed. A worktree can't touch your working tree at all.

If a future sync fixes one of these, `verify-fork.mjs` notices and tells you to delete the entry
(except entries flagged `flaky`, which are expected to pass intermittently).

### Pushing after a sync

The rebase rewrites our commits (new SHAs on a new base), so `main` needs a force-push:

```bash
git push --force-with-lease origin main
```

`--force-with-lease` (not `--force`) so you can't clobber anything you haven't seen.

### Doing it by hand

The script is just these steps, with guardrails:

```bash
git fetch upstream --tags --prune
git checkout main
git rebase upstream/main
pnpm install --force
```

---

## Build & dev

### Running it as a normal app (an .exe you double-click)

Build it once:

```powershell
cd d:\GitHub\rossw42\pipette-desktop
pnpm dist:win
```

Then run:

```
d:\GitHub\rossw42\pipette-desktop\dist\win-unpacked\Pipette.exe
```

That is a **complete, self-contained app** (~570 MB folder, 225 MB exe) — no terminal, no Node,
no dev server. Make a Desktop shortcut to it and treat it like any installed program. Rebuild
(`pnpm dist:win`) whenever you change the source.

**About the NSIS installer:** `dist:win` also tries to produce `dist\Pipette-win-x64.exe`, and on
this machine that final step **crashes** — 7-Zip dies with exit `3221225786` (`0xC0000409`,
stack-buffer-overrun) while compressing the ~570 MB payload at `-mx=9`. It's a 7za/environment
failure, not an app failure: everything before it succeeded, and `win-unpacked\Pipette.exe` is
complete and code-signed by then. You only need the installer to *distribute* the app; to *use*
it, ignore the crash and run `win-unpacked\Pipette.exe`.

### Cutting a release

Releases are tagged `vX.Y.Z-fork.N` — upstream's version plus a fork counter — and built here on
Windows, then the mac build is added by CI (next section). This is what produced `v0.4.20-fork.1`:

```powershell
node scripts/verify-fork.mjs                     # must say PASS
pnpm dist:win                                    # -> dist\Pipette-win-x64.exe
git push --force-with-lease origin main          # if a sync rewrote main
git tag -a v0.4.20-fork.1 -m 'Pipette 0.4.20 (rossw42 fork)'
git push origin v0.4.20-fork.1
gh release create v0.4.20-fork.1 dist\Pipette-win-x64.exe --repo rossw42/pipette-desktop `
  --title 'Pipette 0.4.20 (rossw42 fork)' --notes-file release-notes.md --latest
```

Release notes: what the fork adds (one line), the upstream commits picked up since the previous
fork release (`git log --oneline <prev-upstream-tag>..<new-upstream-tag>`), and the verify result.

### macOS builds (GitHub Actions — can't be done from Windows)

electron-builder only produces `.dmg`s **on macOS** (it needs `hdiutil`/`codesign`), so the mac
build runs on a GitHub-hosted Mac runner via `.github/workflows/mac-release.yml` — a fork-only
workflow, kept separate from upstream's `release.yml` (which refuses our `vX.Y.Z-fork.N` tags
because the tag must equal `package.json`'s version). It attaches the `.dmg` to an existing
release:

```powershell
# after the Windows release exists (see "Cutting a release" above):
gh workflow run mac-release.yml --repo rossw42/pipette-desktop -f tag=v0.4.20-fork.1 -f arch=arm64
gh run watch --repo rossw42/pipette-desktop --exit-status
```

`arch` is `arm64` (default, Apple Silicon — `macos-latest`), `x64` (Intel — `macos-26-intel`) or
`both`. Pushing a `v*-fork.*` tag also triggers it (arm64 only). If the release doesn't exist yet
the workflow creates it as a **draft**.

**Signing.** The fork has no Apple Developer certificate, and an *unsigned* Electron app won't even
launch on Apple Silicon ("Pipette is damaged and can't be opened"). So without certificate secrets
the workflow **ad-hoc signs** (`-c.mac.identity=-`) and disables `hardenedRuntime` + `notarize`
(an ad-hoc signature can't be notarized, and hardened runtime + ad-hoc needs an extra entitlement
to load Electron's frameworks). Ad-hoc apps still trip Gatekeeper on first launch, so tell users:

- **Right-click → Open** the app once (then it opens normally), or
- `xattr -cr /Applications/Pipette.app` to strip the quarantine flag.

If `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
are ever added as repo secrets, the same workflow switches to upstream's real signing +
notarization path with no edits.

The `.dmg` is **not hardware-verified** — nobody on this project has a Mac. The workflow does
`codesign --verify --deep --strict` on the bundle and runs the fork's own tests on the runner, but
"launches and talks to a keyboard" needs a real machine. Node-hid's `HID-darwin-*` and
better-sqlite3's `darwin-*` prebuilds are in the tree, so native deps should be fine.


### Running from source (for development)

```powershell
pnpm dev
```

Starts electron-vite in watch mode and opens the window with hot reload for the renderer and
restart-on-change for main. Slower to start and holds a terminal, but you see edits instantly.
`pnpm build` alone just compiles into `out/` without packaging.

Fork-specific additions:

| Command | Purpose |
|---|---|
| `node scripts/sync-upstream.mjs` | sync with upstream (above) |
| `node scripts/verify-fork.mjs` | is the fork healthy on top of upstream? (above) |

Both are also aliased as `pnpm fork:sync` / `pnpm fork:verify`, but prefer the `node`
form — see the note above about pnpm's pre-run dependency check.

### Testing without hardware

You don't need a physical keyboard. Pipette's **Dummy keyboard** path loads a keyboard
definition from JSON. A minimal 3×3 / 3-layer macropad for exercising Key Notes lives at:

```
d:\Keyboard Workspace\keymap_labeler\examples\pipette-keynotes-demo-keyboard.json
```

### Gotchas on this machine (Windows)

- **`pnpm install` hangs after a pnpm major bump.** It's blocked on an interactive
  *"modules directory will be removed — Proceed? (y/N)"* prompt you can't see. Use
  `pnpm install --force`. `fork:sync` already does.

#### Why `pnpm dev` used to fail — three stacked causes (all fixed, don't undo them)

There are **no Visual Studio C++ build tools on this machine**, and for a while that was believed
to be fatal. It isn't: all three native deps (`better-sqlite3`, `node-hid`,
`@paymoapp/active-window`) ship **prebuilt Windows x64 binaries**, so nothing needs compiling.
What actually broke the launch:

1. **`better-sqlite3`'s install script aborted the entire install.** It was in `allowBuilds`, so
   pnpm ran its `node-gyp` build, which failed with `gyp ERR! find VS` — and that killed the
   whole install *before* pnpm wrote the `node_modules/.bin` shims and *before* `electron`
   unpacked its binary. Symptom: `'electron-vite' is not recognized` and no `electron.exe`
   anywhere. **Fix:** `better-sqlite3: false` in `allowBuilds` (`pnpm-workspace.yaml`) — skip the
   source build, use the prebuild in `prebuilds/win32-x64.node`.
2. **pnpm 11 re-installed before every `pnpm run`, and the re-link deleted
   `node_modules/electron/dist/`.** Verified directly: binary present → `pnpm dev` → binary gone.
   **Fix:** `verifyDepsBeforeRun: false`. Note this must go in **`pnpm-workspace.yaml`**, not
   `.npmrc` — pnpm 11 silently ignores it there (`pnpm config get verifyDepsBeforeRun` returns
   `undefined` if you get this wrong).
3. **The `postinstall` hook was a bare `electron-rebuild`**, so its (harmless, expected) failure
   was fatal. **Fix:** `scripts/postinstall.mjs` — attempts the rebuild, treats failure as a
   *warning* since prebuilds cover it, then verifies `node_modules/electron/dist/electron.exe`
   exists and re-runs electron's `install.js` if not. Only a missing Electron binary is fatal now.

**If `electron.exe` ever goes missing again**, this restores it from the local cache
(`%LOCALAPPDATA%\electron\Cache`) without a reinstall:

```powershell
node node_modules/electron/install.js
```

#### Other

- **Don't use `pnpm exec` / `npx` for verification.** `verify-fork.mjs` invokes
  `node node_modules/<pkg>/<entry>` directly — one less moving part, and immune to whatever pnpm
  decides to do to `node_modules` on the way in.
- **`localStorage` in tests**: Node 25's experimental `localStorage` shadows jsdom's and exposes
  *no methods*, so `key-notes-store.ts` treats its in-memory `Map` as authoritative and
  feature-detects `getItem`/`setItem` before touching storage. Use `resetKeyNotesCache()` in
  tests, not `localStorage.clear()`.

---

## Contributing back upstream

The TG/TO/TT/DF fix (#2) is a self-contained bug fix and would probably be welcome upstream.
Key Notes (#1) is opinionated and stores things client-side, so it may be better as a fork-only
feature. Either way, keeping our commits small and rebased makes cherry-picking one out easy:

```bash
git log --oneline upstream/main..main       # just our commits
git checkout -b pr/typing-view-toggles upstream/main
git cherry-pick <sha>
```
