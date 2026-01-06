# OMP Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source -Ref v3.20.1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref v3.20.1

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "can1357/oh-my-pi"
$Package = "@oh-my-pi/omp-coding-agent"
$InstallDir = if ($env:OMP_INSTALL_DIR) { $env:OMP_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$BinaryName = "omp-windows-x64.exe"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
}

function Install-ViaBun {
    Write-Host "Installing via bun..."
    if ($Ref) {
        if (-not (Test-GitInstalled)) {
            throw "git is required for -Ref when installing from source"
        }

        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-install-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

        try {
            $repoUrl = "https://github.com/$Repo.git"
            $cloneOk = $false
            try {
                git clone --depth 1 --branch $Ref $repoUrl $tmpRoot | Out-Null
                $cloneOk = $true
            } catch {
                $cloneOk = $false
            }

            if (-not $cloneOk) {
                git clone $repoUrl $tmpRoot | Out-Null
                Push-Location $tmpRoot
                try {
                    git checkout $Ref | Out-Null
                } finally {
                    Pop-Location
                }
            }

            $packagePath = Join-Path $tmpRoot "packages\coding-agent"
            if (-not (Test-Path $packagePath)) {
                throw "Expected package at $packagePath"
            }

            bun install -g $packagePath
        } finally {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    } else {
        bun install -g $Package
    }

    Write-Host ""
    Write-Host "✓ Installed omp via bun" -ForegroundColor Green
    Write-Host "Run 'omp' to get started!"
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref"
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    # Download binary
    $Url = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $OutPath = Join-Path $InstallDir "omp.exe"
    Invoke-WebRequest -Uri $Url -OutFile $OutPath

    Write-Host ""
    Write-Host "✓ Installed omp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: use bun if available, otherwise binary
    if (Test-BunInstalled) {
        Install-ViaBun
    } else {
        Install-Binary
    }
}
