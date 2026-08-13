// SPDX-License-Identifier: GPL-2.0-or-later
//
// Throwaway diagnostic: launch the PACKAGED app (dist/win-unpacked/Pipette.exe)
// and report whether the Key Notes UI (label editor + show/hide-labels toggle)
// is reachable in the running renderer.
//
// Runs TWO passes so the `hasLabels` gate is visible:
//   pass 1 — whatever labels the profile already has
//   pass 2 — with `pipette:key-notes:*` cleared (a first-time user)
// `KeymapToolbar` only renders the eye/show-hide button when the CURRENT
// keyboard has at least one label, so pass 2 is the state a user who has never
// authored a label actually sees.
//
// Usage: node scripts/probe-packaged-labels.mjs

import { _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

const EXE = resolve('dist/win-unpacked/Pipette.exe')
const lines = []
const say = (...a) => { const s = a.join(' '); lines.push(s); console.log(s) }

async function pass(label, { clearNotes }) {
  const app = await electron.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--disable-gpu-sandbox'],
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => say('[pageerror]', e.message))
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(6000)

    if (clearNotes) {
      // Wipe only the Key Notes keys, then reload so the store re-reads them.
      await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('pipette:key-notes')) localStorage.removeItem(k)
        }
      })
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(6000)
    }

    const report = await page.evaluate(() => {
      const seen = (sel) => {
        const el = document.querySelector(sel)
        return el ? (el.getAttribute('aria-label') ?? 'present') : null
      }
      return {
        labelEditorButton: seen('[data-testid="label-view-button"]'),
        showHideLabelsButton: seen('[data-testid="labels-visible-button"]'),
        keyNoteKeys: Object.keys(localStorage).filter((k) => k.startsWith('pipette:key-notes')),
      }
    })
    say(`\n=== ${label} ===`)
    say(JSON.stringify(report, null, 2))
  } catch (err) {
    say(`=== ${label} === PROBE ERROR: ${String(err)}`)
  }
  await app.close().catch(() => {})
}

await pass('pass 1: profile as-is', { clearNotes: false })
await pass('pass 2: no labels authored yet (key-notes cleared)', { clearNotes: true })

writeFileSync('probe-report.txt', lines.join('\n'))
