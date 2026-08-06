// SPDX-License-Identifier: GPL-2.0-or-later
//
// Label-view editing panel. Sits where the keycode picker normally is (see
// `KeymapEditor`), and is the user-facing half of `key-notes-store.ts`: click a
// key on the keymap, type what it actually does, and that word replaces the
// keycode legend on the key — in the editor, the typing view, and the floating
// overlay.
//
// Deliberately does NOT touch the keymap. Clearing the text box removes the
// label and the key goes back to showing its keycode.

import { useEffect, useRef, useState } from 'react'
import { Tags, X, Eye, EyeOff, Download, Upload } from 'lucide-react'

import { posKey } from '../../../shared/kle/pos-key'
import { ICON_SM } from '../../constants/ui-tokens'
import { Tooltip } from '../ui/Tooltip'
import type { KeyNotesByLayer, KeyNotesImportMode, KeyNotesIoResult } from './key-notes-store'

export interface KeyNotesPanelProps {
  /** Layer whose labels are being edited — the one visible on the pane. */
  layer: number
  /** Currently selected key, or null. Null is the normal resting state, so the
   *  panel explains what to do rather than showing a dead input. */
  selectedKey: { row: number; col: number } | null
  /** Current legend for the selection (empty when unannotated). */
  legend: string
  /** All notes for this keyboard — drives the count + list below. */
  notes: KeyNotesByLayer
  onSetLegend: (layer: number, row: number, col: number, legend: string) => void
  onClearAll: () => void
  /** Turns the whole label view off (back to the keycode picker). */
  onClose: () => void
  /** Whether labels are currently drawn on the keys. Distinct from this panel
   *  being open: you can hide the labels and still edit them here (the list
   *  below stays visible either way). */
  visible: boolean
  onToggleVisible: () => void
  /** Write all labels for this keyboard to a file the user picks. Optional so
   *  the panel still renders in contexts without file access. */
  onSaveToFile?: () => Promise<KeyNotesIoResult>
  /** Read labels back in. Defaults to merging; hold Shift to replace instead. */
  onLoadFromFile?: (mode?: KeyNotesImportMode) => Promise<KeyNotesIoResult>
}

/** Panel is keyed on the selected position by the caller, so switching keys
 *  remounts it and the input starts from that key's stored legend rather than
 *  carrying the previous key's draft over. */
