// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Label view (Key Notes): user-authored semantic legends. Exercises the REAL
// user flow — open the label editor, click a key, type a label, see it drawn on
// that key — against the REAL `KeyboardWidget`/`KeyWidget` tree (most editor
// suites stub the widget out, which would let a broken render path pass).
//
// See `key-notes-store.ts` and `keymap_labeler/PIPETTE-INTEGRATION.md`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'editor.keymap.layerPreview' ? `Preview - ${String(opts?.label ?? '')}` : key,
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { maxKeymapHistory: 100 }, loading: false, set: () => {} }),
}))

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes" />,
}))
vi.mock('../../keycodes/ModifierCheckboxStrip', () => ({ ModifierCheckboxStrip: () => null }))
vi.mock('../../../../preload/macro', () => ({ deserializeAllMacros: () => [] }))
vi.mock('../TapDanceModal', () => ({ TapDanceModal: () => null }))
vi.mock('../MacroModal', () => ({ MacroModal: () => null }))

import { KeymapEditor } from '../KeymapEditor'
import {
  formatLegend, buildKeyNoteOverrides, mergeLabelOverrides, resetKeyNotesCache,
} from '../key-notes-store'
import type { KleKey } from '../../../../shared/kle/types'

beforeEach(() => {
  // Notes persist between renders, so each test needs a clean slate — otherwise
  // a label written by one case leaks into the next. Goes through the store's
  // own reset rather than `localStorage.clear()`, which does not exist in this
  // environment (Node's experimental `localStorage` shadows jsdom's and exposes
  // no methods at all — the same reason the store keeps an in-memory cache).
  resetKeyNotesCache()

  window.vialAPI = {
    ...window.vialAPI,
    isAlwaysOnTopSupported: () => Promise.resolve(false),
    setWindowCompactMode: () => Promise.resolve(null),
    setWindowAspectRatio: () => Promise.resolve(),
    setWindowAlwaysOnTop: () => Promise.resolve(),
    // The typing-test surface queries saved run logs on mount whenever a
    // keyboard uid is known (`useRunLogAvailability`) — stubbed so the typing
    // view cases below exercise label rendering rather than tripping over an
    // unrelated missing IPC method.
    typingRunLogList: () => Promise.resolve({ success: true, data: [] }),
  } as unknown as typeof window.vialAPI
})


const KEY_DEFAULTS: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

// 2x2 grid. Every position holds the SAME keycode (KC_A = 4) so a per-keycode
// mechanism (i.e. today's Key Labels packs) could never produce differing
// labels — anything position-specific below must have come from Key Notes.
const KEYS: KleKey[] = []
for (let r = 0; r < 2; r += 1) {
  for (let c = 0; c < 2; c += 1) KEYS.push({ ...KEY_DEFAULTS, row: r, col: c, x: c, y: r })
}
const keymap = new Map<string, number>()
for (const layer of [0, 1]) for (const k of KEYS) keymap.set(`${layer},${k.row},${k.col}`, 4)

function baseProps() {
  return {
    layout: { keys: KEYS },
    layers: 2,
    currentLayer: 0,
    onLayerChange: vi.fn(),
    keymap,
    encoderLayout: new Map<string, number>(),
    encoderCount: 0,
    layoutOptions: new Map<number, number>(),
    onSetKey: vi.fn().mockResolvedValue(undefined),
    onSetKeysBulk: vi.fn().mockResolvedValue(undefined),
    onSetEncoder: vi.fn().mockResolvedValue(undefined),
    keyboardUid: 'TESTUID',
  }
}

/** `<text>` labels belonging to one key, via the `data-key-pos` attribute
 *  `KeyWidget` already sets — ties a legend to a specific matrix position
 *  rather than just "somewhere on the board". `KeyWidget` splits multi-part
 *  labels across sibling nodes, so these are joined by the callers. */
