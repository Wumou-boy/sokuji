$ErrorActionPreference = 'Stop'
$initialLibPath = $env:LIB
. (Join-Path $PSScriptRoot 'aed-live-caption-match.ps1')

function Assert-Equal {
    param([string]$Name, [object]$Actual, [object]$Expected)
    if ($Actual -ne $Expected) { throw "$Name failed: expected '$Expected', got '$Actual'" }
}

function New-TestCaption {
    param([string]$Id, [string]$Role, [string]$Text, [long]$At)
    return [pscustomobject]@{
        id = $Id
        role = $Role
        openedAt = $At
        source = [pscustomobject]@{ text = $Text; final = $true }
    }
}

function Invoke-TestCaptions {
    param([object[]]$Items, [int]$WindowSeconds = 20)
    $state = New-AedLiveCaptionMatcherState -WindowSeconds $WindowSeconds
    $poll = [DateTimeOffset]::FromUnixTimeMilliseconds(100000).UtcDateTime
    return Add-AedLiveCaptionPoll -State $state -Items $Items -PollUtc $poll
}

$cases = 0

$emptyState = New-AedLiveCaptionMatcherState
$emptyResult = Add-AedLiveCaptionPoll -State $emptyState -Items @() -PollUtc ([DateTimeOffset]::FromUnixTimeMilliseconds(100000).UtcDateTime)
Assert-Equal 'empty poll returns with no rows' $emptyResult.counts.rows 0
Assert-Equal 'empty poll increments poll counter' $emptyResult.counts.polls 1
$cases++

# Exact same source sentence across roles.
$exact = Invoke-TestCaptions @(
    (New-TestCaption 's1' 'speaker' '我们现在开始讨论这个项目的实施计划和时间安排' 100000)
    (New-TestCaption 'p1' 'participant' '我们现在开始讨论这个项目的实施计划和时间安排' 101000)
)
Assert-Equal 'exact match detected' $exact.counts.matches 1
Assert-Equal 'exact pair comparable' ($exact.counts.comparablePairs -gt 0) $true
Assert-Equal 'caption text omitted from returned diagnostics' ((ConvertTo-Json -InputObject $exact -Depth 8 -Compress).Contains('我们现在开始讨论')) $false
$cases++

# A meaningful shorter source phrase is contained in a differently grouped full sentence.
$contained = Invoke-TestCaptions @(
    (New-TestCaption 's2' 'speaker' '我们现在开始讨论这个重要项目的实施计划和时间安排' 100000)
    (New-TestCaption 'p2' 'participant' '开始讨论这个重要项目的实施计划' 101000)
)
Assert-Equal 'short phrase containment detected' ($contained.counts.matches -gt 0) $true
$cases++

# Two adjacent participant source segments reassemble to the speaker source sentence.
$segmented = Invoke-TestCaptions @(
    (New-TestCaption 's3' 'speaker' '我们现在开始讨论这个重要项目的安排' 100000)
    (New-TestCaption 'p3a' 'participant' '我们现在开始讨论' 100500)
    (New-TestCaption 'p3b' 'participant' '这个重要项目的安排' 101500)
)
Assert-Equal 'split/merged source detected' ($segmented.counts.matches -gt 0) $true
Assert-Equal 'split or segmentation evidence reported' (@($segmented.evidence | Where-Object { $_.method -in @('segmented','contained') }).Count -gt 0) $true
$cases++

# Interleaved role rows must not prevent adjacent same-role pieces from being joined.
$interleaved = Invoke-TestCaptions @(
    (New-TestCaption 'p4a' 'participant' '今天我们开始讨论' 100000)
    (New-TestCaption 's4a' 'speaker' '今天我们开始' 100100)
    (New-TestCaption 'p4b' 'participant' '新的项目计划和安排' 100800)
    (New-TestCaption 's4b' 'speaker' '新的项目计划和安排' 101000)
)
Assert-Equal 'interleaved split/merge detected' ($interleaved.counts.matches -gt 0) $true
$cases++

# A, full AB, B ordering: the two short pieces are each below the minimum length,
# but same-role adjacency across the inserted opposite-role segment reconstructs AB.
$abc = Invoke-TestCaptions @(
    (New-TestCaption 'p9a' 'participant' '今天会议' 100000)
    (New-TestCaption 's9' 'speaker' '今天会议开始吧' 100400)
    (New-TestCaption 'p9b' 'participant' '开始吧' 100800)
)
Assert-Equal 'A-AB-B short split reconstructed' $abc.counts.matches 1
Assert-Equal 'A-AB-B counted as one physical suspected event' $abc.counts.suspectedPairs 1
Assert-Equal 'A-AB-B segmented method reported' (@($abc.evidence | Where-Object { $_.method -eq 'segmented' }).Count -eq 1) $true
$cases++

