[CmdletBinding()]
param(
    [string]$GamePath = 'E:\games\steamapps\common\Stardew Valley',
    [switch]$PrepareOnly,
    [switch]$Manual
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRuntime = Join-Path $taskRoot '.runtime'
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
Start-Transcript -Path (Join-Path $taskRuntime 'abigail-test-launcher.log') -Append | Out-Null
try {
    if (Get-Process -Name StardewModdingAPI,'Stardew Valley' -ErrorAction SilentlyContinue) {
        throw '请先正常退出当前游戏，再运行阿比盖尔自动测试。脚本会从主菜单自动加载测试存档。'
    }
    $taskSaveFolder = Join-Path $env:APPDATA 'StardewValley\Saves\测试_436774213'
    if (-not (Test-Path -LiteralPath (Join-Path $taskSaveFolder 'SaveGameInfo'))) {
        throw '找不到指定的“测试”存档：测试_436774213。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.env'))) {
        throw '请先配置项目根目录下的 .env。'
    }
    $taskGameExe = Join-Path $GamePath 'StardewModdingAPI.exe'
    if (-not (Test-Path -LiteralPath $taskGameExe)) {
        throw '指定游戏目录里没有 StardewModdingAPI.exe。'
    }
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\ws\package.json'))) {
        throw '请先在项目根目录执行 npm ci 安装依赖。'
    }

    Write-Output '正在编译测试 Mod...'
    $taskProject = Join-Path $taskRoot 'mod\StardewAgentBridge\StardewAgentBridge.csproj'
    & dotnet build $taskProject --configuration Release ('-p:GamePath=' + $GamePath) -p:EnableModDeploy=false --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Mod 编译失败。' }
    if (Get-Process -Name StardewModdingAPI,'Stardew Valley' -ErrorAction SilentlyContinue) {
        throw '编译期间游戏已启动，请先正常退出后重试。'
    }
    $taskBuiltDll = Join-Path $taskRoot 'mod\StardewAgentBridge\bin\Release\net6.0\StardewAgentBridge.dll'
    $taskModDirectory = Join-Path $GamePath 'Mods\StardewAgentBridge'
    New-Item -ItemType Directory -Path $taskModDirectory -Force | Out-Null
    $taskInstalledDll = Join-Path $taskModDirectory 'StardewAgentBridge.dll'
    $taskHash = (Get-FileHash -LiteralPath $taskBuiltDll -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $taskInstalledDll) {
        $taskOldHash = (Get-FileHash -LiteralPath $taskInstalledDll -Algorithm SHA256).Hash
        if ($taskOldHash -ne $taskHash) {
            $taskBackup = Join-Path $taskRuntime 'mod-install-backups'
            New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
            Copy-Item -LiteralPath $taskInstalledDll -Destination (Join-Path $taskBackup ('StardewAgentBridge-' + $taskOldHash + '.dll')) -Force
        }
    }
    Copy-Item -LiteralPath $taskBuiltDll -Destination $taskInstalledDll -Force
    Copy-Item -LiteralPath (Join-Path $taskRoot 'mod\StardewAgentBridge\manifest.json') -Destination (Join-Path $taskModDirectory 'manifest.json') -Force
    if ((Get-FileHash -LiteralPath $taskInstalledDll -Algorithm SHA256).Hash -ne $taskHash) {
        throw '安装后的 Mod 与编译结果不一致。'
    }
    # Keep the ordinary local launcher from restoring an older pending build.
    $taskPendingDirectory = Join-Path $taskRuntime 'pending-mod'
    New-Item -ItemType Directory -Path $taskPendingDirectory -Force | Out-Null
    Copy-Item -LiteralPath $taskBuiltDll -Destination (Join-Path $taskPendingDirectory 'StardewAgentBridge.dll') -Force
    [pscustomobject]@{ Sha256=$taskHash; Fix='M3b save memory, menu lifecycle fix and opt-in Abigail test' } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskPendingDirectory 'install.json') -Encoding UTF8
    if ($PrepareOnly) { return }

    $taskBridge = Join-Path $taskRoot 'tools\bridge.ts'
    $taskListener = Get-NetTCPConnection -State Listen -LocalPort 47711 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskListener) {
        $taskOwner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskListener.OwningProcess)
        if ($taskOwner.Name -ne 'node.exe' -or $taskOwner.CommandLine -notlike ('*' + $taskBridge + '*')) {
            throw '47711 端口被其他程序占用。'
        }
        # An existing Node process still holds the old modules after a source update. Probe before reusing it.
        $taskProbe = 'const ws=new WebSocket("ws://127.0.0.1:47711");setTimeout(()=>process.exit(2),3000);ws.onopen=()=>ws.send(JSON.stringify({type:"hello",protocol:2,modVersion:"test-launcher"}));ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==="hello")process.exit(m.protocol===2?0:3);if(m.type==="sync.error")process.exit(3);};ws.onerror=()=>process.exit(2);'
        $taskProbe | & $taskNode --input-type=module
        if ($LASTEXITCODE -ne 0) {
            if (Get-Process -Name StardewModdingAPI,'Stardew Valley' -ErrorAction SilentlyContinue) {
                throw '游戏已启动，不能重启旧协议的后端，请先正常退出游戏。'
            }
            Write-Output '正在更新本项目的旧后端进程...'
            Stop-Process -Id $taskListener.OwningProcess -ErrorAction Stop
            $taskListener = $null
        }
    }
    if (-not $taskListener) {
        Start-Process -FilePath $taskNode -ArgumentList ('"' + $taskBridge + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRuntime 'bridge.stdout.log') -RedirectStandardError (Join-Path $taskRuntime 'bridge.stderr.log') | Out-Null
        $taskReadyDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 300
            $taskListener = Get-NetTCPConnection -State Listen -LocalPort 47711 -ErrorAction SilentlyContinue | Select-Object -First 1
        } until ($taskListener -or [DateTime]::UtcNow -ge $taskReadyDeadline)
        if (-not $taskListener) { throw '后端启动失败，请查看 .runtime\bridge.stderr.log。' }
    }

    $taskRequest = [Guid]::NewGuid().ToString()
    $taskPreviousRequest = [Environment]::GetEnvironmentVariable('STARDEW_AGENT_TEST_ABIGAIL', 'Process')
    $taskPreviousManual = [Environment]::GetEnvironmentVariable('STARDEW_AGENT_TEST_ABIGAIL_MANUAL', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('STARDEW_AGENT_TEST_ABIGAIL', $taskRequest, 'Process')
        [Environment]::SetEnvironmentVariable('STARDEW_AGENT_TEST_ABIGAIL_MANUAL', $(if ($Manual) { '1' } else { $null }), 'Process')
        $taskGame = Start-Process -FilePath $taskGameExe -WorkingDirectory $GamePath -WindowStyle Normal -PassThru
    } finally {
        [Environment]::SetEnvironmentVariable('STARDEW_AGENT_TEST_ABIGAIL', $taskPreviousRequest, 'Process')
        [Environment]::SetEnvironmentVariable('STARDEW_AGENT_TEST_ABIGAIL_MANUAL', $taskPreviousManual, 'Process')
    }
    if ($Manual) { Write-Output '游戏已启动，将加载测试档并传送到阿比盖尔旁边，停在提示框供手测。' }
    else { Write-Output '游戏已启动，将自动点击加载、选择测试存档、传送并测试三轮对话。' }
    $taskReportPath = Join-Path $taskModDirectory 'abigail-test-result.json'
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(180)
    $taskLastMessage = ''
    $taskCompleted = $false
    do {
        Start-Sleep -Milliseconds 500
        $taskGame.Refresh()
        if ($taskGame.HasExited) { throw '游戏已退出，自动测试未完成。' }
        $taskReport = $null
        if (Test-Path -LiteralPath $taskReportPath) {
            try { $taskReport = Get-Content -LiteralPath $taskReportPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
        }
        if ($taskReport -and $taskReport.requestId -eq $taskRequest) {
            if ($taskReport.message -ne $taskLastMessage) {
                Write-Output $taskReport.message
                $taskLastMessage = $taskReport.message
            }
            if ($taskReport.completed) {
                $taskReport | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskRuntime 'abigail-test-result.json') -Encoding UTF8
                if (-not $taskReport.success) { throw ('自动测试未通过：' + $taskReport.message) }
                $taskCompleted = $true
                if ($Manual) {
                    if ($taskReport.mode -ne 'manual' -or $taskReport.replies -ne 0) { throw '手测入口意外进入了自动对话，请检查。' }
                    Write-Output '手测已就绪。关闭提示后点击阿比盖尔，原版台词尚未由自动流程消费。'
                } else { Write-Output '自动测试通过。第三轮对话框已保留，可继续手动选择选项或自己说。' }
                break
            }
        }
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if (-not $taskCompleted) { throw '等待测试结果超时，请查看 SMAPI 日志。' }
} finally {
    Stop-Transcript | Out-Null
}