function labelsAtPos(container: HTMLElement, pos: string): string {
  const g = container.querySelector(`[data-key-pos="${pos}"]`)
  if (!g) return 'NO-SUCH-KEY'
  return [...g.querySelectorAll('text')].map((t) => t.textContent ?? '').join(' ')
}

/** The documented user flow: toolbar Labels button -> click key -> type. */
function openLabelEditorAndType(container: HTMLElement, pos: string, text: string) {
  fireEvent.click(screen.getByTestId('label-view-button'))
  const keyEl = container.querySelector(`[data-key-pos="${pos}"]`)
  expect(keyEl).toBeTruthy()
  fireEvent.click(keyEl as Element)
  fireEvent.change(screen.getByTestId('key-notes-input'), { target: { value: text } })
}

describe('Label view — editing labels in Pipette', () => {
  it('shows the label editor only after the toolbar toggle is clicked', () => {
    render(<KeymapEditor {...baseProps()} />)
    expect(screen.queryByTestId('key-notes-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('label-view-button'))
    expect(screen.getByTestId('key-notes-panel')).toBeInTheDocument()
    // And it replaces the keycode picker rather than stacking with it.
    expect(screen.queryByTestId('tabbed-keycodes')).not.toBeInTheDocument()
  })

  it('prompts to pick a key when nothing is selected', () => {
    render(<KeymapEditor {...baseProps()} />)
    fireEvent.click(screen.getByTestId('label-view-button'))
    expect(screen.getByTestId('key-notes-hint')).toBeInTheDocument()
    expect(screen.queryByTestId('key-notes-input')).not.toBeInTheDocument()
  })

  it('draws a typed label on that key, replacing its keycode legend', () => {
    const { container } = render(<KeymapEditor {...baseProps()} />)
    expect(labelsAtPos(container, '0,0')).toContain('A')
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    const at00 = labelsAtPos(container, '0,0')
    expect(at00).toContain('Bulldoze')
    expect(at00).not.toContain('KC_A')
  })

  it('leaves every other key untouched (labels are additive)', () => {
    const { container } = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    // Same keycode as 0,0, so only position-keyed data could differ.
    const at11 = labelsAtPos(container, '1,1')
    expect(at11).not.toContain('Bulldoze')
    expect(at11).toContain('A')
  })

  it('clearing the text restores the keycode legend', () => {
    const { container } = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    expect(labelsAtPos(container, '0,0')).toContain('Bulldoze')
    fireEvent.click(screen.getByTestId('key-notes-clear'))
    const at00 = labelsAtPos(container, '0,0')
    expect(at00).not.toContain('Bulldoze')
    expect(at00).toContain('A')
  })

  it('keeps labels per layer — the same key can say something else elsewhere', () => {
    const { container, unmount } = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    unmount()
    // Re-render on layer 1: the label written on layer 0 must NOT appear.
    const second = render(<KeymapEditor {...baseProps()} currentLayer={1} />)
    expect(labelsAtPos(second.container, '0,0')).not.toContain('Bulldoze')
    openLabelEditorAndType(second.container, '0,0', 'Develop')
    expect(labelsAtPos(second.container, '0,0')).toContain('Develop')
  })

  it('persists labels across a remount (same keyboard uid)', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    first.unmount()
    const second = render(<KeymapEditor {...baseProps()} />)
    expect(labelsAtPos(second.container, '0,0')).toContain('Bulldoze')
  })

  it('scopes labels to the keyboard — another uid starts clean', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    first.unmount()
    const other = render(<KeymapEditor {...baseProps()} keyboardUid="OTHERUID" />)
    expect(labelsAtPos(other.container, '0,0')).not.toContain('Bulldoze')
  })

  it('renders labels in the typing view (its own KeyboardPane)', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    first.unmount()
    const typing = render(<KeymapEditor {...baseProps()} typingTestMode />)
    expect(typing.container.querySelector('[data-testid="typing-test-layer-note"]')).toBeTruthy()
    expect(labelsAtPos(typing.container, '0,0')).toContain('Bulldoze')
  })

  it('renders labels in view-only (floating overlay) mode', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    first.unmount()
    const overlay = render(<KeymapEditor {...baseProps()} typingTestMode typingTestViewOnly />)
    expect(labelsAtPos(overlay.container, '0,0')).toContain('Bulldoze')
  })

  it('lists the labels on the current layer, and Clear all removes them', () => {
    const { container } = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    expect(screen.getByTestId('key-notes-list').textContent).toContain('Bulldoze')
    fireEvent.click(screen.getByTestId('key-notes-clear-all'))
    expect(screen.queryByTestId('key-notes-list')).not.toBeInTheDocument()
    expect(labelsAtPos(container, '0,0')).not.toContain('Bulldoze')
  })
})

