// SPDX-License-Identifier: GPL-2.0-or-later

// Sticky layer ops in the typing view. Regression cover for: a macropad
// with a `TG(2)` "gaming mode" key left the typing view stuck on the base
// layer, so the keys on the toggled layer were never visible. The latch
// only understood MOMENTARY switches (MO/LT/LM), whose whole model is
// "active while held" — a toggle survives its own release, so it needs
// separate state. See matrix-layer-latch.ts and matrix-layers.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { MatrixLayerLatch } from '../matrix-layer-latch'
import { classifyLayerAction, extractSwitchLayer } from '../matrix-layers'
import { setProtocol, recreateKeycodes, deserialize } from '../../../shared/keycodes/keycodes'

// Layer ops are protocol-dependent — v5 encodes `QK_TOGGLE_LAYER` at 0x5300
// while v6 uses 0x5260, and v5's TO(n) carries an extra ON_PRESS bit — and
// `classifyLayerAction` resolves through `serialize()`. So both versions are
// exercised, with the tables rebuilt for each, to prove the classifier is
// version-agnostic rather than accidentally matching one layout.
describe.each([5, 6] as const)('classifyLayerAction — VIA protocol v%i', (protocol) => {
  beforeEach(() => {
    setProtocol(protocol)
    recreateKeycodes()
  })

  /** Numeric code for a QMK id under the protocol currently set up. */
  const code = (qmkId: string): number => deserialize(qmkId)

  it('classifies momentary ops as momentary', () => {
    expect(classifyLayerAction(code('MO(1)'))).toEqual({ kind: 'momentary', layer: 1 })
  })

  it('classifies TG(n) as a toggle', () => {
    expect(classifyLayerAction(code('TG(2)'))).toEqual({ kind: 'toggle', layer: 2 })
  })

  it('classifies TO(n) as a move', () => {
    expect(classifyLayerAction(code('TO(3)'))).toEqual({ kind: 'to', layer: 3 })
  })

  it('classifies TT(n) as a tap-toggle', () => {
    expect(classifyLayerAction(code('TT(1)'))).toEqual({ kind: 'tapToggle', layer: 1 })
  })

  it('classifies DF(n) as a default-layer change', () => {
    expect(classifyLayerAction(code('DF(1)'))).toEqual({ kind: 'default', layer: 1 })
  })

  it('returns null for an ordinary key', () => {
    expect(classifyLayerAction(code('KC_A'))).toBeNull()
  })

  it('keeps extractSwitchLayer momentary-only (the sticky ops must NOT latch)', () => {
    // The bug: TG(2) fell through every momentary extractor and so latched
    // `null`, i.e. "not a layer key at all". Guarding it here keeps the two
    // concepts from being conflated again.
    expect(extractSwitchLayer(code('MO(1)'))).toBe(1)
    expect(extractSwitchLayer(code('TG(2)'))).toBeNull()
    expect(extractSwitchLayer(code('TO(3)'))).toBeNull()
  })
})


describe('MatrixLayerLatch — sticky toggles', () => {
  it('shows the toggled layer and KEEPS it after the key is released', () => {
    const latch = new MatrixLayerLatch()
    // Press TG(2): the press edge latches nothing momentary...
    latch.latch('2,1', null)
    latch.toggleLayer(2)
    expect(latch.displayLayer(0)).toBe(2)
    // ...and the release must NOT take the layer away — this is the whole
    // point of a toggle, and exactly what was broken.
    latch.release('2,1')
    expect(latch.displayLayer(0)).toBe(2)
  })

  it('toggles back off on a second press', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(2)
    expect(latch.displayLayer(0)).toBe(2)
    latch.toggleLayer(2)
    expect(latch.displayLayer(0)).toBe(0)
    expect(latch.hasToggles()).toBe(false)
  })

  it('resolves presses against the toggled layer', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(2)
    // Highest-first, and the base layer is still included as a fallback so a
    // position undefined on layer 2 falls through to it.
    expect(latch.activeLayers(0)).toEqual([2, 0])
  })

  it('stacks a momentary hold on top of a toggle', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(2)
    latch.latch('0,0', 3) // MO(3) held while gaming mode is on
    expect(latch.displayLayer(0)).toBe(3)
    expect(latch.activeLayers(0)).toEqual([3, 2, 0])
    // Releasing the momentary key drops back to the toggle, not to base.
    latch.release('0,0')
    expect(latch.displayLayer(0)).toBe(2)
  })

  it('TO(n) replaces the toggle state rather than stacking', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(1)
    latch.toggleLayer(3)
    expect(latch.displayLayer(0)).toBe(3)
    latch.moveToLayer(2)
    expect(latch.activeLayers(0)).toEqual([2, 0])
    expect(latch.displayLayer(0)).toBe(2)
  })

  it('TO(0) returns to base — the usual way out of a gaming layer', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(2)
    latch.moveToLayer(0)
    expect(latch.displayLayer(0)).toBe(0)
    expect(latch.hasToggles()).toBe(false)
  })

  it('a toggle below the base layer never drags the indicator down', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(1)
    // Base 3 (e.g. a DF'd default) outranks a toggle on 1.
    expect(latch.displayLayer(3)).toBe(3)
    // ...but layer 1 is still resolvable for keys defined there.
    expect(latch.activeLayers(3)).toEqual([3, 1])
  })

  it('clear() drops toggles too (device/keymap change starts from base)', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(2)
    latch.clear()
    expect(latch.displayLayer(0)).toBe(0)
    expect(latch.hasToggles()).toBe(false)
  })

  it('tracks several independent toggles at once', () => {
    const latch = new MatrixLayerLatch()
    latch.toggleLayer(1)
    latch.toggleLayer(2)
    expect(latch.activeLayers(0)).toEqual([2, 1, 0])
    // Turning the higher one off falls back to the lower, not to base.
    latch.toggleLayer(2)
    expect(latch.displayLayer(0)).toBe(1)
  })
})
