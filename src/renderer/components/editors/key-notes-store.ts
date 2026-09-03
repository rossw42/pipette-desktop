// SPDX-License-Identifier: GPL-2.0-or-later
//
// "Key Notes": user-authored semantic labels for keys ("Bulldoze" instead of
// "B"), keyed by keyboard + layer + matrix position. See
// `keymap_labeler/PIPETTE-INTEGRATION.md`.
//
// Storage is localStorage for now (renderer-only, zero IPC) so the whole
// feature is usable and persistent today; phase 1 of the design doc replaces
// this one module with the real `{userData}/sync/key-notes/` store + IPC,
// keeping the same hook surface so nothing above it changes.
//
// Notes are PURELY ADDITIVE annotation: nothing here ever writes a keycode or
// touches the keymap.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { posKey } from '../../../shared/kle/pos-key'

/** One annotated key. `legend` is drawn on the key; `desc` is the long form
 *  (destined for the hover bubble — phase 4). */
export interface KeyNote {
  legend: string
  desc?: string
}

/** layer index (stringified) -> `"row,col"` -> note. Matches the on-disk pack
 *  shape in the design doc so an importer/exporter needs no translation. */
export type KeyNotesByLayer = Record<string, Record<string, KeyNote>>

/** The exact per-key override shape `KeyboardWidget`/`KeyWidget` already
 *  accept, keyed by `posKey(row, col)`. */
export interface LabelOverride {
  outer: string
  inner: string
  masked: boolean
}

const STORAGE_PREFIX = 'pipette:key-notes:'
/** Separate key from the notes themselves so toggling visibility never
 *  rewrites (or risks corrupting) the authored labels. */
const VISIBLE_PREFIX = 'pipette:key-notes-visible:'

/** Fired after any write so every hook instance (editor pane, typing view,
 *  overlay window) re-reads. Mirrors `useKeyLabels`'s
 *  `'pipette:key-labels-changed'` convention. */
const CHANGED_EVENT = 'pipette:key-notes-changed'

/** Notes are per keyboard. Falls back to a shared bucket when no uid is known
 *  (dummy keyboards, file mode) so the feature still works there. */
function storageKey(keyboardUid?: string): string {
  return `${STORAGE_PREFIX}${keyboardUid && keyboardUid.length > 0 ? keyboardUid : 'default'}`
}

/** In-memory source of truth, keyed by storage key. localStorage is only a
 *  best-effort persistence layer on top: it is absent or method-less in some
 *  runtimes (Node's experimental `localStorage` shadows jsdom's under the test
 *  environment, exposing an object with no `getItem`/`setItem`), and browsers
 *  can refuse writes on quota/permission. Keeping the cache authoritative means
 *  the feature behaves identically either way — edits always apply, and only
 *  cross-restart persistence degrades. */
const memoryCache = new Map<string, KeyNotesByLayer>()

/** Feature-detect rather than assume: `typeof localStorage !== 'undefined'` is
 *  not enough (see `memoryCache`). */
function usableStorage(): Storage | undefined {
  const ls = globalThis.localStorage as Storage | undefined
  if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return undefined
  return ls
}

export function readKeyNotes(keyboardUid?: string): KeyNotesByLayer {
  const key = storageKey(keyboardUid)
  const cached = memoryCache.get(key)
  if (cached) return cached
  try {
    const raw = usableStorage()?.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const notes = parsed as KeyNotesByLayer
    memoryCache.set(key, notes)
    return notes
  } catch {
    // Corrupt JSON — treat as "no notes" rather than breaking the whole editor
    // over an annotation feature.
    return {}
  }
}

export function writeKeyNotes(notes: KeyNotesByLayer, keyboardUid?: string): void {
  const key = storageKey(keyboardUid)
  memoryCache.set(key, notes)
  try {
    usableStorage()?.setItem(key, JSON.stringify(notes))
  } catch {
    // Quota/permission failure — the cache above already holds the edit, so the
    // user still sees it; only persistence across restarts is lost.
  }
  globalThis.dispatchEvent?.(new Event(CHANGED_EVENT))
}

