# Builds the K phone app (WebView shell + ongoing notification) with the Android SDK tools
# directly, using the user's Android SDK.
#   pwsh -File android\build.ps1            -> android\build\K-<version>.apk
#   pwsh -File android\build.ps1 -Publish   -> also offers it to the phone's in-app update
# The signing key lives outside Git in <main checkout>\.local\android-keystore; losing it
# means the app can no longer be updated in place (uninstall + reinstall).
param([Parameter(Mandatory=$true)][Uri]$ServerOrigin, [switch]$Publish, [string]$StateRoot)
$ErrorActionPreference = 'Stop'
if (-not $ServerOrigin.IsAbsoluteUri -or $ServerOrigin.Scheme -ne 'https' -or
    $ServerOrigin.Host -notmatch '^[A-Za-z0-9.-]+\.ts\.net$' -or $ServerOrigin.UserInfo -or
    $ServerOrigin.AbsolutePath -ne '/' -or $ServerOrigin.Query -or $ServerOrigin.Fragment) {
    throw '請指定你自己的 Tailscale HTTPS 根網址。'
}
$root = $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$bt = Join-Path $sdk 'build-tools\36.0.0'
$androidJar = Join-Path $sdk 'platforms\android-36\android.jar'
$jdkBin = Split-Path (Get-Command javac).Source
# The main checkout, also when building from a worktree.
$mainRoot = Split-Path (git -C $root rev-parse --path-format=absolute --git-common-dir)
if (-not $StateRoot) {
    $StateRoot = Join-Path $mainRoot '.runtime\workbench\vault\private-state'
}

$version = (Get-Content (Join-Path $root 'version.txt') -Raw).Trim()   # e.g. 1.0.0
$parts = $version.Split('.')
$versionCode = [int]$parts[0] * 10000 + [int]$parts[1] * 100 + [int]$parts[2]

$out = Join-Path $root 'build'
# The previous build output goes to the Recycle Bin (project rule: no permanent deletes).
if (Test-Path $out) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($out, 'OnlyErrorDialogs', 'SendToRecycleBin')
}
New-Item -ItemType Directory -Force "$out\gen", "$out\classes", "$out\dex" | Out-Null

function Run($exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { throw "$exe 失敗（$LASTEXITCODE）" }
}

Write-Host '1/6 編譯資源'
Run "$bt\aapt2.exe" @('compile', '--dir', "$root\res", '-o', "$out\res.zip")

Write-Host '2/6 連結資源'
Run "$bt\aapt2.exe" @('link', '-o', "$out\base.apk", '-I', $androidJar,
    '--manifest', "$root\AndroidManifest.xml", '--java', "$out\gen",
    '--min-sdk-version', '29', '--target-sdk-version', '34',
    '--version-code', "$versionCode", '--version-name', $version,
    "$out\res.zip")

Write-Host '3/6 編譯 Java'
$configDir = Join-Path $out 'gen\tw\k\harness'
New-Item -ItemType Directory -Force $configDir | Out-Null
$origin = $ServerOrigin.GetLeftPart([UriPartial]::Authority)
"package tw.k.harness; final class ServerConfig { static final String ORIGIN = `"$origin`"; }" |
    Set-Content -LiteralPath (Join-Path $configDir 'ServerConfig.java') -Encoding ascii
$sources = @(Get-ChildItem "$root\src", "$out\gen" -Recurse -Filter *.java | ForEach-Object FullName)
Run "$jdkBin\javac.exe" (@('-encoding', 'UTF-8', '-source', '17', '-target', '17', '-Xlint:-options',
    '-classpath', $androidJar, '-d', "$out\classes") + $sources)

Write-Host '4/6 轉成 Android 執行檔'
$classes = @(Get-ChildItem "$out\classes" -Recurse -Filter *.class | ForEach-Object FullName)
Run "$bt\d8.bat" (@('--release', '--min-api', '29', '--lib', $androidJar, '--output', "$out\dex") + $classes)

Write-Host '5/6 打包'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\base.apk", 'Update')
try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", 'classes.dex') | Out-Null
} finally { $zip.Dispose() }
Run "$bt\zipalign.exe" @('-f', '4', "$out\base.apk", "$out\aligned.apk")

Write-Host '6/6 簽章'
$ksDir = Join-Path $mainRoot '.local\android-keystore'
$ks = Join-Path $ksDir 'release.jks'
$ksProps = Join-Path $ksDir 'keystore.properties'
if (-not (Test-Path $ks)) {
    New-Item -ItemType Directory -Force $ksDir | Out-Null
    $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    Run "$jdkBin\keytool.exe" @('-genkeypair', '-keystore', $ks, '-alias', 'k', '-keyalg', 'RSA',
        '-keysize', '2048', '-validity', '36500', '-storepass', $pw, '-keypass', $pw,
        '-dname', 'CN=K')
    "storePassword=$pw" | Set-Content $ksProps -Encoding ascii
}
$pw = ((Get-Content $ksProps -Raw) -replace '(?s).*storePassword=(\S+).*', '$1').Trim()
$apk = Join-Path $out "K-$version.apk"
Run "$bt\apksigner.bat" @('sign', '--ks', $ks, '--ks-key-alias', 'k', '--ks-pass', "pass:$pw",
    '--key-pass', "pass:$pw", '--out', $apk, "$out\aligned.apk")
Run "$bt\apksigner.bat" @('verify', $apk)
Write-Host "完成：$apk"

if ($Publish) {
    # K offers it to the phone at /api/android/shell. Each version has its own file and the
    # description is switched last, so the phone never sees a version whose file is not there.
    $dir = Join-Path $StateRoot '.local\android-shell'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $target = Join-Path $dir "k-shell-$versionCode.apk"
    $sha256 = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    # A published version never changes: a phone may still hold its description.
    if (Test-Path $target) {
        if ((Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
            throw "版本 $version 已發布過且內容不同；請先提高 version.txt 的版本號再發布。"
        }
    } else {
        Copy-Item $apk "$target.tmp" -Force
        Move-Item "$target.tmp" $target
    }
    $info = [ordered]@{
        versionCode = $versionCode
        versionName = $version
        size = (Get-Item $apk).Length
        sha256 = $sha256
    }
    $info | ConvertTo-Json | Set-Content (Join-Path $dir 'k-shell.json.tmp') -Encoding utf8NoBOM
    Move-Item (Join-Path $dir 'k-shell.json.tmp') (Join-Path $dir 'k-shell.json') -Force
    Write-Host "已提供給手機更新：$dir（$version）"
}
