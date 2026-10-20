param([switch]$Instrumentation)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskSigning = Join-Path $taskRoot '.signing'
$taskKey = Join-Path $taskSigning 'vocabulary-ledger-release.p12'
if (!(Test-Path -LiteralPath $taskKey)) { throw 'Existing authorized Release key required; see scripts/new-release-key.ps1.' }
$taskSecret = Get-Content -Raw -LiteralPath (Join-Path $taskSigning 'release-password.dpapi') | ConvertTo-SecureString
$env:VOCAB_RELEASE_STORE_FILE = $taskKey
$env:VOCAB_RELEASE_KEY_ALIAS = 'vocabulary-ledger'
$env:VOCAB_RELEASE_STORE_PASSWORD = [System.Net.NetworkCredential]::new('', $taskSecret).Password
$env:VOCAB_RELEASE_KEY_PASSWORD = $env:VOCAB_RELEASE_STORE_PASSWORD
$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'D:\Agents\.tools\jdk-21' }
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'D:\Agents\.tools\android-sdk' }
Push-Location $taskRoot
try {
  node scripts/sync-web.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Web synchronization failed.' }
  node node_modules/@capacitor/cli/bin/capacitor copy android
  if ($LASTEXITCODE -ne 0) { throw 'Capacitor copy failed.' }
  $taskSdkEscaped = $env:ANDROID_HOME.Replace('\','\\').Replace(':','\:')
  "sdk.dir=$taskSdkEscaped" | Set-Content -LiteralPath 'android/local.properties'
  Push-Location android
  try {
    $taskTargets = @('testReleaseUnitTest','assembleRelease')
    if ($Instrumentation) { $taskTargets += 'assembleReleaseAndroidTest' }
    & ./gradlew.bat @taskTargets --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'Release build/tests failed.' }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Force -Path releases | Out-Null
  $taskApk = 'releases/vocabulary-ledger-android-1.2.0.apk'
  Copy-Item -LiteralPath 'android/app/build/outputs/apk/release/app-release.apk' -Destination $taskApk
  & (Join-Path $env:ANDROID_HOME 'build-tools/35.0.0/apksigner.bat') verify --verbose --print-certs $taskApk
  if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
  $taskHash = (Get-FileHash -LiteralPath $taskApk -Algorithm SHA256).Hash.ToLowerInvariant()
  "$taskHash  vocabulary-ledger-android-1.2.0.apk" | Set-Content -LiteralPath 'releases/SHA256SUMS.txt'
  Write-Output "Release APK: $taskApk; SHA-256: $taskHash"
} finally {
  Pop-Location
  foreach ($taskName in @('VOCAB_RELEASE_STORE_FILE','VOCAB_RELEASE_KEY_ALIAS','VOCAB_RELEASE_STORE_PASSWORD','VOCAB_RELEASE_KEY_PASSWORD')) { Remove-Item -LiteralPath "Env:$taskName" -ErrorAction SilentlyContinue }
}