describe('Label view — show/hide toggle', () => {
  it('hides the legends without deleting them, and brings them back', () => {
    const { container } = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    expect(labelsAtPos(container, '0,0')).toContain('Bulldoze')

    // Hide: the key falls back to its keycode legend...
    fireEvent.click(screen.getByTestId('key-notes-visible-toggle'))
    const hidden = labelsAtPos(container, '0,0')
    expect(hidden).not.toContain('Bulldoze')
    expect(hidden).toContain('A')
    // ...but the label itself still exists — the panel's list proves it wasn't
    // deleted, which is the whole distinction between hiding and clearing.
    expect(screen.getByTestId('key-notes-list').textContent).toContain('Bulldoze')

    // Show again.
    fireEvent.click(screen.getByTestId('key-notes-visible-toggle'))
    expect(labelsAtPos(container, '0,0')).toContain('Bulldoze')
  })

  it('reports the state on the button so it reads as a switch', () => {
    const { container } = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    const btn = screen.getByTestId('key-notes-visible-toggle')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn.textContent).toContain('Shown')
    fireEvent.click(btn)
    expect(screen.getByTestId('key-notes-visible-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('key-notes-visible-toggle').textContent).toContain('Hidden')
  })

  it('offers a toolbar toggle only once a label exists', () => {
    const { container, unmount } = render(<KeymapEditor {...baseProps()} />)
    // Nothing labelled yet: a visibility toggle would appear to do nothing.
    expect(screen.queryByTestId('labels-visible-button')).not.toBeInTheDocument()
    openLabelEditorAndType(container, '0,0', 'Bulldoze')
    expect(screen.getByTestId('labels-visible-button')).toBeInTheDocument()
    unmount()
  })

  it('toolbar toggle hides labels without opening the editor panel', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    first.unmount()

    // Fresh mount: panel closed, label present from storage.
    const { container } = render(<KeymapEditor {...baseProps()} />)
    expect(screen.queryByTestId('key-notes-panel')).not.toBeInTheDocument()
    expect(labelsAtPos(container, '0,0')).toContain('Bulldoze')

    fireEvent.click(screen.getByTestId('labels-visible-button'))
    expect(labelsAtPos(container, '0,0')).not.toContain('Bulldoze')
    // Still no panel — hiding is a display action, not an editing one.
    expect(screen.queryByTestId('key-notes-panel')).not.toBeInTheDocument()
  })

  it('persists the hidden state across a remount', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    fireEvent.click(screen.getByTestId('key-notes-visible-toggle'))
    first.unmount()

    const second = render(<KeymapEditor {...baseProps()} />)
    expect(labelsAtPos(second.container, '0,0')).not.toContain('Bulldoze')
  })

  it('hides them in the typing view and the overlay too', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    fireEvent.click(screen.getByTestId('key-notes-visible-toggle'))
    first.unmount()

    const typing = render(<KeymapEditor {...baseProps()} typingTestMode />)
    expect(labelsAtPos(typing.container, '0,0')).not.toContain('Bulldoze')
    typing.unmount()

    const overlay = render(<KeymapEditor {...baseProps()} typingTestMode typingTestViewOnly />)
    expect(labelsAtPos(overlay.container, '0,0')).not.toContain('Bulldoze')
  })

  it('is reachable from the floating overlay, whose toolbar is hidden', () => {
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    first.unmount()

    // View-only mode renders no toolbar, so without its own control the
    // overlay — the surface where labels matter MOST — would have no way to
    // turn them off.
    const overlay = render(<KeymapEditor {...baseProps()} typingTestMode typingTestViewOnly />)
    expect(screen.queryByTestId('label-view-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('labels-visible-button')).not.toBeInTheDocument()
    expect(labelsAtPos(overlay.container, '0,0')).toContain('Bulldoze')

    fireEvent.click(screen.getByTestId('labels-visible-toggle-overlay'))
    expect(labelsAtPos(overlay.container, '0,0')).not.toContain('Bulldoze')
    fireEvent.click(screen.getByTestId('labels-visible-toggle-overlay'))
    expect(labelsAtPos(overlay.container, '0,0')).toContain('Bulldoze')
  })

  it('omits the overlay toggle when there are no labels', () => {
    render(<KeymapEditor {...baseProps()} typingTestMode typingTestViewOnly />)
    expect(screen.queryByTestId('labels-visible-toggle-overlay')).not.toBeInTheDocument()
  })

  it('is scoped per keyboard — hiding on one leaves another shown', () => {

    // Label both keyboards, then hide only the first.
    const first = render(<KeymapEditor {...baseProps()} />)
    openLabelEditorAndType(first.container, '0,0', 'Bulldoze')
    fireEvent.click(screen.getByTestId('key-notes-visible-toggle'))
    first.unmount()

    const other = render(<KeymapEditor {...baseProps()} keyboardUid="OTHERUID" />)
    openLabelEditorAndType(other.container, '0,0', 'Develop')
    expect(labelsAtPos(other.container, '0,0')).toContain('Develop')
  })
})

