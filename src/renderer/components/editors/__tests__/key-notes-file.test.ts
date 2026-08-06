// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Saving key labels to a file and loading them back.
//
// The pure serialize/parse/merge functions are tested directly; the hook's
// `saveToFile`/`loadFromFile` are tested through `renderHook` against a mocked
// `window.vialAPI`, because the interesting behaviour is the glue: what happens
// on cancel, on a wrong-format file, on partially-corrupt input, and whether a
// load actually lands in the store.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import {
  serializeKeyNotes,
  parseKeyNotesFile,
  mergeKeyNotes,
  countKeyNotes,
  useKeyNotes,
  readKeyNotes,
  writeKeyNotes,
  resetKeyNotesCache,
  KEY_NOTES_FILE_KIND,
  KEY_NOTES_FILE_VERSION,
  type KeyNotesByLayer,
} from '../key-notes-store'

const UID = 'test-keyboard-uid'

const SAMPLE: KeyNotesByLayer = {
  '0': { '0,0': { legend: 'Bulldoze' }, '1,2': { legend: 'Guard Tower', desc: 'builds a tower' } },
  '1': { '0,0': { legend: 'Zoom In' } },
}

/** Minimal `window.vialAPI` — only the two methods this feature touches. */
function mockApi(overrides: Partial<{
  exportJson: ReturnType<typeof vi.fn>
  sideloadJson: ReturnType<typeof vi.fn>
}> = {}) {
  const exportJson = overrides.exportJson ?? vi.fn().mockResolvedValue({ success: true, filePath: '/tmp/labels.json' })
  const sideloadJson = overrides.sideloadJson ?? vi.fn().mockResolvedValue({ success: true, data: {} })
  ;(window as unknown as { vialAPI: unknown }).vialAPI = { exportJson, sideloadJson }
  return { exportJson, sideloadJson }
}

beforeEach(() => {
  resetKeyNotesCache()
})

afterEach(() => {
  delete (window as unknown as { vialAPI?: unknown }).vialAPI
  vi.restoreAllMocks()
})

describe('serializeKeyNotes', () => {
  it('writes a self-identifying envelope around the notes', () => {
    const parsed = JSON.parse(serializeKeyNotes(SAMPLE, UID)) as Record<string, unknown>
    expect(parsed.kind).toBe(KEY_NOTES_FILE_KIND)
    expect(parsed.version).toBe(KEY_NOTES_FILE_VERSION)
    expect(parsed.keyboard).toBe(UID)
    expect(parsed.notes).toEqual(SAMPLE)
    expect(typeof parsed.exportedAt).toBe('string')
  })

  it('omits `keyboard` when there is no uid, rather than writing an empty string', () => {
    const parsed = JSON.parse(serializeKeyNotes(SAMPLE)) as Record<string, unknown>
    expect('keyboard' in parsed).toBe(false)
  })

  it('round trips through parse without loss', () => {
    const parsed = parseKeyNotesFile(JSON.parse(serializeKeyNotes(SAMPLE, UID)))
    expect(typeof parsed).not.toBe('string')
    if (typeof parsed === 'string') return
    expect(parsed.notes).toEqual(SAMPLE)
    expect(parsed.keyboard).toBe(UID)
    expect(parsed.skipped).toBe(0)
  })

  it('preserves `desc`, not just the legend', () => {
    const parsed = parseKeyNotesFile(JSON.parse(serializeKeyNotes(SAMPLE, UID)))
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.notes['0']['1,2'].desc).toBe('builds a tower')
  })
})

describe('parseKeyNotesFile — rejection', () => {
  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', [1, 2, 3]],
    ['a number', 42],
  ])('rejects %s', (_label, input) => {
    expect(typeof parseKeyNotesFile(input)).toBe('string')
  })

  it("rejects JSON that isn't a labels file — e.g. a .vil keymap", () => {
    const result = parseKeyNotesFile({ version: 1, uid: '0x1234', layout: {} })
    expect(typeof result).toBe('string')
    expect(result).toContain('Not a Pipette labels file')
  })

  it('rejects a file from a future version rather than guessing at its shape', () => {
    const result = parseKeyNotesFile({
      kind: KEY_NOTES_FILE_KIND,
      version: KEY_NOTES_FILE_VERSION + 1,
      notes: SAMPLE,
    })
    expect(typeof result).toBe('string')
    expect(result).toContain('newer than this build')
  })

  it('accepts an older version (forward compatibility for readers)', () => {
    const result = parseKeyNotesFile({ kind: KEY_NOTES_FILE_KIND, version: 0, notes: SAMPLE })
    expect(typeof result).not.toBe('string')
  })

  it('rejects a missing/invalid notes object', () => {
    expect(typeof parseKeyNotesFile({ kind: KEY_NOTES_FILE_KIND, version: 1 })).toBe('string')
    expect(typeof parseKeyNotesFile({ kind: KEY_NOTES_FILE_KIND, version: 1, notes: [] })).toBe('string')
  })
})

