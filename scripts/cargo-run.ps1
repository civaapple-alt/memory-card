<#
  在后台跑一次 cargo 任务并把全部输出写进日志文件。
  用法:
    pwsh -File scripts/cargo-run.ps1 -Task test
    pwsh -File scripts/cargo-run.ps1 -Task check
  为什么要单独一个脚本: Tauri 首次编译远超 120s 的命令超时上限,
  必须把它 detach 掉, 之后用 Get-Content .cargo-out.log -Tail N 轮询。
#>
param(
  [string]$Task = 'test',
  [string]$Log = ''
)
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root 'src-tauri')

if ([string]::IsNullOrWhiteSpace($Log)) {
  $Log = Join-Path $root '.cargo-out.log'
}

"=== cargo $Task  started $(Get-Date -Format 'HH:mm:ss') ===" | Out-File -Encoding utf8 $Log

& cargo $Task --color never *>> $Log
"=== EXITCODE=$LASTEXITCODE  finished $(Get-Date -Format 'HH:mm:ss') ===" | Out-File -Append -Encoding utf8 $Log
