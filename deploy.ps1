<#
.SYNOPSIS
  Deploy anon-telegram-bot to Render from a Docker image (no GitHub repo).

.DESCRIPTION
  Builds a linux/amd64 image, pushes it to Docker Hub, then creates/updates
  an image-backed Render web service via the Render API.

.EXAMPLE
  $env:RENDER_API_KEY = 'rnd_...'
  docker login
  .\deploy.ps1 -BotToken '123456:AA...' -DockerHubUser 'yourname'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BotToken,

  [Parameter(Mandatory = $false)]
  [string]$BotToken2 = "",

  [Parameter(Mandatory = $true)]
  [string]$DockerHubUser,

  [string]$RenderApiKey = $env:RENDER_API_KEY,

  [string]$ImageName = "anon-telegram-bot",

  [string]$ImageTag = "latest",

  [string]$ServiceName = "anon-telegram-bot",

  [ValidateSet("oregon", "frankfurt", "singapore", "ohio", "virginia")]
  [string]$Region = "frankfurt",

  [string]$OwnerId = "tea-dai85867bikc73c01d7g"
)

$ErrorActionPreference = "Stop"

function New-RandomSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Invoke-RenderApi {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null
  )

  $headers = @{
    Authorization = "Bearer $script:RenderApiKey"
    Accept        = "application/json"
  }

  $params = @{
    Method  = $Method
    Uri     = "https://api.render.com/v1$Path"
    Headers = $headers
  }

  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 30 -Compress)
  }

  return Invoke-RestMethod @params
}

function Resolve-DockerCommand {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return "docker" }

  # Fall back to Docker inside WSL if Desktop CLI is missing on Windows PATH
  $wsl = Get-Command wsl -ErrorAction SilentlyContinue
  if ($wsl) {
    $check = wsl -d Ubuntu -- bash -lc "command -v docker" 2>$null
    if ($LASTEXITCODE -eq 0 -and $check) {
      return "wsl"
    }
  }

  throw @"
Docker is required for no-GitHub deploys (Render pulls a container image).

Install Docker Desktop, then re-run:

  winget install --id Docker.DockerDesktop -e
  # reboot / start Docker Desktop, then:
  docker login
  .\deploy.ps1 -BotToken '...' -DockerHubUser 'your-dockerhub-user'
"@
}

function Invoke-Docker {
  param([Parameter(Mandatory = $true)][string[]]$DockerArgs)

  if ($script:DockerMode -eq "wsl") {
    $joined = ($DockerArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
      }) -join ' '
    # Project is under /mnt/c/... in WSL
    $wslDir = (wsl -d Ubuntu -- wslpath -a $PSScriptRoot).Trim()
    wsl -d Ubuntu -- bash -lc "cd '$wslDir' && docker $joined"
    if ($LASTEXITCODE -ne 0) { throw "docker (wsl) failed: docker $joined" }
    return
  }

  & docker @DockerArgs
  if ($LASTEXITCODE -ne 0) { throw "docker failed: docker $($DockerArgs -join ' ')" }
}

Write-Host "==> Validating Telegram bot token..." -ForegroundColor Cyan
try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/getMe"
  if (-not $me.ok) { throw "Telegram getMe failed" }
  Write-Host "    Bot: @$($me.result.username) (id $($me.result.id))" -ForegroundColor Green
}
catch {
  throw "Invalid bot token. Create one with @BotFather, then retry. $_"
}

if (-not $RenderApiKey) {
  throw @"
RENDER_API_KEY is missing.

  `$env:RENDER_API_KEY = 'rnd_...'
  .\deploy.ps1 -BotToken '...' -DockerHubUser 'yourname'
"@
}

$script:DockerMode = Resolve-DockerCommand
if ($script:DockerMode -eq "docker") {
  Write-Host "==> Using local docker CLI" -ForegroundColor Cyan
} else {
  Write-Host "==> Using docker via WSL Ubuntu" -ForegroundColor Cyan
}

$imageLocal = "${DockerHubUser}/${ImageName}:${ImageTag}"
$imagePath = "docker.io/${DockerHubUser}/${ImageName}:${ImageTag}"

Push-Location $PSScriptRoot
try {
  Write-Host "==> Building $imageLocal (linux/amd64)..." -ForegroundColor Cyan
  Invoke-Docker -DockerArgs @(
    "build",
    "--platform", "linux/amd64",
    "-t", $imageLocal,
    "."
  )

  Write-Host "==> Pushing $imagePath ..." -ForegroundColor Cyan
  Invoke-Docker -DockerArgs @("push", $imageLocal)

  $webhookSecret = New-RandomSecret

  Write-Host "==> Looking for Render service '$ServiceName'..." -ForegroundColor Cyan
  $listed = Invoke-RenderApi -Method GET -Path "/services?limit=50"
  $existing = @(
    $listed |
      ForEach-Object { $_.service } |
      Where-Object { $_.name -eq $ServiceName }
  ) | Select-Object -First 1

  if ($existing) {
    Write-Host "    Updating image + env on $($existing.id)" -ForegroundColor Yellow
    $serviceId = $existing.id

    # Update env vars
    $envBody = @(
      @{ key = "TELEGRAM_BOT_TOKEN"; value = $BotToken }
      @{ key = "WEBHOOK_SECRET"; value = $webhookSecret }
      @{ key = "NODE_ENV"; value = "production" }
    )
    Invoke-RenderApi -Method PUT -Path "/services/$serviceId/env-vars" -Body $envBody | Out-Null

    # Trigger deploy of the new image tag
    Invoke-RenderApi -Method POST -Path "/services/$serviceId/deploys" -Body @{
      clearCache = "clear"
      imageUrl   = $imagePath
    } | Out-Null
  }
  else {
    Write-Host "==> Creating image-backed Render web service..." -ForegroundColor Cyan
    $createBody = @{
      type    = "web_service"
      name    = $ServiceName
      ownerId = $OwnerId
      image   = @{
        ownerId   = $OwnerId
        imagePath = $imagePath
      }
      envVars = @(
        @{ key = "TELEGRAM_BOT_TOKEN"; value = $BotToken }
        @{ key = "WEBHOOK_SECRET"; value = $webhookSecret }
        @{ key = "NODE_ENV"; value = "production" }
      )
      serviceDetails = @{
        runtime         = "image"
        plan            = "free"
        region          = $Region
        healthCheckPath = "/health"
      }
    }

    $created = Invoke-RenderApi -Method POST -Path "/services" -Body $createBody
    $serviceId = $created.service.id
    Write-Host "    Created $serviceId" -ForegroundColor Green
  }

  Start-Sleep -Seconds 2
  $service = (Invoke-RenderApi -Method GET -Path "/services/$serviceId").service
  $url = $service.serviceDetails.url

  Write-Host ""
  Write-Host "Deploy started (no GitHub involved)." -ForegroundColor Green
  Write-Host "Dashboard: https://dashboard.render.com/web/$serviceId"
  if ($url) {
    Write-Host "URL:       $url"
    Write-Host "Health:    $url/health"
  }
  Write-Host "Image:     $imagePath"
}
finally {
  Pop-Location
}
