<#
.SYNOPSIS
  最小实验：验证 DeepSeek deepseek-flash 在实际查词 prompt 下的延迟、JSON 稳定性与缓存效果。

.DESCRIPTION
  这是 docs/PRD.md §9 里"最该先做的最小实验"的落地脚本。
  它用最终要上线的 prompt 结构（固定 system 前缀 + 卡包关键词 + 待查词）发请求，报告：
    - 耗时（ms）
    - JSON 是否可解析
    - prompt_cache_hit_tokens / prompt_cache_miss_tokens
    - 返回的 confidence 与 domain_meaning
  并额外跑一次 thinking: enabled 做对照，量化"不关 thinking 会慢多少"。
  同一案例跑两次，用于观察前缀缓存是否命中。

.EXAMPLE
  pwsh scripts/probe-deepseek.ps1 -DryRun
  pwsh scripts/probe-deepseek.ps1 -ApiKey "sk-xxxx"
  $env:DEEPSEEK_API_KEY = "sk-xxxx"; pwsh scripts/probe-deepseek.ps1
#>

[CmdletBinding()]
param(
    [string]$ApiKey = $env:DEEPSEEK_API_KEY,
    [string]$BaseUrl = 'https://api.deepseek.com',
    [string]$Model = 'deepseek-flash',
    [int]$TimeoutSec = 90,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $DryRun -and [string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Error "缺少 API Key。用法：pwsh scripts/probe-deepseek.ps1 -ApiKey 'sk-xxxx'（或设置 DEEPSEEK_API_KEY 环境变量）"
    exit 2
}

# ---------------------------------------------------------------- prompt 结构
# 这一段是"稳定前缀"：同一卡包内逐字不变，用于命中 DeepSeek 的上下文缓存。
# 注意文档要求：JSON 模式下 prompt 里必须出现 "json" 字样，并给出格式示例。
$SystemPreamble = @'
你是一位面向中文程序员的技术英语释义助手。读者是中文母语、英语约 CEFR A2-B1 的开发者，正在阅读英文技术资料（GitHub、X、技术博客、源码注释）。

任务：给定一个英文词或短语，以及读者在哪个技术领域遇到它，判断它在该领域、该句子中的准确含义。

要求：
1. 必须区分"通用义"与"领域义"。当通用义会误导读者时，在 why_translation_fails 中明确指出误导点；若不构成误导，该字段留空字符串。
2. 所有释义用中文，例句保留英文原文。
3. 只输出 json，不要任何解释性文字，不要 markdown 代码块围栏。
4. 若该词在该领域不常见、或你不确定，把 confidence 设为 "low"，不要编造。
5. examples 与 collocations 每个最多 3 条。

输出 json 格式示例：
{
  "lemma": "handler",
  "pos": "n.",
  "domain_meaning": "处理请求或事件的代码单元，即被调用去响应某个输入的函数或对象",
  "general_meaning": "把手；动词义为「处理、应付」",
  "why_translation_fails": "通用词典给出「把手」，但此处 handler 指一个可被调用的实体，不是实物",
  "in_context": "在这句话里，handler 指处理该请求的那个函数",
  "examples": ["the request handler returns a promise"],
  "collocations": ["request handler", "error handler"],
  "confidence": "high"
}
'@

$Cases = @(
    @{
        Deck     = 'Rust 后端'
        Keywords = 'rust, tokio, async, ownership, borrow'
        Term     = 'handle'
        Sentence = 'the runtime spawns a task and returns a handle you can await'
    },
    @{
        Deck     = 'AI·LLM'
        Keywords = 'llm, transformer, embedding, inference, prompt, context window'
        Term     = 'token'
        Sentence = 'the context window is limited by the number of tokens'
    },
    @{
        Deck     = 'GitHub 协作黑话'
        Keywords = 'git, github, pull request, code review, ci'
        Term     = 'nit'
        Sentence = 'nit: rename this variable to make it clearer'
    },
    @{
        Deck     = 'GitHub 协作黑话'
        Keywords = 'git, github, pull request, code review, ci'
        Term     = 'ship it'
        Sentence = 'LGTM, ship it'
    }
)

function New-ChatBody {
    param(
        [hashtable]$Case,
        [bool]$ThinkingEnabled,
        [int]$MaxTokens = 1200
    )

    # 卡包范围声明：同一卡包内稳定，紧跟固定前缀之后，一起构成可缓存前缀。
    $deckScope = @"
当前领域范围关键词：$($Case.Keywords)
读者正在这个技术范围内阅读，请按该范围解释下面的内容。
"@

    $userPrompt = @"
term: $($Case.Term)
sentence: $($Case.Sentence)

请输出 json。
"@

    $body = [ordered]@{
        model    = $Model
        messages = @(
            [ordered]@{ role = 'system'; content = $SystemPreamble }
            [ordered]@{ role = 'system'; content = $deckScope }
            [ordered]@{ role = 'user';   content = $userPrompt }
        )
        # 关键：默认 thinking 是开的且 effort=high，查询类任务必须显式关掉。
        thinking        = [ordered]@{ type = $(if ($ThinkingEnabled) { 'enabled' } else { 'disabled' }) }
        # temperature 只在非 thinking 模式下生效（thinking 模式会静默忽略）。
        temperature     = 0.3
        max_tokens      = $MaxTokens
        response_format = [ordered]@{ type = 'json_object' }
        stream          = $false
    }

    if ($ThinkingEnabled) {
        $body['reasoning_effort'] = 'high'
        $body.Remove('temperature')
    }

    return ($body | ConvertTo-Json -Depth 10 -Compress)
}

function Invoke-ProbeOnce {
    param(
        [hashtable]$Case,
        [bool]$ThinkingEnabled,
        [string]$Label
    )

    $json = New-ChatBody -Case $Case -ThinkingEnabled $ThinkingEnabled
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        $resp = Invoke-RestMethod `
            -Uri "$BaseUrl/chat/completions" `
            -Method Post `
            -TimeoutSec $TimeoutSec `
            -Headers @{ Authorization = "Bearer $ApiKey" } `
            -ContentType 'application/json' `
            -Body $json
        $ms = $sw.ElapsedMilliseconds

        $content = $resp.choices[0].message.content
        $parsed = $null
        $parseOk = $false
        if (-not [string]::IsNullOrWhiteSpace($content)) {
            try { $parsed = $content | ConvertFrom-Json; $parseOk = $true } catch { $parseOk = $false }
        }

        [pscustomobject]@{
            Label        = $Label
            Deck         = $Case.Deck
            Term         = $Case.Term
            Thinking     = $ThinkingEnabled
            Ms           = $ms
            ParseOk      = $parseOk
            EmptyContent = [string]::IsNullOrWhiteSpace($content)
            CacheHit     = $resp.usage.prompt_cache_hit_tokens
            CacheMiss    = $resp.usage.prompt_cache_miss_tokens
            OutTokens    = $resp.usage.completion_tokens
            Confidence   = if ($parseOk) { $parsed.confidence } else { '-' }
            DomainAnswer = if ($parseOk) { $parsed.domain_meaning } else { "-" }
        }
    }
    catch {
        [pscustomobject]@{
            Label        = $Label
            Deck         = $Case.Deck
            Term         = $Case.Term
            Thinking     = $ThinkingEnabled
            Ms           = $sw.ElapsedMilliseconds
            ParseOk      = $false
            EmptyContent = $false
            CacheHit     = $null
            CacheMiss    = $null
            OutTokens    = $null
            Confidence   = 'ERROR'
            DomainAnswer = "请求失败: $($_.Exception.Message)"
        }
    }
}

