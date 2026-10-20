[CmdletBinding()]
param(
    [string]$GamePath = 'E:\games\steamapps\common\Stardew Valley',
    [switch]$Nightly,
    [switch]$MorningPlans,
    [switch]$BubblesOnly
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (Get-Process -Name StardewModdingAPI,'Stardew Valley' -ErrorAction SilentlyContinue) {
    throw '请先正常退出游戏；记忆验收会自动启动并只加载独立副本。'
}
$taskSource = Join-Path $env:APPDATA 'StardewValley\Saves\测试_436774213'
$taskSourceData = Join-Path $taskSource '测试_436774213'
if (-not (Test-Path -LiteralPath $taskSourceData)) { throw '找不到源测试存档。' }
$taskRun = Join-Path $taskRoot ('.runtime\game-memory-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskRun -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $taskSource -Destination (Join-Path $taskRun 'original-backup') -Recurse
$taskBefore = @(Get-ChildItem -LiteralPath $taskSource -File | ForEach-Object {
    [pscustomobject]@{ Name=$_.Name; Hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$taskBefore | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRun 'original-hashes-before.json') -Encoding UTF8

function Read-TaskSaveXml([string]$Path) {
    $taskSettings = New-Object System.Xml.XmlReaderSettings
    $taskSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $taskSettings.XmlResolver = $null
    $taskReader = [System.Xml.XmlReader]::Create($Path, $taskSettings)
    try {
        $taskDocument = New-Object System.Xml.XmlDocument
        $taskDocument.XmlResolver = $null
        $taskDocument.Load($taskReader)
        return ,$taskDocument
    } finally { $taskReader.Dispose() }
}

$taskDocument = Read-TaskSaveXml $taskSourceData
if ($taskDocument.SelectSingleNode('/SaveGame/uniqueIDForThisGame').InnerText -ne '436774213' -or
    $taskDocument.SelectSingleNode('/SaveGame/player/name').InnerText -ne '测试') {
    throw '源文件不是指定测试存档。'
}
$taskId = [string](Get-Random -Minimum 1000000000 -Maximum 2000000000)
$taskFolder = 'MemoryTest_' + $taskId
$taskCopy = Join-Path (Split-Path -Parent $taskSource) $taskFolder
if (Test-Path -LiteralPath $taskCopy) { throw '验收副本已存在，请重新运行生成新 ID。' }
New-Item -ItemType Directory -Path $taskCopy | Out-Null
$taskDocument.SelectSingleNode('/SaveGame/uniqueIDForThisGame').InnerText = $taskId
$taskDocument.SelectSingleNode('/SaveGame/player/name').InnerText = '记忆验收'
$taskDocument.SelectSingleNode('/SaveGame/player/farmName').InnerText = '记忆验收'
foreach ($taskPointer in @($taskDocument.SelectNodes('//item[key/string="smapi/mod-data/mmj.stardewagentbridge/memory-commit"]'))) {
    $taskPointer.ParentNode.RemoveChild($taskPointer) | Out-Null
}
$taskDocument.Save((Join-Path $taskCopy $taskFolder))
$taskInfo = Read-TaskSaveXml (Join-Path $taskSource 'SaveGameInfo')
$taskInfo.DocumentElement.SelectSingleNode('name').InnerText = '记忆验收'
$taskInfo.DocumentElement.SelectSingleNode('farmName').InnerText = '记忆验收'
$taskInfo.Save((Join-Path $taskCopy 'SaveGameInfo'))
Copy-Item -LiteralPath $taskCopy -Destination (Join-Path $taskRun 'initial-copy') -Recurse
$taskConfig = [pscustomobject]@{
    RequestId=[Guid]::NewGuid().ToString(); SaveFolder=$taskFolder; UniqueId=$taskId
    BackendUrl=''; RunDirectory=$taskRun; SaveDirectory=$taskCopy; GamePath=$GamePath
    Nightly=[bool]($Nightly -or $MorningPlans); MorningPlans=[bool]$MorningPlans; BubblesOnly=[bool]$BubblesOnly
}
$taskConfigPath = Join-Path $taskRun 'config.json'
$taskConfig | ConvertTo-Json | Set-Content -LiteralPath $taskConfigPath -Encoding UTF8
Write-Output ('独立验收副本：' + $taskCopy)
Write-Output ('备份和证据目录：' + $taskRun)
$taskExitCode = 1
try {
    & (Join-Path $PSScriptRoot 'test-abigail.ps1') -GamePath $GamePath -PrepareOnly
    $taskRunner = if ($BubblesOnly) { 'test-game-bubbles.ts' } else { 'test-game-memory.ts' }
    & node.exe (Join-Path $PSScriptRoot $taskRunner) $taskConfigPath
    $taskExitCode = $LASTEXITCODE
} finally {
    $taskAfter = @(Get-ChildItem -LiteralPath $taskSource -File | ForEach-Object {
        [pscustomobject]@{ Name=$_.Name; Hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
    $taskAfter | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRun 'original-hashes-after.json') -Encoding UTF8
    if (Compare-Object $taskBefore $taskAfter -Property Name,Hash) {
        throw '原测试档发生变化，已保留测试前备份，请检查。'
    }
    Write-Output '原测试存档所有文件的 SHA256 前后相同。'
}
if ($taskExitCode -ne 0) { throw ('记忆真机验收未通过，请查看 ' + $taskRun) }
