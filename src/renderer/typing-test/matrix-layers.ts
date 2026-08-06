// SPDX-License-Identifier: GPL-2.0-or-later

/** Matrix key (row/col) resolution against active layers: parsing matrix
 *  key strings, extracting layer-switch targets, resolving the effective
 *  keycode for a pressed matrix position, and diffing two frames' pressed
 *  sets into an ordered list of press/release edges. */

import { extractMOLayer, extractLTLayer, extractLMLayer } from './keycode-char-map'
import { getProtocolValue } from '../../shared/keycodes/keycodes'



/** Press-edge record kept until the press resolves — by its matching
 * release edge, or by the deferred-emit deadline if it is still held
 * when that fires — so masked keys can classify the press as tap vs
 * hold. Non-masked keys are emitted immediately on press and never land
 * in this record. */
export interface PressStartRecord {
  tsMs: number
  row: number
  col: number
  layer: number
  keycode: number
  /** Overlap / pollGapMs determined at press time (see
   * matrix-press-duration.ts) — carried through to whatever event this
   * press eventually resolves into (tap or hold), so a masked key's
   * deferred classification doesn't lose the fields a non-masked press
   * gets immediately. */
  overlap?: boolean
  pollGapMs?: number
}

/** Parse a "row,col" matrix key string into numeric row and col. */
export function parseMatrixKey(key: string): [number, number] {
  const [r, c] = key.split(',')
  return [Number(r), Number(c)]
}

/** Extract the target layer from a MOMENTARY layer switch keycode (MO, LT,
 * or LM) — one that is only active while the key is physically held.
 *
 * Deliberately does NOT cover the sticky ops (TG/TO/DF/PDF/TT): those
 * survive the key's release, so they can't be modelled by the
 * press/release latch this feeds. See {@link classifyLayerAction}. */
export function extractSwitchLayer(code: number): number | null {
  return extractMOLayer(code) ?? extractLTLayer(code) ?? extractLMLayer(code)
}

/** What a pressed key does to the layer state.
 *
 * - `momentary` — active only while held (MO / LT / LM). Handled by the
 *   press/release latch.
 * - `toggle` — TG(n): flips layer n on or off, and STAYS after release.
 * - `to` — TO(n): switches to layer n, turning every other toggle off.
 * - `default` — DF(n) / PDF(n): changes the base (default) layer itself.
 * - `tapToggle` — TT(n): momentary on a single press, but toggles after
 *   N rapid taps. Treated as `toggle` here, since the momentary arm is
 *   already covered by the latch and the sticky arm is the one the layer
 *   indicator otherwise misses entirely.
 * - `null` — not a layer op. */
export type LayerActionKind = 'momentary' | 'toggle' | 'to' | 'default' | 'tapToggle'

export interface LayerAction {
  kind: LayerActionKind
  layer: number
}

/** Sticky layer-op encodings, per VIA protocol version.
 *
 * These MUST be matched numerically rather than by `serialize()`: that
 * helper falls back to a raw hex string (`"0x5302"`) for any code the
 * current keyboard hasn't registered, so an id-pattern match silently
 * misses exactly the boards whose layer count doesn't cover the op — the
 * opposite of robust. The values mirror `keycodes-v5.ts` / `keycodes-v6.ts`
 * (the same tables the editor builds its own keycode list from):
 *
 *  op   | v5 encoding   | v6 encoding
 *  -----|---------------|-------------
 *  TO   | 0x5010 | n    | 0x5210 | n     <-- both carry ON_PRESS (1 << 4)
 *  MO   | 0x5100 | n    | 0x5220 | n
 *  DF   | 0x5200 | n    | 0x5240 | n
 *  TG   | 0x5300 | n    | 0x5260 | n
 *  OSL  | 0x5400 | n    | 0x5280 | n
 *  TT   | 0x5800 | n    | 0x52c0 | n
 *  PDF  | (n/a on v5)   | 0x52e0 | n
 *
 * v5 gives each op a full 0x100 block (8-bit layer field, though only 5
 * bits are ever used); v6 packs them into 0x20-wide blocks (5-bit layer
 * field). `TO(n)` is the odd one on BOTH versions: its ON_PRESS bit
 * (`1 << 4`) sits inside what would otherwise be the layer field, so its
 * layer is read from the low nibble and it must be tested before the
 * neighbouring blocks. (Verified empirically — v6 `TO(3)` is `0x5213`, not
 * `0x5203`; reading 5 bits there would have yielded layer 19.) */

