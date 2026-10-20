[CmdletBinding()]
param(
    [string]$GamePath = 'E:\games\steamapps\common\Stardew Valley',
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (Get-Process -Name StardewModdingAPI,'Stardew Valley' -ErrorAction SilentlyContinue) { throw '请先正常退出游戏；组合验收只加载独立副本。' }
$taskRun = Join-Path $taskRoot ('.runtime\social-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskRun -ErrorAction Stop | Out-Null
$taskSteps = @()
$taskSuccess = $false
$taskFailure = $null
function Invoke-SocialCheck([string]$Name, [scriptblock]$Command) {
    Write-Output ('正在检查：' + $Name)
    $taskLog = Join-Path $taskRun ($Name + '.log')
    $taskPreviousErrors = $ErrorActionPreference
    try {
        # Windows PowerShell 5 wraps stderr warnings as NativeCommandError when redirecting them.
        $ErrorActionPreference = 'Continue'
        & $Command *> $taskLog
        $taskCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskPreviousErrors }
    Get-Content -LiteralPath $taskLog -Tail 12
    $script:taskSteps += [pscustomobject]@{ Name=$Name; ExitCode=$taskCode; Log=$taskLog }
    if ($taskCode -ne 0) { throw ($Name + ' 未通过，见 ' + $taskLog) }
}
Push-Location $taskRoot
try {
    Invoke-SocialCheck 'npm-test' { & npm.cmd test }
    Invoke-SocialCheck 'typecheck' { & npm.cmd run typecheck }
    Invoke-SocialCheck 'build' { & npm.cmd run build }
    Invoke-SocialCheck 'mod-build' { & dotnet build mod/StardewAgentBridge -c Release ('-p:GamePath=' + $GamePath) -p:EnableModDeploy=false --nologo }
    Invoke-SocialCheck 'mod-flow' { & dotnet run --project tests/mod-flow -- (Join-Path $taskRoot 'mod\StardewAgentBridge\bin\Release\net6.0\StardewAgentBridge.dll') $GamePath }
    & (Join-Path $PSScriptRoot 'test-game-memory.ps1') -GamePath $GamePath -Social -Offline:$Offline -RunDirectory (Join-Path $taskRun 'game')
    $taskSuccess = $true
} catch { $taskFailure = $_.Exception.Message; Write-Warning $taskFailure }
finally {
    Pop-Location
    $taskNative = Join-Path $taskRun 'game\result.json'
    $taskReport = if (Test-Path -LiteralPath $taskNative) { Get-Content -LiteralPath $taskNative -Encoding UTF8 -Raw | ConvertFrom-Json } else { $null }
    [pscustomobject]@{ Success=$taskSuccess; Failure=$taskFailure; Offline=[bool]$Offline; Steps=$taskSteps; Native=$taskReport; Directory=$taskRun } |
        ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $taskRun 'result.json') -Encoding UTF8
    Write-Output ('统一报告：' + (Join-Path $taskRun 'result.json'))
}
if (-not $taskSuccess) { throw ('组合验收未通过：' + $taskFailure) }