/** Visibility, per keyboard. Same in-memory-authoritative pattern as the notes
 *  themselves. Defaults to ON: a user who has authored labels wants to see
 *  them, and a keyboard with no labels renders identically either way. */
const visibleCache = new Map<string, boolean>()

function visibleKey(keyboardUid?: string): string {
  return `${VISIBLE_PREFIX}${keyboardUid && keyboardUid.length > 0 ? keyboardUid : 'default'}`
}

export function readKeyNotesVisible(keyboardUid?: string): boolean {
  const key = visibleKey(keyboardUid)
  const cached = visibleCache.get(key)
  if (cached !== undefined) return cached
  // Only the explicit string 'off' hides them — anything else (absent, garbage,
  // a half-written value) falls back to visible rather than silently blanking
  // labels the user spent time authoring.
  const stored = usableStorage()?.getItem(key)
  const visible = stored !== 'off'
  visibleCache.set(key, visible)
  return visible
}

export function writeKeyNotesVisible(visible: boolean, keyboardUid?: string): void {
  const key = visibleKey(keyboardUid)
  visibleCache.set(key, visible)
  try {
    usableStorage()?.setItem(key, visible ? 'on' : 'off')
  } catch {
    // See writeKeyNotes — the cache already holds it.
  }
  globalThis.dispatchEvent?.(new Event(CHANGED_EVENT))
}

/** Drop the in-memory caches AND any persisted keys of ours. Exists for tests,
 *  which need a clean slate between cases and can't rely on
 *  `localStorage.clear()` existing.
 *
 *  Clearing storage too matters: where `localStorage` is real (jsdom under
 *  Node ≤ 24, i.e. CI), `readKeyNotes` would otherwise re-read the previous
 *  test's labels straight back into the freshly emptied cache. Under Node 25
 *  the storage is method-less so this was invisible locally. */
export function resetKeyNotesCache(): void {
  memoryCache.clear()
  visibleCache.clear()
  const ls = usableStorage()
  if (!ls || typeof ls.removeItem !== 'function' || typeof ls.key !== 'function') return
  try {
    const ours: string[] = []
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k && (k.startsWith(STORAGE_PREFIX) || k.startsWith(VISIBLE_PREFIX))) ours.push(k)
    }
    for (const k of ours) ls.removeItem(k)
  } catch {
    // Best effort — a storage that refuses to enumerate can't leak between tests either.
  }
}

// ---------------------------------------------------------------------------
// Save to / load from a file
//
// localStorage is per-machine and per-Electron-profile: labels don't survive a
// reinstall, don't reach a second computer, and aren't in any of Pipette's
// existing exports (`.vil` carries keycodes, not annotations). So the notes get
// their own small sidecar file, deliberately separate from `.vil` rather than
// bolted into it — a `.vil` is consumed by Vial itself and other tools, and
// smuggling non-standard keys into it risks confusing them.
//
// Uses the existing `exportJson` / `sideloadJson` IPC (save/open dialog in the
// main process), so this adds no new channel and no new main-process code.
// ---------------------------------------------------------------------------

/** Marker so an import can tell a labels file from any other JSON the user
 *  might pick in the file dialog. */
export const KEY_NOTES_FILE_KIND = 'pipette-key-notes'
/** Bump only on a breaking shape change; readers accept anything <= this. */
export const KEY_NOTES_FILE_VERSION = 1

export interface KeyNotesFile {
  kind: typeof KEY_NOTES_FILE_KIND
  version: number
  /** Which keyboard these were authored against — informational. Import does
   *  NOT enforce a match, so labels can be moved onto a rebuilt or renamed
   *  board (a common reason to have a backup in the first place). */
  keyboard?: string
  exportedAt: string
  notes: KeyNotesByLayer
}