interface StickyOpSpec {
  base: number
  mask: number
  layerMask: number
  kind: LayerActionKind
}

const STICKY_OPS_V5: StickyOpSpec[] = [
  // Checked before the other 0x5x00 blocks: TO's ON_PRESS bit makes its
  // encoding 0x5010|n, which would otherwise look like a plain 0x5000 block.
  { base: 0x5010, mask: 0xfff0, layerMask: 0x0f, kind: 'to' },
  { base: 0x5200, mask: 0xff00, layerMask: 0xff, kind: 'default' },
  { base: 0x5300, mask: 0xff00, layerMask: 0xff, kind: 'toggle' },
  { base: 0x5800, mask: 0xff00, layerMask: 0xff, kind: 'tapToggle' },
]

const STICKY_OPS_V6: StickyOpSpec[] = [
  // TO first, and read from the low nibble — see the ON_PRESS note above.
  { base: 0x5210, mask: 0xfff0, layerMask: 0x0f, kind: 'to' },

  { base: 0x5240, mask: 0xffe0, layerMask: 0x1f, kind: 'default' },
  { base: 0x5260, mask: 0xffe0, layerMask: 0x1f, kind: 'toggle' },
  { base: 0x52c0, mask: 0xffe0, layerMask: 0x1f, kind: 'tapToggle' },
  { base: 0x52e0, mask: 0xffe0, layerMask: 0x1f, kind: 'default' }, // PDF
]

/** Classify a keycode's effect on the layer state — the momentary ops via
 * the existing extractors, the sticky ops via the tables above. Returns
 * `null` for anything that isn't a layer op. */
export function classifyLayerAction(code: number): LayerAction | null {
  const momentary = extractSwitchLayer(code)
  if (momentary != null) return { kind: 'momentary', layer: momentary }

  // v6 is the current default; anything below 6 uses the v5 layout. Read
  // live (not captured) because the protocol is set per connected device.
  const specs = getProtocolValue() >= 6 ? STICKY_OPS_V6 : STICKY_OPS_V5
  for (const spec of specs) {
    if ((code & spec.mask) !== spec.base) continue
    const layer = code & spec.layerMask
    return { kind: spec.kind, layer }
  }
  return null
}



/** Resolve the effective keycode AND the layer the keycode was picked
 * from. Used by the analytics path so each event is attributed to the
 * layer where the key is actually defined, not the (possibly different)
 * layer the pressed key itself is activating. For example, a lone LT1
 * press at base 0 resolves to LT1(kc) from layer 0 even though it
 * activates layer 1, so the heatmap shows the press on the base-layer
 * view the user is looking at. */
export function resolveEffectiveCodeWithLayer(
  row: number,
  col: number,
  keymap: Map<string, number>,
  sortedLayers: number[],
  baseLayer: number,
): { code: number; layer: number } | undefined {
  for (const layer of sortedLayers) {
    const code = keymap.get(`${layer},${row},${col}`)
    if (code != null && code !== 0x01) return { code, layer }
  }
  const baseCode = keymap.get(`${baseLayer},${row},${col}`)
  return baseCode != null ? { code: baseCode, layer: baseLayer } : undefined
}

/** One press or release edge between two frames' pressed sets, in
 * row-major walk order (see {@link matrixFrameEdges}). */
export interface MatrixEdge {
  key: string
  row: number
  col: number
  isPress: boolean
}

/** Diff `prev` and `pressed` into the keys whose held-status changed —
 * a key present in both is not an edge and is skipped. Edges are
 * returned in row-major order (ascending row, then col) rather than Set
 * iteration order, which has no ordering guarantee: a caller resolving
 * each edge against state mutated by the edges before it (as
 * processMatrixFrame does for its layer latch) needs that order to be
 * deterministic, not incidental to Set internals. Built from two direct
 * scans of `prev` and `pressed` rather than a unioned copy, so an idle
 * frame (nothing changed) does no allocation beyond the empty result. */
export function matrixFrameEdges(prev: ReadonlySet<string>, pressed: ReadonlySet<string>): MatrixEdge[] {
  const edges: MatrixEdge[] = []
  for (const key of prev) {
    if (!pressed.has(key)) {
      const [row, col] = parseMatrixKey(key)
      edges.push({ key, row, col, isPress: false })
    }
  }
  for (const key of pressed) {
    if (!prev.has(key)) {
      const [row, col] = parseMatrixKey(key)
      edges.push({ key, row, col, isPress: true })
    }
  }
  return edges.sort((a, b) => a.row - b.row || a.col - b.col)
}
