# Registers the weekly run: Mondays at 10:00 on this PC, as you, while you're logged on (Drive for
# desktop only syncs then, and the Chrome profile is yours). If the PC was off or asleep at
# 10:00, it runs as soon as it's back. Safe to run again: it replaces the task.
#
#   powershell -ExecutionPolicy Bypass -File .\schedule.ps1            register or update
#   powershell -ExecutionPolicy Bypass -File .\schedule.ps1 -Remove    stop the weekly run
param([switch]$Remove)

$name = 'Buddy invoice fetcher'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Removed '$name'."
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument 'src\cli.js run' -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '10:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Saves new Google Cloud invoices to the Buddy invoices folder in Drive and emails them. See tools/invoice-fetcher/README.md.' -Force | Out-Null

Write-Host "Registered '$name': next run $((Get-ScheduledTaskInfo -TaskName $name).NextRunTime)."
Write-Host "Run it now to check:  Start-ScheduledTask -TaskName '$name'"
