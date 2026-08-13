# SPDX-License-Identifier: GPL-2.0-or-later
#
# Diagnostic: does launching the freshly-built dist\win-unpacked\Pipette.exe
# actually get a window when the OLD INSTALLED Pipette
# (%LOCALAPPDATA%\Programs\Pipette) is already running?
#
# Both builds share appId "app.pipette.desktop" and the same userData dir, so
# src/main/index.ts's app.requestSingleInstanceLock() makes the second launch
# `app.exit(0)` SILENTLY. The user then keeps looking at the OLD window.

$out = "d:\GitHub\rossw42\pipette-desktop\single-instance-report.txt"
$installed = "$env:LOCALAPPDATA\Programs\Pipette\Pipette.exe"
$fresh = "d:\GitHub\rossw42\pipette-desktop\dist\win-unpacked\Pipette.exe"

function Snap($label) {
    $procs = Get-Process Pipette -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        Group-Object Path |
        ForEach-Object { "    $($_.Count) x $($_.Name)" }
    if (-not $procs) { $procs = "    (none)" }
    @("[$label]") + $procs
}

$lines = @()
Get-Process Pipette -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 3
$lines += Snap "baseline (all killed)"

Start-Process $installed
Start-Sleep 10
$lines += Snap "after launching OLD INSTALLED build"

Start-Process $fresh
Start-Sleep 10
$lines += Snap "after ALSO launching FRESH dist build"

Get-Process Pipette -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 3

Start-Process $fresh
Start-Sleep 10
$lines += Snap "fresh dist build alone (old one killed first)"

Get-Process Pipette -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$lines | Set-Content -Path $out -Encoding utf8
