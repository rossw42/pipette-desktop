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

/** Drop the in-memory caches. Exists for tests, which need a clean slate
 *  between cases and can't rely on `localStorage.clear()` existing. */
export function resetKeyNotesCache(): void {
  memoryCache.clear()
  visibleCache.clear()
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

  return {
    notes, getLegend, setLegend, clearAll, overridesForLayer,
    visible, toggleVisible, hasAnyNotes,
  }
}