# When A alone also overlaps the intact AB, adding B must not count the same event again.
$deduplicated = Invoke-TestCaptions @(
    (New-TestCaption 'p10a' 'participant' '我们今天讨论' 100000)
    (New-TestCaption 's10' 'speaker' '我们今天讨论项目安排问题' 100400)
    (New-TestCaption 'p10b' 'participant' '项目安排问题' 100800)
)
Assert-Equal 'overlapping segment alternatives reported once' $deduplicated.counts.suspectedPairs 1
$cases++

# A short but informative Chinese utterance is counted; common short acknowledgements stay excluded.
$short = Invoke-TestCaptions @(
    (New-TestCaption 's5' 'speaker' '会议开始了' 100000)
    (New-TestCaption 'p5' 'participant' '会议开始了' 100500)
)
Assert-Equal 'short informative sentence detected' ($short.counts.matches -gt 0) $true
$shortNear = Invoke-TestCaptions @(
    (New-TestCaption 's5n' 'speaker' '会议开始了' 100000)
    (New-TestCaption 'p5n' 'participant' '会议开始啦' 100500)
)
Assert-Equal 'short near sentence detected' ($shortNear.counts.matches -gt 0) $true
$ack = Invoke-TestCaptions @(
    (New-TestCaption 's6' 'speaker' '好的' 100000)
    (New-TestCaption 'p6' 'participant' '好的' 100500)
)
Assert-Equal 'short acknowledgement ignored' $ack.counts.matches 0
Assert-Equal 'unusable short phrases give no evidence of clean audio' $ack.status 'insufficient_data'
Assert-Equal 'acknowledgement not eligible' $ack.counts.eligible 0
$cases++

# ASR may emit a final containing punctuation only.
$punctuation = Invoke-TestCaptions @(
    (New-TestCaption 'p-punctuation' 'participant' '……！' 100000)
    (New-TestCaption 's-after' 'speaker' '请打开测试文档' 100500)
)
Assert-Equal 'punctuation-only final does not interrupt later rows' $punctuation.counts.finals 1
$cases++

# Timing window still blocks temporally unrelated identical source text.
$outsideWindow = Invoke-TestCaptions -WindowSeconds 5 -Items @(
    (New-TestCaption 's7' 'speaker' '我们现在开始讨论这个项目的实施计划和时间安排' 100000)
    (New-TestCaption 'p7' 'participant' '我们现在开始讨论这个项目的实施计划和时间安排' 106000)
)
Assert-Equal 'outside time window not comparable' $outsideWindow.counts.comparablePairs 0
Assert-Equal 'disjoint speech windows are inconclusive' $outsideWindow.status 'insufficient_data'
Assert-Equal 'outside time window not suspected' $outsideWindow.counts.suspectedPairs 0
$cases++

# Simultaneous unrelated captions are comparable, but should not be reported as a suspected match.
$overlap = Invoke-TestCaptions @(
    (New-TestCaption 's8' 'speaker' '请把最新测试结果发给我确认一下' 100000)
    (New-TestCaption 'p8' 'participant' '今天我们主要讨论项目预算和人员安排' 100300)
)
Assert-Equal 'overlapping unrelated pair counted comparable' ($overlap.counts.comparablePairs -gt 0) $true
Assert-Equal 'overlapping unrelated pair not suspected' $overlap.counts.suspectedPairs 0
$cases++

# A full 100-row state remains bounded: old source rows outside the temporal window
# are not sent through phrase-group construction and string similarity checks.
$manyRows = New-Object System.Collections.ArrayList
for ($index = 0; $index -lt 50; $index++) {
    $at = 100000 + ($index * 1000)
    [void]$manyRows.Add((New-TestCaption "s$index" 'speaker' "请复核会议计划编号$index" $at))
    [void]$manyRows.Add((New-TestCaption "p$index" 'participant' "当前版本人员预算安排编号$index" ($at + 200)))
}
$timer = [Diagnostics.Stopwatch]::StartNew()
$fullState = Invoke-TestCaptions -Items $manyRows.ToArray()
$timer.Stop()
Assert-Equal '100 finalized rows processed' $fullState.counts.finals 100
Assert-Equal '100-row comparable set stayed bounded' ($fullState.counts.comparablePairs -lt 10000) $true
Assert-Equal '100-row synthetic run completed under 15 seconds' ($timer.Elapsed.TotalSeconds -lt 15) $true
Write-Output ("100-row synthetic elapsed: {0:N2}s; comparable source pairs: {1}" -f $timer.Elapsed.TotalSeconds, $fullState.counts.comparablePairs)
$cases++

Assert-Equal 'process LIB environment restored' $env:LIB $initialLibPath
Write-Output "PASS: $cases synthetic caption matching cases"
