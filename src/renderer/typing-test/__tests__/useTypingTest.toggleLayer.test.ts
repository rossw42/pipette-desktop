// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// End-to-end cover for the reported bug: "a macropad with 2 work layers plus a
// TG(2) key for gaming mode — the typing view never showed the toggled layer,
// so the keys on it couldn't be seen."
//
// Goes through the real `useTypingTest` hook (not the latch in isolation) so
// the whole path is exercised: matrix frame -> edge walk -> layer
// classification -> `effectiveLayer`, which is what the typing view renders
// its keymap from. Companion to matrix-layer-latch-toggle.test.ts, which
// covers the units.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingTest } from '../useTypingTest'
import { deserialize } from '../../../shared/keycodes/keycodes'

function buildKeymap(layers: Array<{ layer: number; entries: Array<[number, number, string]> }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const { layer, entries } of layers) {
    for (const [row, col, qmkId] of entries) m.set(`${layer},${row},${col}`, deserialize(qmkId))
  }
  return m
}

const press = (keys: string[]) => new Set(keys)

// The reported layout: layers 0 and 1 for work, layer 2 for gaming.
// (0,0) = TG(2) gaming toggle. (0,1) = MO(1) momentary work layer.
// (1,0) carries a different letter per layer so resolution is observable.
const KEYMAP = buildKeymap([
  { layer: 0, entries: [[0, 0, 'TG(2)'], [0, 1, 'MO(1)'], [1, 0, 'KC_A']] },
  { layer: 1, entries: [[0, 0, 'TG(2)'], [0, 1, 'MO(1)'], [1, 0, 'KC_B']] },
  { layer: 2, entries: [[0, 0, 'TG(2)'], [0, 1, 'MO(1)'], [1, 0, 'KC_C']] },
])

// (0,0) = TO(2) then TO(0) — the other common "enter/leave gaming mode" idiom.
const TO_KEYMAP = buildKeymap([
  { layer: 0, entries: [[0, 0, 'TO(2)'], [1, 0, 'KC_A']] },
  { layer: 2, entries: [[0, 0, 'TO(0)'], [1, 0, 'KC_C']] },
])

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
})

describe('useTypingTest — TG/TO layer toggles reach effectiveLayer', () => {
  it('TG(2) switches the view to layer 2 and KEEPS it after release', () => {
    const { result } = renderHook(() => useTypingTest())
    expect(result.current.effectiveLayer).toBe(0)

    // Press the gaming-mode key...
    act(() => result.current.processMatrixFrame(press(['0,0']), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)

    // ...and release it. THIS is the regression: the view used to snap back to
    // layer 0 here (in fact it never left 0 at all), hiding the gaming keys.
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)
  })

  it('pressing TG(2) again returns to the base layer', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processMatrixFrame(press(['0,0']), KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)

    act(() => result.current.processMatrixFrame(press(['0,0']), KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(0)
  })

  it('a momentary layer key still works while the toggle is on', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processMatrixFrame(press(['0,0']), KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)

    // MO(1) held: 2 is still the highest active layer, so the view stays there
    // (QMK's highest-active-layer walk), and releasing MO must not clear the
    // toggle.
    act(() => result.current.processMatrixFrame(press(['0,1']), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)
  })

  it('TO(2) enters the layer and TO(0) leaves it', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processMatrixFrame(press(['0,0']), TO_KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), TO_KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)

    // The SAME physical key now resolves to TO(0) from layer 2 — which is the
    // point of resolving presses against the toggled layer, not just the base.
    act(() => result.current.processMatrixFrame(press(['0,0']), TO_KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), TO_KEYMAP))
    expect(result.current.effectiveLayer).toBe(0)
  })

  it('an ordinary key press does not disturb the toggled layer', () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processMatrixFrame(press(['0,0']), KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    // Typing on the gaming layer must keep showing the gaming layer.
    act(() => result.current.processMatrixFrame(press(['1,0']), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)
  })

  it('resetMatrixPressTracking returns to base (device/keymap change)', async () => {
    const { result } = renderHook(() => useTypingTest())
    act(() => result.current.processMatrixFrame(press(['0,0']), KEYMAP))
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(2)

    await act(async () => { await result.current.resetMatrixPressTracking() })
    // The indicator only re-derives on the next frame, so pump one.
    act(() => result.current.processMatrixFrame(press([]), KEYMAP))
    expect(result.current.effectiveLayer).toBe(0)
  })
})