export function serializeKeyNotes(notes: KeyNotesByLayer, keyboardUid?: string): string {
  const file: KeyNotesFile = {
    kind: KEY_NOTES_FILE_KIND,
    version: KEY_NOTES_FILE_VERSION,
    ...(keyboardUid && keyboardUid.length > 0 ? { keyboard: keyboardUid } : {}),
    exportedAt: new Date().toISOString(),
    notes,
  }
  // Pretty-printed: these files are small, hand-editable, and diff nicely in a
  // dotfiles repo, which is half the point of being able to save them.
  return JSON.stringify(file, null, 2)
}

export interface ParsedKeyNotes {
  notes: KeyNotesByLayer
  keyboard?: string
  /** Entries dropped as malformed. Surfaced to the user rather than swallowed,
   *  so a partially-bad file doesn't silently lose labels. */
  skipped: number
}

/** Validate and normalise a parsed labels file.
 *
 *  Strict about the envelope (a wrong `kind` is a wrong file, and importing it
 *  would replace real labels with nonsense) but lenient inside `notes`: unknown
 *  or malformed entries are counted and skipped so one bad key can't cost the
 *  user the rest of the file. Returns a string on rejection — the caller shows
 *  it verbatim. */
export function parseKeyNotesFile(input: unknown): ParsedKeyNotes | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 'Not a labels file (expected a JSON object).'
  }
  const file = input as Partial<KeyNotesFile>
  if (file.kind !== KEY_NOTES_FILE_KIND) {
    return `Not a Pipette labels file (kind: ${typeof file.kind === 'string' ? file.kind : 'missing'}).`
  }
  if (typeof file.version !== 'number' || file.version > KEY_NOTES_FILE_VERSION) {
    return `Labels file version ${String(file.version)} is newer than this build understands (max ${KEY_NOTES_FILE_VERSION}).`
  }
  const rawNotes = file.notes
  if (rawNotes === null || typeof rawNotes !== 'object' || Array.isArray(rawNotes)) {
    return 'Labels file has no usable `notes` object.'
  }

  const notes: KeyNotesByLayer = {}
  let skipped = 0
  for (const [layerKey, layerNotes] of Object.entries(rawNotes as Record<string, unknown>)) {
    // Layer keys are stringified indices; anything else means a different
    // schema, not a layer we can render.
    if (!/^\d+$/.test(layerKey)) { skipped += 1; continue }
    if (layerNotes === null || typeof layerNotes !== 'object' || Array.isArray(layerNotes)) { skipped += 1; continue }
    const outLayer: Record<string, KeyNote> = {}
    for (const [pos, note] of Object.entries(layerNotes as Record<string, unknown>)) {
      // Positions must be `row,col` with integer parts — `buildKeyNoteOverrides`
      // would drop anything else anyway, so reject here where we can report it.
      if (!/^\d+,\d+$/.test(pos)) { skipped += 1; continue }
      if (note === null || typeof note !== 'object') { skipped += 1; continue }
      const legend = (note as Partial<KeyNote>).legend
      if (typeof legend !== 'string' || legend.trim().length === 0) { skipped += 1; continue }
      const desc = (note as Partial<KeyNote>).desc
      outLayer[pos] = typeof desc === 'string' ? { legend: legend.trim(), desc } : { legend: legend.trim() }
    }
    if (Object.keys(outLayer).length > 0) notes[layerKey] = outLayer
  }

  return { notes, skipped, ...(typeof file.keyboard === 'string' ? { keyboard: file.keyboard } : {}) }
}

/** Count every label across all layers — for reporting "imported N labels". */
export function countKeyNotes(notes: KeyNotesByLayer): number {
  return Object.values(notes).reduce((sum, layer) => sum + Object.keys(layer).length, 0)
}

/** Deep-merge two note sets, `incoming` winning per key. Layers and keys absent
 *  from `incoming` are preserved, so importing a one-layer file doesn't wipe the
 *  others. */
