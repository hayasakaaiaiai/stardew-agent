[CmdletBinding()]
param(
    [string]$GamePath='E:\games\steamapps\common\Stardew Valley',
    [switch]$Offline,
    [ValidateSet('all','schedules','backstage','festivals','content','fair-return','actions','actions-edge','actions-timing','actions-checks','actions-places','actions-incoming','farm-help','farm-chores','farm-visits','farm-save','mine','mine-core','mine-rescue','mine-edges','mine-worlds','mine-dungeons','mine-save','same-day','same-day-core','same-day-edges','call-off','call-off-arrival','call-off-arrival-save')][string]$Section='all'
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    & (Join-Path $PSScriptRoot 'test-game-memory.ps1') -GamePath $GamePath -World -Section $Section -Offline:$Offline
} finally { Pop-Location }
