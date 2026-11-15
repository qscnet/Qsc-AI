# Xuanwu command watcher
# NOTE: ASCII ONLY. Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
#       so any Chinese text here would corrupt the parser. Keep it ASCII.
#
# Start : double-click start-watcher.bat, keep the window open
# Stop  : close the window or press Ctrl+C
# Usage : an agent writes _run.bat -> this runs it -> writes _done.txt

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "  [watcher] started"
Write-Host "  dir: $root"
Write-Host "  waiting for _run.bat ... (close window to stop)"
Write-Host ""

while ($true) {
    if (Test-Path "_run.bat") {
        try {
            Move-Item -Force "_run.bat" "_run_busy.bat" -ErrorAction Stop
            $stamp = Get-Date -Format "HH:mm:ss"
            Write-Host "  [$stamp] running ..."

            $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c _run_busy.bat" -Wait -PassThru -NoNewWindow

            $done = Get-Date -Format "HH:mm:ss"
            $txt = "[" + $done + "] EXIT=" + $p.ExitCode
            $enc = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText((Join-Path $root "_done.txt"), $txt, $enc)
            Write-Host "  $txt"
            Remove-Item "_run_busy.bat" -Force -ErrorAction SilentlyContinue
        } catch {
            $msg = "[" + (Get-Date -Format "HH:mm:ss") + "] ERROR " + $_.Exception.Message
            $enc = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText((Join-Path $root "_done.txt"), $msg, $enc)
            Write-Host "  $msg"
        }
    }
    Start-Sleep -Milliseconds 400
}
