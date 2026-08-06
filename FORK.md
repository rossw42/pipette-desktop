# Pipette (rossw42 fork)

A fork of [darakuneko/pipette-desktop](https://github.com/darakuneko/pipette-desktop) — the
Vial-compatible keyboard configurator — with a few additions of my own.

Everything upstream does, this does. See [README.md](./README.md) for the upstream feature set,
install instructions and license (GPL-3.0-or-later). **This file only covers what's different.**

| | |
|---|---|
| Upstream | `https://github.com/darakuneko/pipette-desktop` (remote name: `upstream`) |
| This fork | `https://github.com/rossw42/pipette-desktop` (remote name: `origin`) |
| Currently based on | upstream **v0.4.15** |
| Our changes live on | branch **`feat/key-notes-labels`** |
| `main` | pristine mirror of `upstream/main` — **never commit to it** |

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

**Implementation** (14 files, ~1.5k lines, mostly new)

| File | Role |
|---|---|
| `src/renderer/components/editors/key-notes-store.ts` | store, `useKeyNotes()` hook, `formatLegend`, `buildKeyNoteOverrides`, `mergeLabelOverrides` |
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

### 3. Fork maintenance tooling

`scripts/sync-upstream.mjs` and `scripts/verify-fork.mjs` — see below.

### Tests

53 tests cover the above and run in CI-less isolation:

- `src/renderer/components/editors/__tests__/KeymapEditor.keyNotes.test.tsx` (24) — renders the
  **real** `KeyboardWidget` and asserts on SVG `<text>` scoped by `data-key-pos`. All four test
  keys deliberately hold the *same* keycode (`KC_A`), so only genuinely position-keyed data can
  make them differ.
- `src/renderer/typing-test/__tests__/matrix-layer-latch-toggle.test.ts` (23) — every layer op on
  both protocols.
- `src/renderer/typing-test/__tests__/useTypingTest.toggleLayer.test.ts` (6) — end-to-end through
  the real hook.

Run just these: `node scripts/verify-fork.mjs --ours`

---

## Keeping this fork current with upstream

Two commands. The whole model is: **`main` mirrors upstream, our work is a feature branch that
gets rebased on top.** That keeps `git diff main..feat/key-notes-labels` small and readable, and
makes every future sync boring.

```bash
node scripts/sync-upstream.mjs    # fetch upstream → fast-forward main → rebase our branch → install
node scripts/verify-fork.mjs      # typecheck + tests, with upstream's own broken tests filtered out
```

> **Run these with `node`, not `pnpm fork:sync` / `pnpm fork:verify`.** pnpm performs its own
> dependency check before running *any* script, and on this machine that check tries to compile
> `better-sqlite3` and fails (no VS C++ build tools) — so the pnpm aliases die before the script
> starts. The `fork:sync` / `fork:verify` aliases in `package.json` are kept for when the install
> is healthy (or on a machine with build tools), and are identical otherwise.

### `sync-upstream.mjs`

| Flag | Effect |
|---|---|
| *(none)* | full sync + `pnpm install --force` |
| `--dry-run` | print every step, change nothing — **start here** |
| `--branch <name>` | rebase a different feature branch (default `feat/key-notes-labels`) |
| `--no-install` | skip the install step |
| `--allow-dirty` | don't insist on a clean working tree |

It refuses to continue rather than do something surprising: dirty tree, missing feature branch,
or a `main` that can't fast-forward (which would mean someone committed to `main`) all stop with
an explanation and the exact recovery command.

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
| `--ours` | only the fork's 3 test files — seconds instead of minutes |

Exits 0 only if there are **zero new failures**. Upstream ships some already-failing tests, so
the script carries an allowlist (`KNOWN_UPSTREAM_FAILURES`) and reports failures as either
*known upstream* or *NEW — ours to fix*. Without that, every sync turns into "wait, are these
17 failures mine?" archaeology.

**Known-broken upstream tests as of v0.4.15** — 17 failures across 4 files, none ours:

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
git diff v0.4.15..HEAD --stat -- src/main      # empty ⇒ every src/main file is byte-identical to upstream
git diff v0.4.15..HEAD --name-only             # the full list of what we changed
```

Our changes are **renderer-only**. So any failure in `src/main/**` cannot be caused by this fork
— that's how `sync-service.test.ts` was ruled out in seconds without a single test run. Reach for
this first; only fall back to an A/B test run when the failing file *is* one we touch.

If you do need the A/B run, use a **worktree** rather than `git stash` + `git checkout`:

```bash
git worktree add -f --detach ../pipette-v0415 v0.4.15
# ...run tests in ../pipette-v0415 (needs its own `pnpm install`)...
git worktree remove ../pipette-v0415
```

`git stash -u` will try to sweep up untracked files, and if any are locked by another process it
stops on an **interactive** *"Unlink of file X failed. Should I try again? (y/n)"* prompt —
leaving your work half-stashed. A worktree can't touch your working tree at all.

If a future sync fixes one of these, `verify-fork.mjs` notices and tells you to delete the entry
(except entries flagged `flaky`, which are expected to pass intermittently).

### Pushing after a sync

The rebase rewrites history, so the feature branch needs a force-push:

```bash
git push --force-with-lease origin feat/key-notes-labels
git push origin main
```

`--force-with-lease` (not `--force`) so you can't clobber anything you haven't seen.

### Doing it by hand

The script is just these steps, with guardrails:

```bash
git fetch upstream --tags --prune
git checkout main && git merge --ff-only upstream/main
git checkout feat/key-notes-labels && git rebase main
pnpm install --force
```

---

## Build & dev

Standard upstream scripts (`pnpm dev`, `pnpm build`, `pnpm dist:win`, `pnpm test`, `pnpm lint`)
all work unchanged. Fork-specific additions:

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
- **`better-sqlite3` fails to compile** (`gyp ERR! find VS`) — no Visual Studio C++ build tools
  installed. Unit tests and typecheck are unaffected, but the Electron app won't launch. Fix:
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools   # + "Desktop development with C++"
  pnpm rebuild better-sqlite3
  ```
- **Don't use `pnpm exec` / `npx` for verification.** pnpm auto-runs `pnpm install` before any
  `exec`, so the better-sqlite3 failure above aborts things that don't need it at all.
  `verify-fork.mjs` invokes `node node_modules/<pkg>/<entry>` directly to sidestep this.
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
git log --oneline main..feat/key-notes-labels
git cherry-pick <sha>   # onto a branch off main
```
