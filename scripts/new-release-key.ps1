$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskSigning = Join-Path $taskRoot '.signing'
$taskKey = Join-Path $taskSigning 'vocabulary-ledger-release.p12'
if (Test-Path -LiteralPath $taskKey) { throw 'Release key already exists; never replace it.' }
$taskJava = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'D:\Agents\.tools\jdk-21' }
New-Item -ItemType Directory -Force -Path $taskSigning | Out-Null
$taskSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $taskSigning /inheritance:r /grant:r "*$($taskSid):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict signing directory permissions.' }
$taskPassword = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$taskSecure = ConvertTo-SecureString $taskPassword -AsPlainText -Force
ConvertFrom-SecureString $taskSecure | Set-Content -LiteralPath (Join-Path $taskSigning 'release-password.dpapi') -NoNewline
$env:VOCAB_RELEASE_STORE_PASSWORD = $taskPassword
try {
  & (Join-Path $taskJava 'bin\keytool.exe') -genkeypair -noprompt -storetype PKCS12 -keystore $taskKey -alias vocabulary-ledger -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -dname 'CN=Vocabulary Ledger Release, O=Vocabulary Ledger' -storepass:env VOCAB_RELEASE_STORE_PASSWORD -keypass:env VOCAB_RELEASE_STORE_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw 'Release key generation failed; preserve partial signing material for inspection.' }
  Write-Output 'Release key generated. Password is DPAPI-protected for this Windows user. No secret printed.'
} finally { Remove-Item Env:VOCAB_RELEASE_STORE_PASSWORD -ErrorAction SilentlyContinue; $taskPassword = $null }
