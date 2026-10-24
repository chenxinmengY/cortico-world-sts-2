# 把桥的 /state 原样存一份，用来做校准。标签会自动按界面取，不用每次想名字。
# 用法：  .\scripts\dump-state.cmd            自动按界面命名（战斗会带回合号）
#         .\scripts\dump-state.cmd -Label x  自己指定名字
# 兼容 Windows PowerShell 5.1 与 PowerShell 7。
param(
  [string]$Label = '',
  [int]$Port = 18080,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\samples')
)

$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$Port/state"
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

try {
  $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
} catch {
  Write-Host "读不到 $url" -ForegroundColor Red
  Write-Host "先确认：游戏开着、mod 已加载、端口和 World 配置一致（mod 侧可用 STS2_API_PORT 改端口）。" -ForegroundColor Yellow
  exit 1
}

# 桥的响应外面包了一层 { ok, request_id, data }
$state = $null
try {
  $parsed = $response.Content | ConvertFrom-Json
  if ($null -ne $parsed.data) { $state = $parsed.data } else { $state = $parsed }
} catch { }

$screen = $null
$turn = $null
$actions = 0
if ($null -ne $state) {
  $screen = $state.screen
  if (-not $screen) { $screen = $state.screenName }
  if (-not $screen) { $screen = $state.screen_name }
  $turn = $state.turn
  if ($null -eq $turn -and $state.combat) { $turn = $state.combat.turn }
  if ($state.available_actions) { $actions = @($state.available_actions).Count }
  elseif ($state.actions) { $actions = @($state.actions).Count }
}

if (-not $Label) {
  $names = @{
    'MAIN_MENU' = 'menu'; 'CHARACTER_SELECT' = 'character'; 'COMBAT' = 'combat'; 'MAP' = 'map'
    'REWARD' = 'reward'; 'CARD_REWARD' = 'card-reward'; 'SHOP' = 'shop'; 'REST' = 'rest'
    'CHEST' = 'chest'; 'EVENT' = 'event'; 'GAME_OVER' = 'game-over'; 'VICTORY' = 'victory'
    'TERMINAL' = 'game-over'; 'SELECTION' = 'select'; 'CARD_SELECT' = 'select'
  }
  if ($screen -and $names.ContainsKey($screen.ToUpper())) { $Label = $names[$screen.ToUpper()] }
  elseif ($screen) { $Label = $screen.ToLower() }
  else { $Label = 'state' }
  if ($screen -and $screen.ToUpper() -eq 'COMBAT' -and $null -ne $turn) { $Label = "$Label-t$turn" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir "$Label-$stamp.json"
# 无 BOM 的 UTF-8，避免下游 JSON 解析器被 BOM 噎住。
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $OutDir).Path + "\" + (Split-Path $file -Leaf), $response.Content, (New-Object System.Text.UTF8Encoding($false)))

$summary = '（不是合法 JSON，或结构比预期深）'
if ($null -ne $state) {
  $s = '?'
  if ($screen) { $s = $screen }
  $summary = "界面=$s  动作=$actions"
  if ($null -ne $turn) { $summary = "$summary  回合=$turn" }
}

Write-Host "已保存：$file" -ForegroundColor Green
Write-Host "摘要：$summary"
Write-Host "字节：$($response.Content.Length)"