# ------------------------------------------------------------------- dry run
if ($DryRun) {
    $sample = New-ChatBody -Case $Cases[0] -ThinkingEnabled $false
    Write-Host '=== 非 thinking 模式请求体（案例 1）===' -ForegroundColor Cyan
    ($sample | ConvertFrom-Json | ConvertTo-Json -Depth 10)
    Write-Host ''
    $sampleT = New-ChatBody -Case $Cases[0] -ThinkingEnabled $true
    Write-Host '=== thinking 模式请求体（案例 1，对照）===' -ForegroundColor Cyan
    ($sampleT | ConvertFrom-Json | ConvertTo-Json -Depth 10)
    Write-Host ''
    Write-Host '未发送任何请求（-DryRun）。去掉 -DryRun 并传入 -ApiKey 即可实测。' -ForegroundColor Yellow
    exit 0
}

# -------------------------------------------------------------------- 实测
Write-Host "模型: $Model    端点: $BaseUrl" -ForegroundColor Cyan
Write-Host '第 1 轮：非 thinking 模式，每个案例跑两次（第二次用于观察前缀缓存）' -ForegroundColor Cyan

$results = @()

foreach ($case in $Cases) {
    $results += Invoke-ProbeOnce -Case $case -ThinkingEnabled $false -Label "pass1-$($case.Term)"
    $results += Invoke-ProbeOnce -Case $case -ThinkingEnabled $false -Label "pass2-$($case.Term)"
}

