$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:CARGO_TARGET_DIR = Join-Path $projectRoot "src-tauri\target\exe-only"

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswherePath)) {
        throw "Visual Studio C++ Build Tools are required."
    }
    $installationPath = & $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installationPath) {
        throw "Visual Studio C++ Build Tools are required."
    }
    $developerShell = Join-Path $installationPath "Common7\Tools\Launch-VsDevShell.ps1"
    & $developerShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}

Push-Location $projectRoot
try {
    & node (Join-Path $projectRoot "node_modules\@tauri-apps\cli\tauri.js") build --no-bundle "--" "--bin" "codex-switcher"
    if ($LASTEXITCODE -ne 0) {
        throw "Windows executable build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
