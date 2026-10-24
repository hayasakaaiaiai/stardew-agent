[CmdletBinding()]
param(
    [string]$GamePath = 'E:\games\steamapps\common\Stardew Valley',
    [ValidateSet('all','live','edges')][string]$Section = 'all'
)
$ErrorActionPreference = 'Stop'
$taskSection = @{ all='real-meetings'; live='real-meetings-live'; edges='real-meetings-edges' }[$Section]
& (Join-Path $PSScriptRoot 'test-game-world.ps1') -GamePath $GamePath -Section $taskSection -Offline:($Section -eq 'edges')
