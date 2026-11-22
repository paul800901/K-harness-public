param(
 [string]$Ref='HEAD',
 [string]$InstallRoot=$PSScriptRoot,
 [string]$CodexExecutable,
 [string]$ClaudeExecutable,
 [ValidateSet('whisper','windows')][string]$DictationProvider,
 [string]$DictationPython,
 [string]$DictationModel
)
$ErrorActionPreference='Stop'
# Prerequisites a fresh Windows computer may lack; nothing is installed automatically.
$node=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1
if(!$node){throw '找不到 Node.js；請先安裝 Node.js 22.19 以上（https://nodejs.org/），重新開啟 PowerShell 後再執行。'}
$nodeVersion=[version]((& $node.Source --version).TrimStart('v') -replace '-.*$','')
if($nodeVersion -lt [version]'22.19.0'){throw "Node.js 版本為 $nodeVersion；K 需要 22.19 以上，請先更新 Node.js。"}
if(!(Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue)){throw '找不到 npm；請重新安裝 Node.js（含 npm）。'}
if(!(Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue)){throw '找不到 Git；請先安裝 Git for Windows（https://git-scm.com/download/win），重新開啟 PowerShell 後再執行。'}
& git -C $PSScriptRoot rev-parse --verify --quiet HEAD *> $null
if($LASTEXITCODE -ne 0){throw 'K 需要從 Git 取得的資料夾安裝（git clone）；下載 ZIP 解壓縮的資料夾無法安裝或更新。'}
$arguments=@((Join-Path $PSScriptRoot 'scripts\manage-install.mjs'),'--root',$InstallRoot,'--ref',$Ref)
if($CodexExecutable){$arguments+=@('--codex',$CodexExecutable)}
if($ClaudeExecutable){$arguments+=@('--claude',$ClaudeExecutable)}
if($DictationProvider){$arguments+=@('--dictation-provider',$DictationProvider)}
if($DictationPython){$arguments+=@('--dictation-python',$DictationPython)}
if($DictationModel){$arguments+=@('--dictation-model',$DictationModel)}
& $node.Source @arguments
if($LASTEXITCODE -ne 0){throw 'K 設定失敗；請保留上方錯誤交給 AI 檢查。'}