export function mergeKeyNotes(base: KeyNotesByLayer, incoming: KeyNotesByLayer): KeyNotesByLayer {
  const out: KeyNotesByLayer = {}
  for (const [layer, keys] of Object.entries(base)) out[layer] = { ...keys }
  for (const [layer, keys] of Object.entries(incoming)) out[layer] = { ...(out[layer] ?? {}), ...keys }
  return out
}

/** How an import treats labels the keyboard already has. */
export type KeyNotesImportMode = 'merge' | 'replace'

/** Outcome of a save/load, ready to show inline. `ok: false` with an empty
 *  message means the user cancelled the file dialog — nothing went wrong, so
 *  the UI should stay quiet. */
export interface KeyNotesIoResult {
  ok: boolean
  message: string
}




/** `KeyWidget` draws labels as fixed-size SVG `<text>` with no wrapping and no
 *  shrink-to-fit, but it DOES slot `\n`-separated parts (1 centred, 2 top/
 *  bottom, 3 sliced, 4 quadrants; beyond 4 dropped). So split a long legend at
 *  its most balanced space rather than letting it overflow the key. Legends
 *  already containing `\n` are passed through untouched. */
export function formatLegend(legend: string, maxLine = 9): string {
  if (legend.includes('\n') || legend.length <= maxLine) return legend
  const spaces: number[] = []
  for (let i = 0; i < legend.length; i += 1) if (legend[i] === ' ') spaces.push(i)
  if (spaces.length === 0) return legend
  const mid = legend.length / 2
  let best = spaces[0]
  for (const i of spaces) if (Math.abs(i - mid) < Math.abs(best - mid)) best = i
  return `${legend.slice(0, best)}\n${legend.slice(best + 1)}`
}

/** Turn one layer's notes into the renderer's override map. Returns undefined
 *  (not an empty Map) when nothing applies, so callers keep passing through the
 *  cheap "no overrides" path. */
export function buildKeyNoteOverrides(
  notes: KeyNotesByLayer,
  layer: number,
): Map<string, LabelOverride> | undefined {
  const layerNotes = notes[String(layer)]
  if (!layerNotes) return undefined
  const out = new Map<string, LabelOverride>()
  for (const [pos, note] of Object.entries(layerNotes)) {
    if (!note || typeof note.legend !== 'string' || note.legend.length === 0) continue
    const [row, col] = pos.split(',').map((n) => Number(n.trim()))
    if (!Number.isInteger(row) || !Number.isInteger(col)) continue
    // `masked: false` collapses an annotated LT/MT key to one legend on
    // purpose: the note says what the key DOES in this app, which is the whole
    // point — the tap/hold split is editor detail the label view doesn't need.
    out.set(posKey(row, col), { outer: formatLegend(note.legend), inner: '', masked: false })
  }
  return out.size > 0 ? out : undefined
}

/** Merge two override maps, `base` winning on collisions — used to keep View
 *  Matrix mode's R/C legends authoritative over notes. */
export function mergeLabelOverrides(
  base: Map<string, LabelOverride> | undefined,
  extra: Map<string, LabelOverride> | undefined,
): Map<string, LabelOverride> | undefined {
  if (!extra) return base
  if (!base) return extra
  const merged = new Map(extra)
  for (const [pos, override] of base) merged.set(pos, override)
  return merged
}

