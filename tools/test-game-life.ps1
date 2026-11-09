[CmdletBinding()]
param(
    [string]$GamePath = 'E:\games\steamapps\common\Stardew Valley',
    [ValidateSet('all','goals','activities','family','social','save','edges')][string]$Section = 'all'
)
$ErrorActionPreference = 'Stop'
$taskSection = if ($Section -eq 'all') { 'life' } else { 'life-' + $Section }
& (Join-Path $PSScriptRoot 'test-game-world.ps1') -GamePath $GamePath -Section $taskSection -Offline