describe('parseKeyNotesFile — lenient inside notes', () => {
  it('keeps the good entries and counts the bad ones', () => {
    const result = parseKeyNotesFile({
      kind: KEY_NOTES_FILE_KIND,
      version: 1,
      notes: {
        '0': {
          '0,0': { legend: 'Keep' },
          'not-a-pos': { legend: 'Drop' },
          '1,1': { legend: '   ' },        // blank after trim
          '2,2': { legend: 42 },           // wrong type
          '3,3': null,                     // not an object
        },
        'notALayer': { '0,0': { legend: 'Drop' } },
      },
    })
    if (typeof result === 'string') throw new Error(result)
    expect(result.notes).toEqual({ '0': { '0,0': { legend: 'Keep' } } })
    expect(result.skipped).toBe(5)
  })

  it('trims legends on the way in', () => {
    const result = parseKeyNotesFile({
      kind: KEY_NOTES_FILE_KIND, version: 1,
      notes: { '0': { '0,0': { legend: '  Padded  ' } } },
    })
    if (typeof result === 'string') throw new Error(result)
    expect(result.notes['0']['0,0'].legend).toBe('Padded')
  })

  it('drops a layer that ends up empty rather than leaving `{}` behind', () => {
    const result = parseKeyNotesFile({
      kind: KEY_NOTES_FILE_KIND, version: 1,
      notes: { '0': { 'bad': { legend: 'x' } }, '1': { '0,0': { legend: 'Good' } } },
    })
    if (typeof result === 'string') throw new Error(result)
    expect(Object.keys(result.notes)).toEqual(['1'])
  })
})

describe('mergeKeyNotes', () => {
  it('keeps layers and keys the incoming set never mentions', () => {
    const merged = mergeKeyNotes(SAMPLE, { '0': { '5,5': { legend: 'New' } } })
    expect(merged['0']['0,0'].legend).toBe('Bulldoze')  // untouched
    expect(merged['0']['5,5'].legend).toBe('New')       // added
    expect(merged['1']['0,0'].legend).toBe('Zoom In')   // untouched layer
  })

  it('lets incoming win on a collision', () => {
    const merged = mergeKeyNotes(SAMPLE, { '0': { '0,0': { legend: 'Overwritten' } } })
    expect(merged['0']['0,0'].legend).toBe('Overwritten')
  })

  it('does not mutate either input', () => {
    const base = { '0': { '0,0': { legend: 'A' } } }
    const incoming = { '0': { '1,1': { legend: 'B' } } }
    mergeKeyNotes(base, incoming)
    expect(base).toEqual({ '0': { '0,0': { legend: 'A' } } })
    expect(incoming).toEqual({ '0': { '1,1': { legend: 'B' } } })
  })
})

describe('countKeyNotes', () => {
  it('counts across every layer', () => {
    expect(countKeyNotes(SAMPLE)).toBe(3)
    expect(countKeyNotes({})).toBe(0)
  })
})

describe('useKeyNotes().saveToFile', () => {
  it('sends the serialized notes to exportJson and reports the count', async () => {
    const { exportJson } = mockApi()
    writeKeyNotes(SAMPLE, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.saveToFile() })

    expect(exportJson).toHaveBeenCalledTimes(1)
    const [content, defaultName] = exportJson.mock.calls[0] as [string, string]
    expect(JSON.parse(content).notes).toEqual(SAMPLE)
    expect(defaultName).toContain(UID)
    expect(io.ok).toBe(true)
    expect(io.message).toContain('3 labels')
  })

  it('refuses to write an empty file, and says why', async () => {
    const { exportJson } = mockApi()
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.saveToFile() })

    expect(exportJson).not.toHaveBeenCalled()
    expect(io.ok).toBe(false)
    expect(io.message).toContain('Nothing to save')
  })

  it('stays silent when the user cancels the save dialog', async () => {
    mockApi({ exportJson: vi.fn().mockResolvedValue({ success: false, error: 'cancelled' }) })
    writeKeyNotes(SAMPLE, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.saveToFile() })

    // Empty message is the contract for "nothing to report".
    expect(io).toEqual({ ok: false, message: '' })
  })

  it('surfaces a real write failure', async () => {
    mockApi({ exportJson: vi.fn().mockResolvedValue({ success: false, error: 'EACCES' }) })
    writeKeyNotes(SAMPLE, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.saveToFile() })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('EACCES')
  })

  it('survives a rejected IPC call instead of throwing at the caller', async () => {
    mockApi({ exportJson: vi.fn().mockRejectedValue(new Error('ipc exploded')) })
    writeKeyNotes(SAMPLE, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.saveToFile() })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('ipc exploded')
  })

  it('reports gracefully when the bridge is absent (e.g. a stripped window)', async () => {
    writeKeyNotes(SAMPLE, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.saveToFile() })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('unavailable')
  })

  it('saves edits made after the last render (reads through the store)', async () => {
    const { exportJson } = mockApi()
    const { result } = renderHook(() => useKeyNotes(UID))
    // Simulate another surface (typing view / overlay) writing directly.
    writeKeyNotes({ '0': { '9,9': { legend: 'Late' } } }, UID)

    await act(async () => { await result.current.saveToFile() })

    const [content] = exportJson.mock.calls[0] as [string]
    expect(JSON.parse(content).notes).toEqual({ '0': { '9,9': { legend: 'Late' } } })
  })
})

