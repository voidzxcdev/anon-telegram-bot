<#
.SYNOPSIS
  One-shot deploy of anon-telegram-bot to Render.

.EXAMPLE
  $env:RENDER_API_KEY = "rnd_..."
  .\deploy.ps1 -BotToken "123456:AA..."

.EXAMPLE
  .\deploy.ps1 -BotToken "123456:AA..." -RenderApiKey "rnd_..."
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BotToken,

  [string]$RenderApiKey = $env:RENDER_API_KEY,

  [string]$ServiceName = "anon-telegram-bot",

  [ValidateSet("oregon", "frankfurt", "singapore", "ohio", "virginia")]
  [string]$Region = "frankfurt",

  [string]$Branch = "main",

  [string]$OwnerId = "tea-dai85867bikc73c01d7g",

  [string]$GitHubRepo = ""
)

$ErrorActionPreference = "Stop"

function New-RandomSecret {
  # Compatible with Windows PowerShell 5.1 (.NET Framework) and PowerShell 7+
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  }
  finally {
    $rng.Dispose()
  }
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

1. Create a key: https://dashboard.render.com/u/*/settings#api-keys
2. Run:

   `$env:RENDER_API_KEY = 'rnd_...'
   .\deploy.ps1 -BotToken 'YOUR_BOT_TOKEN'
"@
}

Push-Location $PSScriptRoot
try {
  if (-not (Test-Path .git)) {
    git init | Out-Null
  }

  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host "==> Committing local changes..." -ForegroundColor Cyan
    git add -A
    $env:GIT_AUTHOR_NAME = if ($env:GIT_AUTHOR_NAME) { $env:GIT_AUTHOR_NAME } else { "deploy" }
    $env:GIT_AUTHOR_EMAIL = if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } else { "deploy@local" }
    $env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
    $env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL
    git commit -m "Deploy anon-telegram-bot" | Out-Null
  }

  $remote = $null
  try { $remote = git remote get-url origin } catch { $remote = $null }

  if (-not $remote) {
    if (-not $GitHubRepo) { $GitHubRepo = "anon-telegram-bot" }
    Write-Host "==> Creating GitHub repo $GitHubRepo ..." -ForegroundColor Cyan
    gh repo create $GitHubRepo --private --source=. --remote=origin --push
    $remote = git remote get-url origin
  }
  else {
    Write-Host "==> Pushing to origin/$Branch ..." -ForegroundColor Cyan
    git branch -M $Branch
    git push -u origin $Branch
  }

  if ($remote -match "git@github\.com:(.+?)(?:\.git)?$") {
    $repoUrl = "https://github.com/$($Matches[1])"
  }
  elseif ($remote -match "https://github\.com/(.+?)(?:\.git)?$") {
    $repoUrl = "https://github.com/$($Matches[1] -replace '\.git$','')"
  }
  else {
    $repoUrl = $remote -replace "\.git$", ""
  }

  Write-Host "    Repo: $repoUrl" -ForegroundColor Green

  $webhookSecret = New-RandomSecret

  Write-Host "==> Looking for Render service '$ServiceName'..." -ForegroundColor Cyan
  $listed = Invoke-RenderApi -Method GET -Path "/services?limit=50"
  $existing = @(
    $listed |
      ForEach-Object { $_.service } |
      Where-Object { $_.name -eq $ServiceName }
  ) | Select-Object -First 1

  if ($existing) {
    Write-Host "    Updating env vars on $($existing.id)" -ForegroundColor Yellow
    $serviceId = $existing.id
    $envBody = @(
      @{ key = "TELEGRAM_BOT_TOKEN"; value = $BotToken }
      @{ key = "WEBHOOK_SECRET"; value = $webhookSecret }
      @{ key = "NODE_ENV"; value = "production" }
    )
    Invoke-RenderApi -Method PUT -Path "/services/$serviceId/env-vars" -Body $envBody | Out-Null
    Invoke-RenderApi -Method POST -Path "/services/$serviceId/deploys" -Body @{ clearCache = "clear" } | Out-Null
  }
  else {
    Write-Host "==> Creating Render web service in $Region..." -ForegroundColor Cyan
    $createBody = @{
      type      = "web_service"
      name      = $ServiceName
      ownerId   = $OwnerId
      repo      = $repoUrl
      branch    = $Branch
      autoDeploy = "yes"
      envVars   = @(
        @{ key = "TELEGRAM_BOT_TOKEN"; value = $BotToken }
        @{ key = "WEBHOOK_SECRET"; value = $webhookSecret }
        @{ key = "NODE_ENV"; value = "production" }
      )
      serviceDetails = @{
        runtime            = "node"
        plan               = "free"
        region             = $Region
        healthCheckPath    = "/health"
        envSpecificDetails = @{
          buildCommand = "npm ci && npm run build"
          startCommand = "npm start"
        }
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
  Write-Host "Deploy started." -ForegroundColor Green
  Write-Host "Dashboard: https://dashboard.render.com/web/$serviceId"
  if ($url) {
    Write-Host "URL:       $url"
    Write-Host "Health:    $url/health"
  }
  Write-Host ""
  Write-Host "On boot the bot registers its Telegram webhook via RENDER_EXTERNAL_URL." -ForegroundColor Cyan
  Write-Host "In groups: promote the bot and allow Delete messages so /m and /с can scrub yours." -ForegroundColor Cyan
}
finally {
  Pop-Location
}
