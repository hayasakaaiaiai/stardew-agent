[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ConfigPath,
    [ValidateSet('spring','summer','fall','winter')][string]$Season='spring',
    [ValidateRange(1,28)][int]$Day=1,
    [ValidateRange(1,10)][int]$Year=1,
    [switch]$Rain
)
$ErrorActionPreference='Stop'
$taskConfig=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskExpected=[IO.Path]::GetFullPath((Join-Path $env:APPDATA ('StardewValley\Saves\MemoryTest_' + $taskConfig.UniqueId)))
if (-not $taskConfig.World -or $taskConfig.UniqueId -eq '436774213' -or
    [IO.Path]::GetFullPath($taskConfig.SaveDirectory) -ne $taskExpected -or
    $taskConfig.SaveFolder -ne ('MemoryTest_' + $taskConfig.UniqueId)) { throw 'Refusing to modify a save outside the disposable world test.' }
function Read-WorldXml([string]$Path) {
    $taskSettings=[Xml.XmlReaderSettings]::new(); $taskSettings.DtdProcessing=[Xml.DtdProcessing]::Prohibit; $taskSettings.XmlResolver=$null
    $taskReader=[Xml.XmlReader]::Create($Path,$taskSettings)
    try { $taskXml=[Xml.XmlDocument]::new(); $taskXml.XmlResolver=$null; $taskXml.Load($taskReader); return ,$taskXml } finally { $taskReader.Dispose() }
}
$taskBase=Join-Path $taskConfig.RunDirectory 'initial-copy'
$taskData=Read-WorldXml (Join-Path $taskBase $taskConfig.SaveFolder)
if ($taskData.SelectSingleNode('/SaveGame/uniqueIDForThisGame').InnerText -ne [string]$taskConfig.UniqueId) { throw 'Initial disposable save ID mismatch.' }
foreach ($taskPair in @(@('currentSeason',$Season),@('dayOfMonth',[string]$Day),@('year',[string]$Year),@('isRaining',([bool]$Rain).ToString().ToLowerInvariant()),@('isLightning','false'),@('isSnowing',($Season -eq 'winter').ToString().ToLowerInvariant()))) {
    $taskNode=$taskData.SelectSingleNode('/SaveGame/' + $taskPair[0]); if ($taskNode) { $taskNode.InnerText=$taskPair[1] }
}
# Stardew 1.6 selects NPC routes using the location context, not just the legacy root fields.
$taskWeather=$taskData.SelectSingleNode('/SaveGame/locationWeather/item[key/string="Default"]/value/LocationWeather')
if (-not $taskWeather) { throw 'The disposable save has no Default location weather.' }
foreach ($taskPair in @(@('weather',$(if ($Rain) {'Rain'} elseif ($Season -eq 'winter') {'Snow'} else {'Sun'})),@('isRaining',([bool]$Rain).ToString().ToLowerInvariant()),@('isSnowing',($Season -eq 'winter').ToString().ToLowerInvariant()),@('isLightning','false'),@('isDebrisWeather','false'),@('isGreenRain','false'))) {
    foreach ($taskNode in @($taskWeather.SelectNodes($taskPair[0] + '/* | ' + $taskPair[0].Substring(0,1).ToUpperInvariant() + $taskPair[0].Substring(1)))) { $taskNode.InnerText=$taskPair[1] }
}
foreach ($taskPointer in @($taskData.SelectNodes('//item[key/string="smapi/mod-data/mmj.stardewagentbridge/memory-commit"]'))) { $taskPointer.ParentNode.RemoveChild($taskPointer) | Out-Null }
# Calendar jumps can otherwise open Marnie's unrelated pet-adoption question as soon as the save loads.
$taskSeen=$taskData.SelectSingleNode('/SaveGame/player/eventsSeen')
if ($taskSeen -and -not $taskSeen.SelectSingleNode('*[text()="1590166"]')) {
    $taskElement=if ($taskSeen.FirstChild) { $taskSeen.FirstChild.Name } else { 'string' }
    $taskEvent=$taskData.CreateElement($taskElement); $taskEvent.InnerText='1590166'; $taskSeen.AppendChild($taskEvent) | Out-Null
}
$taskData.Save((Join-Path $taskExpected $taskConfig.SaveFolder))
$taskInfo=Read-WorldXml (Join-Path $taskBase 'SaveGameInfo')
$taskSeasonIndex=[string](@('spring','summer','fall','winter').IndexOf($Season))
foreach ($taskPair in @(@('dayOfMonthForSaveGame',[string]$Day),@('seasonForSaveGame',$taskSeasonIndex),@('yearForSaveGame',[string]$Year))) {
    $taskNode=$taskInfo.DocumentElement.SelectSingleNode($taskPair[0]); if ($taskNode) { $taskNode.InnerText=$taskPair[1] }
}
$taskInfo.Save((Join-Path $taskExpected 'SaveGameInfo'))
Write-Output ('Prepared disposable date: ' + $Year + ' ' + $Season + ' ' + $Day + ' rain=' + [bool]$Rain)
