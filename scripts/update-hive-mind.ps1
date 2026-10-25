# One-time bootstrap for versions that predate the built-in tray updater.
$ErrorActionPreference = 'Stop'
$release = Invoke-RestMethod 'https://api.github.com/repos/Jahdir-Cartagena-Rivers/Hive-Mind/releases/latest'
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v\d+\.\d+\.\d+$') { throw 'No stable Hive Mind update is available.' }
$prefix = "https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind/releases/download/$($release.tag_name)/"
$metadata = @($release.assets | Where-Object { $_.name -eq 'hive-mind-update.json' })
if ($metadata.Count -ne 1 -or $metadata[0].browser_download_url -ne ($prefix + 'hive-mind-update.json')) { throw 'No trusted update manifest is available.' }
$manifest = Invoke-RestMethod $metadata[0].browser_download_url
$filename = "Hive-Mind-Setup-$($manifest.version)-x64.exe"
if ($release.tag_name -ne "v$($manifest.version)" -or $manifest.filename -ne $filename -or $manifest.url -ne ($prefix + $filename) -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid update manifest.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Hive Mind requires 64-bit Windows.' }
if ($manifest.size -isnot [long] -and $manifest.size -isnot [int]) { throw 'Invalid update size.' }
if ($manifest.size -le 0 -or $manifest.size -gt 1073741824) { throw 'Invalid update size.' }
Write-Host 'For this one-time bootstrap, quit Hive Mind from its tray menu before continuing.'
$answer = Read-Host 'Press Enter after Hive Mind is closed, or type cancel'
if ($answer -eq 'cancel') { return }
$directory = Join-Path ([IO.Path]::GetTempPath()) ('hive-mind-update-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $directory | Out-Null
$installer = Join-Path $directory $filename
Invoke-WebRequest $manifest.url -OutFile $installer
if ((Get-Item -LiteralPath $installer).Length -ne $manifest.size -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) { throw 'Update integrity check failed. Nothing was installed.' }
Start-Process -FilePath $installer -ArgumentList '/S','--updated','--force-run' -WindowStyle Hidden -Wait
