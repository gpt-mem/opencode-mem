param(
    [string]$Version = "",
    [string]$BinaryPath = "",
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"

$AppName = "opencode"
$Repo = "gpt-mem/opencode-mem"
$InstallDir = Join-Path $env:USERPROFILE ".opencode\bin"
$ConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
$DataDir = Join-Path $env:USERPROFILE ".local\share\opencode"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if ($BinaryPath) {
    if (-not (Test-Path $BinaryPath)) {
        throw "Binary not found: $BinaryPath"
    }
    Copy-Item -Path $BinaryPath -Destination (Join-Path $InstallDir "opencode.exe") -Force
} else {
    if ($Version) {
        $tag = "v$($Version.TrimStart('v'))"
    } else {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
        $tag = $release.tag_name
    }

    $assetName = "opencode-windows-x64.zip"
    $downloadUrl = "https://github.com/$Repo/releases/download/$tag/$assetName"
    $tmpDir = Join-Path $env:TEMP "opencode-install-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

    try {
        $zipPath = Join-Path $tmpDir $assetName
        Write-Host "Downloading $downloadUrl"
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath

        $extractDir = Join-Path $tmpDir "extracted"
        New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

        $exe = Get-ChildItem -Path $extractDir -Recurse -Filter "opencode.exe" | Select-Object -First 1
        if (-not $exe) {
            throw "opencode.exe was not found in the downloaded archive"
        }
        Copy-Item -Path $exe.FullName -Destination (Join-Path $InstallDir "opencode.exe") -Force
    } finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Write an unrestricted config template if the user does not already have one.
$configPath = Join-Path $ConfigDir "opencode.jsonc"
if (-not (Test-Path $configPath)) {
    $config = @'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow",
  "tools": {
    "github-triage": false,
    "github-pr-search": false
  }
}
'@
    Set-Content -Path $configPath -Value $config -Encoding UTF8
}

if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$userPath", "User")
        Write-Host "Added $InstallDir to user PATH. Restart the terminal to use it."
    }
}

Write-Host ""
Write-Host "OpenCode installed to $InstallDir\opencode.exe"
Write-Host "Config: $configPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open a new terminal."
Write-Host "  2. Run: opencode --version"
Write-Host "  3. Set your provider key, for example:"
Write-Host "     setx OPENAI_API_KEY ""sk-..."""
Write-Host "  4. Start in a project: cd C:\path\to\project && opencode"
Write-Host ""