describe('Label view — store helpers', () => {

  it('wraps long legends into KeyWidget’s multi-part slots (max 4)', () => {
    expect(formatLegend('Bulldoze')).toBe('Bulldoze')
    expect(formatLegend('Terrain Bulldozer')).toBe('Terrain\nBulldozer')
    expect(formatLegend('Terrain Bulldozer').split('\n').length).toBeLessThanOrEqual(4)
    // Unbreakable word: passed through rather than mangled mid-word.
    expect(formatLegend('Bulldozerrrrrrr')).toBe('Bulldozerrrrrrr')
  })

  it('ignores malformed positions and blank legends rather than throwing', () => {
    const built = buildKeyNoteOverrides({
      '0': {
        '0,0': { legend: 'Ok' },
        'not,a,pos': { legend: 'Bad' },
        '9,9': { legend: '' },
      },
    }, 0)
    expect([...(built?.keys() ?? [])]).toEqual(['0,0'])
  })

  it('returns undefined (not an empty Map) when a layer has no notes', () => {
    expect(buildKeyNoteOverrides({}, 0)).toBeUndefined()
    expect(buildKeyNoteOverrides({ '1': { '0,0': { legend: 'X' } } }, 0)).toBeUndefined()
  })

  it('lets the base map win on collisions (View Matrix keeps its R/C legends)', () => {
    const base = new Map([['0,0', { outer: 'R 0\nC 0', inner: '', masked: false }]])
    const notes = new Map([
      ['0,0', { outer: 'Bulldoze', inner: '', masked: false }],
      ['0,1', { outer: 'Picker', inner: '', masked: false }],
    ])
    const merged = mergeLabelOverrides(base, notes)
    expect(merged?.get('0,0')?.outer).toBe('R 0\nC 0')
    expect(merged?.get('0,1')?.outer).toBe('Picker')
  })
})