describe('useKeyNotes().loadFromFile', () => {
  const fileData = { kind: KEY_NOTES_FILE_KIND, version: 1, notes: SAMPLE }

  it('merges into the store and reports the count', async () => {
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: true, data: fileData }) })
    writeKeyNotes({ '0': { '7,7': { legend: 'Existing' } } }, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile('merge') })

    expect(io.ok).toBe(true)
    expect(io.message).toContain('Merged in 3 labels')
    // Existing label survived; imported ones landed.
    const stored = readKeyNotes(UID)
    expect(stored['0']['7,7'].legend).toBe('Existing')
    expect(stored['0']['0,0'].legend).toBe('Bulldoze')
    expect(stored['1']['0,0'].legend).toBe('Zoom In')
  })

  it('merges by default when no mode is given', async () => {
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: true, data: fileData }) })
    writeKeyNotes({ '0': { '7,7': { legend: 'Existing' } } }, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    await act(async () => { await result.current.loadFromFile() })

    expect(readKeyNotes(UID)['0']['7,7']).toBeDefined()
  })

  it('replace mode drops labels the file does not mention', async () => {
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: true, data: fileData }) })
    writeKeyNotes({ '0': { '7,7': { legend: 'Existing' } } }, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile('replace') })

    expect(io.message).toContain('Replaced with 3 labels')
    expect(readKeyNotes(UID)['0']['7,7']).toBeUndefined()
    expect(readKeyNotes(UID)).toEqual(SAMPLE)
  })

  it('exposes the loaded labels through the hook state, not just storage', async () => {
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: true, data: fileData }) })
    const { result } = renderHook(() => useKeyNotes(UID))

    await act(async () => { await result.current.loadFromFile('replace') })

    expect(result.current.getLegend(0, 0, 0)).toBe('Bulldoze')
    expect(result.current.hasAnyNotes).toBe(true)
    // And it renders: the override map is what KeyWidget consumes.
    expect(result.current.overridesForLayer(0)?.get('0,0')?.outer).toBe('Bulldoze')
  })

  it('stays silent when the user cancels the open dialog', async () => {
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: false, error: 'cancelled' }) })
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile() })

    expect(io).toEqual({ ok: false, message: '' })
  })

  it('leaves existing labels untouched when the file is the wrong format', async () => {
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: true, data: { version: 1, uid: 'x' } }) })
    writeKeyNotes({ '0': { '7,7': { legend: 'Existing' } } }, UID)
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile('replace') })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('Not a Pipette labels file')
    // Crucially: a rejected import must not have wiped anything.
    expect(readKeyNotes(UID)).toEqual({ '0': { '7,7': { legend: 'Existing' } } })
  })

  it('reports skipped entries alongside the ones it kept', async () => {
    mockApi({
      sideloadJson: vi.fn().mockResolvedValue({
        success: true,
        data: {
          kind: KEY_NOTES_FILE_KIND, version: 1,
          notes: { '0': { '0,0': { legend: 'Good' }, 'bad': { legend: 'x' } } },
        },
      }),
    })
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile() })

    expect(io.ok).toBe(true)
    expect(io.message).toContain('1 label')
    expect(io.message).toContain('1 entry skipped')
  })

  it('rejects a well-formed file that contains no usable labels', async () => {
    mockApi({
      sideloadJson: vi.fn().mockResolvedValue({
        success: true,
        data: { kind: KEY_NOTES_FILE_KIND, version: 1, notes: {} },
      }),
    })
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile() })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('no usable labels')
  })

  it('survives a rejected IPC call', async () => {
    mockApi({ sideloadJson: vi.fn().mockRejectedValue(new Error('dialog exploded')) })
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile() })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('dialog exploded')
  })

  it('reports gracefully when the bridge is absent', async () => {
    const { result } = renderHook(() => useKeyNotes(UID))

    let io!: { ok: boolean; message: string }
    await act(async () => { io = await result.current.loadFromFile() })

    expect(io.ok).toBe(false)
    expect(io.message).toContain('unavailable')
  })
})

describe('save → load round trip through the hook', () => {
  it('restores exactly what was saved, onto a keyboard with no labels', async () => {
    // Save from keyboard A...
    const { exportJson } = mockApi()
    writeKeyNotes(SAMPLE, 'keyboard-a')
    const a = renderHook(() => useKeyNotes('keyboard-a'))
    await act(async () => { await a.result.current.saveToFile() })
    const [savedContent] = exportJson.mock.calls[0] as [string]

    // ...and load it onto keyboard B, which has none. The file crossing an
    // Electron IPC boundary arrives already JSON.parse'd (sideloadJson parses
    // it in the main process), so mirror that here.
    mockApi({ sideloadJson: vi.fn().mockResolvedValue({ success: true, data: JSON.parse(savedContent) }) })
    const b = renderHook(() => useKeyNotes('keyboard-b'))
    await act(async () => { await b.result.current.loadFromFile('replace') })

    expect(readKeyNotes('keyboard-b')).toEqual(SAMPLE)
  })
})