Write-Host ''
Write-Host '第 2 轮：thinking 模式对照（仅案例 1）' -ForegroundColor Cyan
$results += Invoke-ProbeOnce -Case $Cases[0] -ThinkingEnabled $true -Label 'thinking-on-handle'

# ------------------------------------------------------------------- 报告
Write-Host ''
Write-Host '================ 逐次结果 ================' -ForegroundColor Green
$results |
    Select-Object Label, Thinking, Ms, ParseOk, EmptyContent, CacheHit, CacheMiss, OutTokens, Confidence |
    Format-Table -AutoSize

Write-Host '================ 释义内容（非 thinking）================' -ForegroundColor Green
$results |
    Where-Object { -not $_.Thinking -and $_.Label -like 'pass1-*' } |
    ForEach-Object {
        Write-Host ("[{0} / {1}]" -f $_.Deck, $_.Term) -ForegroundColor Yellow
        Write-Host ("  " + $_.DomainAnswer)
    }

Write-Host ''
Write-Host '================ 判定 ================' -ForegroundColor Green

$nonThinking = $results | Where-Object { -not $_.Thinking }
$okOnes      = @($nonThinking | Where-Object { $_.ParseOk })
$avgMs       = if ($okOnes.Count -gt 0) { [int](($okOnes | Measure-Object Ms -Average).Average) } else { 'n/a' }

Write-Host ("非 thinking 成功解析: {0}/{1}" -f $okOnes.Count, $nonThinking.Count)
Write-Host ("非 thinking 平均耗时: {0} ms" -f $avgMs)

$secondPass  = @($nonThinking | Where-Object { $_.Label -like 'pass2-*' })
$anyCacheHit = @($secondPass | Where-Object { $_ -and $_.CacheHit -gt 0 })
if ($anyCacheHit.Count -gt 0) {
    Write-Host ("前缀缓存: 已命中（第二次最大命中 {0} tokens）" -f (($secondPass | Measure-Object CacheHit -Maximum).Maximum))
} else {
    Write-Host '前缀缓存: 未命中。文档说明缓存建立需要数秒、生命周期几小时到几天，同一进程内连续两次通常不足以建立。' -ForegroundColor Yellow
}

$thinkOn = @($results | Where-Object { $_.Label -eq 'thinking-on-handle' })
if ($thinkOn.Count -gt 0) {
    $baseMs = ($okOnes | Where-Object { $_.Term -eq 'handle' } | Select-Object -First 1).Ms
    if ($baseMs) {
        Write-Host ("thinking 对照: {0} ms  vs  非 thinking {1} ms  —— 慢 {2}x" -f $thinkOn[0].Ms, $baseMs, [math]::Round($thinkOn[0].Ms / [math]::Max($baseMs, 1), 1)) -ForegroundColor Magenta
    }
}

Write-Host ''
Write-Host '把上面的表格贴回来，即可据此决定：prompt 是否要拆小、超时设多少、是否要加本地术语表前置命中。'