export interface UseKeyNotesReturn {
  /** All notes for this keyboard, every layer. */
  notes: KeyNotesByLayer
  /** This key's current legend (empty string when unannotated). */
  getLegend: (layer: number, row: number, col: number) => string
  /** Write (or clear, when `legend` is empty/blank) one key's note. */
  setLegend: (layer: number, row: number, col: number, legend: string, desc?: string) => void
  /** Drop every note for this keyboard. */
  clearAll: () => void
  /** Ready-to-render override map for one layer — `undefined` when the layer
   *  has no notes OR when labels are toggled off, so hiding them costs the
   *  renderer nothing beyond the usual no-overrides path. */
  overridesForLayer: (layer: number) => Map<string, LabelOverride> | undefined
  /** Whether labels are currently drawn on keys (persisted per keyboard).
   *  Independent of the editing panel: you can hide the labels while still
   *  having them, and edit them while hidden (the panel's own list still
   *  shows them). */
  visible: boolean
  toggleVisible: () => void
  /** True when this keyboard has at least one label on any layer — lets the
   *  UI avoid offering a toggle that would visibly do nothing. */
  hasAnyNotes: boolean
  /** Write every label for this keyboard to a `.json` file the user picks. */
  saveToFile: () => Promise<KeyNotesIoResult>
  /** Read labels back from a file. `merge` keeps existing labels that the file
   *  doesn't mention; `replace` drops them first. */
  loadFromFile: (mode?: KeyNotesImportMode) => Promise<KeyNotesIoResult>
}



/** Per-keyboard notes state. Every instance re-reads on the change event, so
 *  the editor pane and the typing view stay in lockstep without prop drilling
 *  the setter around. */
