<#
.SYNOPSIS
  One-shot deploy of anon-telegram-bot to Render.

.EXAMPLE
  .\deploy.ps1 -BotToken "123456:AA..."

.EXAMPLE
  $env:RENDER_API_KEY = "rnd_..."; .\deploy.ps1 -BotToken "123456:AA..."
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

  [string]$GitHubRepo = ""
)

$ErrorActionPreference = "Stop"

function New-RandomSecret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return ([Convert]::ToHexString($bytes)).ToLowerInvariant()
}

function Invoke-RenderApi {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $headers = @{
    Authorization = "Bearer $RenderApiKey"
    Accept        = "application/json"
  }

  $uri = "https://api.render.com/v1$Path"
  $params = @{
    Method  = $Method
    Uri     = $uri
    Headers = $headers
  }

  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }

  return Invoke-RestMethod @params
}

Write-Host "==> Validating Telegram bot token..." -ForegroundColor Cyan
try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$BotToken/getMe"
  if (-not $me.ok) {
    throw "Telegram getMe failed"
  }
  Write-Host "    Bot: @$($me.result.username) (id $($me.result.id))" -ForegroundColor Green
}
catch {
  throw "Invalid TELEGRAM bot token. Get one from @BotFather. $_"
}

if (-not $RenderApiKey) {
  throw @"
RENDER_API_KEY is missing.

1. Create a key: https://dashboard.render.com/u/*/settings#api-keys
2. Re-run:

   `$env:RENDER_API_KEY = 'rnd_...'
   .\deploy.ps1 -BotToken 'YOUR_BOT_TOKEN'
"@
}

Push-Location $PSScriptRoot
try {
  if (-not (Test-Path .git)) {
    git init | Out-Null
  }

  $status = git status --porcelain
  if ($status) {
    Write-Host "==> Committing local changes..." -ForegroundColor Cyan
    git add -A
    git commit -m "Deploy anon-telegram-bot" | Out-Null
  }

  $remote = git remote get-url origin 2>$null
  if (-not $remote) {
    if (-not $GitHubRepo) {
      $GitHubRepo = "anon-telegram-bot"
    }
    Write-Host "==> Creating GitHub repo voidmute/$GitHubRepo ..." -ForegroundColor Cyan
    gh repo create $GitHubRepo --private --source=. --remote=origin --push
    $remote = git remote get-url origin
  }
  else {
    Write-Host "==> Pushing to origin..." -ForegroundColor Cyan
    git branch -M $Branch
    git push -u origin $Branch
  }

  # Normalize to https://github.com/owner/repo
  if ($remote -match "git@github.com:(.+?)(?:\.git)?$") {
    $repoUrl = "https://github.com/$($Matches[1])"
  }
  elseif ($remote -match "https://github.com/(.+?)(?:\.git)?$") {
    $repoUrl = "https://github.com/$($Matches[1])"
  }
  else {
    $repoUrl = $remote -replace "\.git$", ""
  }

  Write-Host "    Repo: $repoUrl" -ForegroundColor Green

  $webhookSecret = New-RandomSecret

  Write-Host "==> Looking for existing Render service '$ServiceName'..." -ForegroundColor Cyan
  $services = Invoke-RenderApi -Method GET -Path "/services?limit=50&name=$ServiceName"
  $existing = @(
    $services |
      ForEach-Object { $_.service } |
      Where-Object { $_.name -eq $ServiceName }
  ) | Select-Object -First 1

  if ($existing) {
    Write-Host "    Found $($existing.id) — updating env + triggering deploy" -ForegroundColor Yellow
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
    Write-Host "==> Creating Render web service..." -ForegroundColor Cyan
    $ownerId = (Invoke-RenderApi -Method GET -Path "/owners?limit=1")[0].owner.id

    $createBody = @{
      type   = "web_service"
      name   = $ServiceName
      ownerId = $ownerId
      repo   = $repoUrl
      branch = $Branch
      runtime = "node"
      plan   = "free"
      region = $Region
      buildCommand = "npm ci && npm run build"
      startCommand = "npm start"
      autoDeploy = "yes"
      envVars = @(
        @{ key = "TELEGRAM_BOT_TOKEN"; value = $BotToken }
        @{ key = "WEBHOOK_SECRET"; value = $webhookSecret }
        @{ key = "NODE_ENV"; value = "production" }
      )
    }

    $created = Invoke-RenderApi -Method POST -Path "/services" -Body $createBody
    $serviceId = $created.service.id
    Write-Host "    Created service $serviceId" -ForegroundColor Green
  }

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
  Write-Host "After the first deploy is live, the bot sets its Telegram webhook automatically." -ForegroundColor Cyan
  Write-Host "Add the bot to a group as admin (Delete messages) for /m and /с cleanup." -ForegroundColor Cyan
}
finally {
  Pop-Location
}