export function KeyNotesPanel({
  layer, selectedKey, legend, notes, onSetLegend, onClearAll, onClose,
  visible, onToggleVisible, onSaveToFile, onLoadFromFile,
}: KeyNotesPanelProps): JSX.Element {

  const [draft, setDraft] = useState(legend)
  const inputRef = useRef<HTMLInputElement>(null)
  // Last save/load outcome, shown inline. There is no toast system in this app
  // (see PackResultBadge et al.) — local state plus a line of text is the
  // house style.
  const [io, setIo] = useState<KeyNotesIoResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function runIo(action: () => Promise<KeyNotesIoResult>) {
    setBusy(true)
    setIo(null)
    try {
      const result = await action()
      // A cancelled file dialog reports ok:false with an empty message; showing
      // nothing is the correct response to "user changed their mind".
      setIo(result.message.length > 0 ? result : null)
    } catch (err) {
      setIo({ ok: false, message: String(err) })
    } finally {
      setBusy(false)
    }
  }

  // Follow the selection: a click on a different key must load THAT key's
  // legend, not keep editing the last one.
  useEffect(() => { setDraft(legend) }, [legend, selectedKey?.row, selectedKey?.col])

  // Autofocus on selecting a key so it's type-immediately, no second click.
  useEffect(() => { if (selectedKey) inputRef.current?.focus() }, [selectedKey?.row, selectedKey?.col])

  function commit(value: string) {
    if (!selectedKey) return
    onSetLegend(layer, selectedKey.row, selectedKey.col, value)
  }

  const layerNotes = notes[String(layer)] ?? {}
  const entries = Object.entries(layerNotes)

  return (
    <div
      data-testid="key-notes-panel"
      className="flex w-full flex-col gap-3 rounded-xl border border-edge-subtle bg-surface-alt p-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-content">
          <Tags size={ICON_SM} aria-hidden="true" />
          <span>Labels — Layer {layer}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Show/hide is about the LEGENDS ON THE KEYS, not this panel —
              hiding them leaves every label intact and still editable here,
              so it's a display switch rather than a destructive action. */}
          <button
            type="button"
            data-testid="key-notes-visible-toggle"
            onClick={onToggleVisible}
            aria-pressed={visible}
            className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs text-content-secondary transition-colors hover:bg-surface-dim hover:text-content"
            aria-label={visible ? 'Hide labels on keys' : 'Show labels on keys'}
          >
            {visible
              ? <Eye size={ICON_SM} aria-hidden="true" />
              : <EyeOff size={ICON_SM} aria-hidden="true" />}
            <span>{visible ? 'Shown' : 'Hidden'}</span>
          </button>
          <button
            type="button"
            data-testid="key-notes-close"
            onClick={onClose}
            className="rounded-md p-1 text-content-muted transition-colors hover:bg-surface-dim hover:text-content"
            aria-label="Close label view"
          >
            <X size={ICON_SM} aria-hidden="true" />
          </button>
        </div>

      </div>

      {selectedKey ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="key-notes-input"
            className="text-xs text-content-muted"
          >
            Label for key at row {selectedKey.row}, col {selectedKey.col}
          </label>
          <div className="flex gap-2">
            <input
              id="key-notes-input"
              data-testid="key-notes-input"
              ref={inputRef}
              value={draft}
              placeholder="e.g. Bulldoze"
              onChange={(e) => {
                // Live-apply so the legend updates on the key as you type —
                // that immediate feedback is the whole appeal of the view.
                setDraft(e.target.value)
                commit(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(draft)
                if (e.key === 'Escape') { setDraft(legend); commit(legend) }
              }}
              className="flex-1 rounded-md border border-edge bg-transparent px-2 py-1 text-sm text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              data-testid="key-notes-clear"
              onClick={() => { setDraft(''); commit('') }}
              disabled={draft.length === 0}
              className="rounded-md border border-edge px-2 py-1 text-xs text-content-secondary transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none"
            >
              Clear
            </button>
          </div>
          <p className="text-xs text-content-muted">
            Long labels wrap automatically. Clearing the box restores the keycode legend.
          </p>
        </div>
      ) : (
        <p data-testid="key-notes-hint" className="text-sm text-content-muted">
          Click a key on the keymap above, then type what it actually does.
          Labels are saved per keyboard and per layer, and never change your keymap.
        </p>
      )}

      <div className="flex flex-col gap-1 border-t border-edge-subtle pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-content-muted">
            {entries.length === 0
              ? 'No labels on this layer yet'
              : `${entries.length} label${entries.length === 1 ? '' : 's'} on this layer`}
          </span>
          <div className="flex items-center gap-1">
            {/* Labels live in this machine's browser storage, so a file is the
                only way to back them up, move them to another computer, or keep
                them in a dotfiles repo. Kept as its own sidecar JSON rather than
                folded into `.vil` — that file is read by Vial and other tools,
                and non-standard keys in it could confuse them. */}
            {onSaveToFile && (
              <Tooltip content="Save all labels for this keyboard to a file">
                <button
                  type="button"
                  data-testid="key-notes-save-file"
                  onClick={() => void runIo(onSaveToFile)}
                  disabled={busy || Object.keys(notes).length === 0}
                  className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs text-content-secondary transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none"
                >
                  <Download size={ICON_SM} aria-hidden="true" />
                  <span>Save</span>
                </button>
              </Tooltip>
            )}
            {onLoadFromFile && (
              <Tooltip content="Load labels from a file, merging with what's already here. Shift-click to replace instead.">
                <button
                  type="button"
                  data-testid="key-notes-load-file"
                  // Shift-click replaces instead of merging. Merge is the default
                  // because it's the non-destructive one; replace is there for
                  // "restore this backup exactly".
                  onClick={(e) => void runIo(() => onLoadFromFile(e.shiftKey ? 'replace' : 'merge'))}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs text-content-secondary transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none"
                >
                  <Upload size={ICON_SM} aria-hidden="true" />
                  <span>Load</span>
                </button>
              </Tooltip>
            )}

            <button
              type="button"
              data-testid="key-notes-clear-all"
              onClick={onClearAll}
              disabled={Object.keys(notes).length === 0}
              className="rounded-md px-2 py-1 text-xs text-content-muted transition-colors hover:bg-surface-dim hover:text-content disabled:opacity-30 disabled:pointer-events-none"
            >
              Clear all
            </button>
          </div>
        </div>
        {io && (
          <p
            data-testid="key-notes-io-result"
            role="status"
            className={`text-xs ${io.ok ? 'text-content-secondary' : 'text-danger'}`}
          >
            {io.message}
          </p>
        )}

        {entries.length > 0 && (
          <ul data-testid="key-notes-list" className="flex flex-wrap gap-1">
            {entries.map(([pos, note]) => (
              <li
                key={pos}
                className={`rounded border px-1.5 py-0.5 text-xs ${
                  selectedKey && pos === posKey(selectedKey.row, selectedKey.col)
                    ? 'border-accent text-content'
                    : 'border-edge text-content-secondary'
                }`}
              >
                <span className="tabular-nums text-content-muted">{pos}</span>{' '}
                {note.legend}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