export function useKeyNotes(keyboardUid?: string): UseKeyNotesReturn {
  const [notes, setNotes] = useState<KeyNotesByLayer>(() => readKeyNotes(keyboardUid))
  const [visible, setVisible] = useState<boolean>(() => readKeyNotesVisible(keyboardUid))

  // Re-read on keyboard switch and on any write from another instance — one
  // effect for both pieces of state, since a single event covers both and they
  // must never disagree between the editor pane and the typing view.
  useEffect(() => {
    setNotes(readKeyNotes(keyboardUid))
    setVisible(readKeyNotesVisible(keyboardUid))
    const onChanged = () => {
      setNotes(readKeyNotes(keyboardUid))
      setVisible(readKeyNotesVisible(keyboardUid))
    }
    globalThis.addEventListener?.(CHANGED_EVENT, onChanged)
    return () => globalThis.removeEventListener?.(CHANGED_EVENT, onChanged)
  }, [keyboardUid])

  const toggleVisible = useCallback(() => {
    // Derive from the store rather than the local `visible` snapshot: another
    // instance (typing view, overlay window) may have flipped it since this
    // component last rendered.
    const next = !readKeyNotesVisible(keyboardUid)
    setVisible(next)
    writeKeyNotesVisible(next, keyboardUid)
  }, [keyboardUid])


  const getLegend = useCallback((layer: number, row: number, col: number) => {
    return notes[String(layer)]?.[posKey(row, col)]?.legend ?? ''
  }, [notes])

  const setLegend = useCallback((layer: number, row: number, col: number, legend: string, desc?: string) => {
    const layerKey = String(layer)
    const pos = posKey(row, col)
    const trimmed = legend.trim()
    // Rebuild immutably (rather than mutating `notes`) so React sees a new
    // object and every consumer's memo actually invalidates.
    const next: KeyNotesByLayer = { ...notes, [layerKey]: { ...(notes[layerKey] ?? {}) } }
    if (trimmed.length === 0) {
      delete next[layerKey][pos]
      if (Object.keys(next[layerKey]).length === 0) delete next[layerKey]
    } else {
      next[layerKey][pos] = desc !== undefined ? { legend: trimmed, desc } : { legend: trimmed }
    }
    setNotes(next)
    writeKeyNotes(next, keyboardUid)
  }, [notes, keyboardUid])

  const clearAll = useCallback(() => {
    setNotes({})
    writeKeyNotes({}, keyboardUid)
  }, [keyboardUid])

  // Cache per layer: the editor pane and the typing view ask for different
  // layers on the same render, and each map is O(notes) to build. Keyed on
  // `notes` only — `visible` short-circuits before the cache is consulted, so
  // toggling it doesn't need to invalidate anything.
  const overrideCache = useMemo(() => new Map<number, Map<string, LabelOverride> | undefined>(), [notes])
  const overridesForLayer = useCallback((layer: number) => {
    // Hidden: report "no overrides" rather than an empty Map, so every consumer
    // takes exactly the same path it does on a keyboard with no labels at all.
    if (!visible) return undefined
    if (overrideCache.has(layer)) return overrideCache.get(layer)
    const built = buildKeyNoteOverrides(notes, layer)
    overrideCache.set(layer, built)
    return built
  }, [notes, overrideCache, visible])

  // Any layer with at least one usable legend. Cheap: layer count is small and
  // this only re-runs when the notes object itself changes.
  const hasAnyNotes = useMemo(
    () => Object.values(notes).some((layer) => Object.values(layer).some((n) => n?.legend)),
    [notes],
  )

  const saveToFile = useCallback(async (): Promise<KeyNotesIoResult> => {
    // Read through the store rather than trusting the `notes` snapshot: the
    // typing view or overlay may have edited since this component last
    // rendered, and a backup that silently omits those would be worse than no
    // backup at all.
    const current = readKeyNotes(keyboardUid)
    const count = countKeyNotes(current)
    if (count === 0) return { ok: false, message: 'Nothing to save — no labels yet.' }

    const api = globalThis.window?.vialAPI
    if (!api?.exportJson) return { ok: false, message: 'Saving to a file is unavailable in this window.' }

    try {
      const defaultName = `pipette-labels-${keyboardUid && keyboardUid.length > 0 ? keyboardUid : 'keyboard'}`
      const result = await api.exportJson(serializeKeyNotes(current, keyboardUid), defaultName)
      // Cancelling the dialog is a normal choice, not a failure — empty message
      // tells the UI to say nothing.
      if (!result.success) {
        return result.error === 'cancelled'
          ? { ok: false, message: '' }
          : { ok: false, message: `Could not save: ${result.error ?? 'unknown error'}` }
      }
      return { ok: true, message: `Saved ${count} label${count === 1 ? '' : 's'}.` }
    } catch (err) {
      return { ok: false, message: `Could not save: ${String(err)}` }
    }
  }, [keyboardUid])

  const loadFromFile = useCallback(async (mode: KeyNotesImportMode = 'merge'): Promise<KeyNotesIoResult> => {
    const api = globalThis.window?.vialAPI
    if (!api?.sideloadJson) return { ok: false, message: 'Loading from a file is unavailable in this window.' }

    let raw: unknown
    try {
      const result = await api.sideloadJson('Load key labels')
      if (!result.success) {
        return result.error === 'cancelled'
          ? { ok: false, message: '' }
          : { ok: false, message: `Could not open: ${result.error ?? 'unknown error'}` }
      }
      raw = result.data
    } catch (err) {
      return { ok: false, message: `Could not open: ${String(err)}` }
    }

    const parsed = parseKeyNotesFile(raw)
    if (typeof parsed === 'string') return { ok: false, message: parsed }

    const incomingCount = countKeyNotes(parsed.notes)
    if (incomingCount === 0) {
      return { ok: false, message: 'That file contains no usable labels.' }
    }

    // Merge against the store, not the render snapshot — same reasoning as
    // saveToFile.
    const next = mode === 'replace'
      ? parsed.notes
      : mergeKeyNotes(readKeyNotes(keyboardUid), parsed.notes)
    setNotes(next)
    writeKeyNotes(next, keyboardUid)

    const verb = mode === 'replace' ? 'Replaced with' : 'Merged in'
    const skipNote = parsed.skipped > 0 ? ` (${parsed.skipped} entr${parsed.skipped === 1 ? 'y' : 'ies'} skipped)` : ''
    return {
      ok: true,
      message: `${verb} ${incomingCount} label${incomingCount === 1 ? '' : 's'}${skipNote}.`,
    }
  }, [keyboardUid])

  return {
    notes, getLegend, setLegend, clearAll, overridesForLayer,
    visible, toggleVisible, hasAnyNotes, saveToFile, loadFromFile,
  }
}


