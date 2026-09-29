# Saves the Gmail app password in Windows Credential Manager, which is where the fetcher reads it.
# Run it yourself, as the Windows user the scheduled task runs as: the password is typed here,
# never shown, never written to a file and never passed on the command line.
#
#   powershell -ExecutionPolicy Bypass -File .\set-password.ps1
Push-Location $PSScriptRoot
try {
  $mail = node -e "const m=require('./config').loadConfig().mail;process.stdout.write(JSON.stringify({from:m.from,name:m.credentialName}))" | ConvertFrom-Json
} finally { Pop-Location }
if (-not $mail.from) { Write-Error 'mail.from is empty in config.js / config.local.json.'; exit 1 }

[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault

$secure = Read-Host "Gmail app password for $($mail.from) (16 letters; spaces don't matter)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) -replace '\s', '' }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ($plain.Length -lt 16) { Write-Error 'That is shorter than an app password (16 letters). Nothing saved.'; exit 1 }

# Replacing, not adding a second one: Retrieve would otherwise find the old password first.
try { $vault.Remove($vault.Retrieve($mail.name, $mail.from)) } catch {}
$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($mail.name, $mail.from, $plain)))
$plain = $null
Write-Host "Saved for $($mail.from). Check it with: npm run test-email"
