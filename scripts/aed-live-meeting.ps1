$ErrorActionPreference = 'Stop'
$cmdPath = $env:AED_LIVE_CMD
$appFolder = Split-Path -Parent $cmdPath
$exePath = Join-Path $appFolder 'AED Translator.exe'
$hostPath = Join-Path $appFolder 'resources/resources/bin/win32-x64/sokuji-audio-host.exe'
$userDataPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Sokuji'
$startUtc = [DateTime]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
$target = [Environment]::GetFolderPath('DesktopDirectory')
if ($env:AED_LIVE_QA_OUTPUT -and [IO.Directory]::Exists($env:AED_LIVE_QA_OUTPUT)) { $target = $env:AED_LIVE_QA_OUTPUT }
$name = 'AED-Teams-Live-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.txt'
$reportPath = Join-Path $target $name
$utf8 = [Text.UTF8Encoding]::new($true)
try { $writer = [IO.StreamWriter]::new($reportPath, $false, $utf8) }
catch { $reportPath = Join-Path $appFolder $name; $writer = [IO.StreamWriter]::new($reportPath, $false, $utf8) }
$writer.AutoFlush = $true

function Write-LiveEvent([string]$Kind, $Data) {
    $line = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); elapsedMs = $clock.ElapsedMilliseconds; kind = $Kind; data = $Data }
    $writer.WriteLine((ConvertTo-Json -InputObject $line -Depth 10 -Compress))
}

function Test-LiveFinishKey {
    try {
        while ([Console]::KeyAvailable) {
            if ([Console]::ReadKey($true).Key -in @('Enter','Q')) { return $true }
        }
    } catch { } # Redirected stdin in unattended validation.
    return $false
}

# AED_LIVE_FUNCTIONS

$backend = New-AedBackendState
$matcher = New-AedLiveCaptionMatcherState
$matcher.MonitorStartedAtUtc = $startUtc
$reason = 'interrupted'
$mutex = [Threading.Mutex]::new($false, 'Local\AEDTranslatorLiveMeetingDiagnostic')
$owned = $false
$seenRunning = $false
$wasAttached = $false
$lastPhase = ''
$lastAgent = ''
$lastInputsAt = -10000
$refreshInputs = $false
$lastStatusLine = -15000
$lastLogTry = -10000
$initStarted = $false
$unavailableSince = $null
$idleSince = $null
$finishRequestedAt = $null
$changedLogging = $false
$inputs = $null
$history = $null
$lastMeasuredCaptions = $null
$sampleCount = 0
$sourceCounts = @{}
$maxSystem = $null
$systemSamples = 0
$teamsPeak = $null
$teamsAudibleWindowsPolls = 0
$attachedPolls = 0
$windowsBoth = @{ teamsAudiblePolls = 0; teamsAudibleSystemMeterAvailable = 0; teamsAudibleSystemSelected = 0 }
$lastScope = 'unknown'
$lastCaptionKey = ''
$historyConfirmed = $false

function Write-LiveSummary([string]$Kind, [string]$Finish) {
    $meetingOverlap = if ($seenRunning) { $windowsBoth } else { $null }
    Write-LiveEvent $Kind ([ordered]@{
        finish = $Finish; samples = $sampleCount; attachedPolls = $attachedPolls; systemMeterSamples = $systemSamples
        maxSystemPeak = $maxSystem; maxTeamsSessionPeak = $teamsPeak; windowsTeamsAudiblePolls = $teamsAudibleWindowsPolls
        observedOnlineRunning = $seenRunning; boundMeetingHistory = $historyConfirmed; sourcePollCounts = $sourceCounts
        teamsAudibleThreshold = 0.012; simultaneousRunningPolls = $meetingOverlap; lastCaptionCheck = $history
        lastMeasuredCaptionCounts = $lastMeasuredCaptions.counts; enabledPersistentDiagnostics = $changedLogging
    })
}

try {
    $owned = $mutex.WaitOne(0)
    if (-not $owned) { throw 'Another live meeting diagnostic is already running.' }
    Write-LiveEvent 'start' ([ordered]@{ revision = '__AED_VERSION__-live-r1'; powershellVersion = $PSVersionTable.PSVersion.ToString(); output = 'metadata only'; systemMeter = 'Windows default playback output'; captionEvidence = 'two source legs in current AED online meeting after monitor start' })
    Write-Host ('报告位置  ' + $reportPath)
    Write-Host '在线会议请选择「两者」，对方音频默认使用系统声音。脚本也会同时测量 Windows 扬声器电平。'
    Write-Host '照常开 Teams 会议。结束 AED 会话后报告会自动保存，也可以回到这个窗口按回车提前收尾。'
    if (-not [IO.File]::Exists($exePath)) { throw 'Place this CMD next to AED Translator.exe and run it again.' }
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
    if ($info.ProductName -ne 'AED Translator') { throw 'The adjacent executable is not AED Translator.' }
    Write-LiveEvent 'executable' @{ version = $info.ProductVersion }
    while ($true) {
        $iteration = $clock.ElapsedMilliseconds
        $status = $null
        $captionPhase = $null
        $agent = 'attached'
        try { $status = Invoke-AedLiveAgent status } catch {
            $agent = switch ($_.Exception.Message) {
                'control_off' { 'control_off' }
                'stale_control_owner' { 'stale_control_owner' }
                'different_executable' { 'different_executable' }
                'control_owner_path_unknown' { 'control_owner_path_unknown' }
                default { 'agent_unavailable' }
            }
        }
        if (-not $status) {
            $inputs = $null
            $lastScope = 'unknown'
            if ($null -eq $unavailableSince) { $unavailableSince = $iteration }
            $existing = @(Get-Process -Name 'AED Translator','sokuji' -ErrorAction SilentlyContinue)
            $sameApp = @($existing | Where-Object { $_.Path -ieq $exePath }).Count -gt 0
            if ($sameApp -or $historyConfirmed) { $captionPhase = 'unverified' }
            if (-not $initStarted -and -not $wasAttached -and -not $historyConfirmed) {
                if ($sameApp) {
                    Start-Process -FilePath $exePath -WorkingDirectory $appFolder -ArgumentList '--meeting-diagnostics' -WindowStyle Hidden
                    $initStarted = $true
                    $agent = 'attaching_existing_instance'
                } elseif (-not $existing.Count) {
                    # Visible because the user starts their actual interactive meeting in this window.
                    Start-Process -FilePath $exePath -WorkingDirectory $appFolder -ArgumentList '--meeting-diagnostics'
                    $initStarted = $true
                    $agent = 'opening_existing_profile'
                }
            }
            if ($agent -ne $lastAgent) {
                Write-LiveEvent 'connection' @{ state = $agent }
                if (-not $wasAttached -and -not $initStarted) {
                    Write-Host '诊断尚未连接。请确认本 CMD 和你正在使用的 AED 在同一目录。当前仅能记录 Windows 电平和可用的本场字幕。'
                } elseif ($wasAttached) { Write-Host 'AED 诊断连接中断，Windows 电平仍在采样。' }
            }
            # Lost transitions are not evidence of an active backend after reconnect.
            if ($lastAgent -eq 'attached') { $backend = New-AedBackendState }
        } else {
            $attachedPolls++
            $unavailableSince = $null
            if ($lastAgent -ne 'attached') {
                Write-LiveEvent 'connection' @{ state = 'attached'; version = $status.appVersion; initialDiagnosticLogs = $status.diagnosticLogsEnabled }
                Write-Host ('已连上 AED ' + $status.appVersion)
                $lastInputsAt = -10000
            }
            $wasAttached = $true
            $active = $status.appMode -eq 'meeting' -and $status.phase -in @('starting','running','stopping')
            if ($status.phase -eq 'running' -and $active) { $seenRunning = $true }
            if ($seenRunning -and $status.phase -eq 'idle') {
                if ($null -eq $idleSince) { $idleSince = $iteration }
            } else { $idleSince = $null }
            if ($lastPhase -ne ($status.appMode + '/' + $status.phase)) {
                Write-LiveEvent 'phase' @{ mode = $status.appMode; phase = $status.phase; legs = $status.audioMode }
                if ($status.phase -eq 'starting') { $backend.mic = $backend.participant = 'unknown' }
                $lastInputsAt = -10000
                $lastPhase = $status.appMode + '/' + $status.phase
            }
            if ($status.appReady -and $active -and -not $status.diagnosticLogsEnabled -and ($iteration - $lastLogTry -ge 10000)) {
                $lastLogTry = $iteration
                try {
                    $enabled = Invoke-AedLiveAgent 'logs.enable'
                    if ($enabled.enabled) { $changedLogging = $true; Write-LiveEvent 'logging' @{ enabledByMonitor = $true; persistent = $true } }
                } catch { Write-LiveEvent 'unavailable' @{ component = 'logs.enable' } }
            }
            if ($refreshInputs -or $iteration - $lastInputsAt -ge 3000) {
                $refreshInputs = $false
                try {
                    $inputs = Invoke-AedLiveAgent 'audio.inputs'
                    $p = $inputs.participantSource
                    Write-LiveEvent 'source' ([ordered]@{ devicesLoaded = $inputs.devicesLoaded; scope = $p.scope; configured = $p.label; widened = $inputs.participantCaptureWidened; participantPcm = $inputs.participantPcmRuntime; mic = $inputs.meetingInput.label; micVirtual = $inputs.meetingInput.virtual; muted = $inputs.meetingMicMuted; echoMode = $inputs.microphoneEchoMode; route = $inputs.speechRoutes })
                    if ($active -and $p.scope -and $inputs.devicesLoaded -ne $false) {
                        $source = [string]$p.scope
                        $sourceCounts[$source] = 1 + [int]$sourceCounts[$source]
                    }
                    $lastScope = [string]$p.scope
                } catch {
                    $inputs = $null
                    $lastScope = 'unknown'
                    Write-LiveEvent 'unavailable' @{ component = 'audio.inputs' }
                }
                $lastInputsAt = $iteration
            }
            try {
                $logs = Invoke-AedLiveAgent 'logs.list' @{ limit = 100 }
                Update-AedBackendState $backend $logs.events -Baseline:(-not $backend.initialized -or (-not $active -and -not $seenRunning))
            } catch {
                $backend = New-AedBackendState
                Write-LiveEvent 'unavailable' @{ component = 'logs.list' }
            }
            if ($status.appMode -eq 'meeting' -or $seenRunning) { $captionPhase = $status.phase }
        }
        if ($captionPhase) {
            try {
                $history = Get-AedLiveHistoryDiagnostics -UserDataPath $userDataPath -SessionPhase $captionPhase -MonitorStartedAtUtc $startUtc -State $matcher
                if ($null -ne $history.counts) { $lastMeasuredCaptions = $history }
                if ($matcher.PinnedRecordId) { $historyConfirmed = $true }
                $captionKey = '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $history.status,$history.reason,$history.recordState,$history.counts.finalRows,$history.counts.crossRoleMatches,$history.counts.sourceRows,$history.counts.comparablePairs
                if ($captionKey -ne $lastCaptionKey) { Write-LiveEvent 'caption_check' $history; $lastCaptionKey = $captionKey }
                if (-not $status -and $historyConfirmed -and $history.recordState -eq 'closed' -and $null -eq $idleSince) { $idleSince = $iteration }
            } catch { $history = $null; Write-LiveEvent 'unavailable' @{ component = 'caption_check'; reason = $_.Exception.GetType().Name } }
        }
        $lastAgent = $agent
        $meter = $null
        try { $meter = Get-AedLiveSystemMeterSample -AudioHostPath $hostPath }
        catch { Write-LiveEvent 'unavailable' @{ component = 'windows_meter'; reason = $_.Exception.GetType().Name } }
        if ($meter.SystemRender.Available -and $null -ne $meter.SystemRender.Peak) {
            $systemSamples++
            if ($null -eq $maxSystem -or $meter.SystemRender.Peak -gt $maxSystem) { $maxSystem = $meter.SystemRender.Peak }
        }
        $audibleTeams = $false
        foreach ($t in $meter.TeamsRenderSessions.Sessions) {
            if ($null -ne $t.Peak -and ($null -eq $teamsPeak -or $t.Peak -gt $teamsPeak)) { $teamsPeak = $t.Peak }
            if ($t.Peak -ge 0.012) { $audibleTeams = $true }
        }
        if ($audibleTeams) { $teamsAudibleWindowsPolls++ }
        if ($audibleTeams -and $status.appMode -eq 'meeting' -and $status.phase -eq 'running') {
            $windowsBoth.teamsAudiblePolls++
            if ($meter.SystemRender.Available) { $windowsBoth.teamsAudibleSystemMeterAvailable++ }
            if ($inputs.participantSource.scope -eq 'system') { $windowsBoth.teamsAudibleSystemSelected++ }
        }
        $sampleCount++
        $sourceAge = if ($inputs) { $clock.ElapsedMilliseconds - $lastInputsAt } else { $null }
        Write-LiveEvent 'sample' ([ordered]@{ phase = $status.phase; legMode = $status.audioMode; source = $inputs.participantSource.scope; sourceAgeMs = $sourceAge; widened = $inputs.participantCaptureWidened; systemOutputForm = $inputs.systemOutputForm; configuredBrowserEchoMode = $inputs.microphoneEchoMode; micConstraint = $backend.mic; captureBackend = $backend.participant; windows = $meter })
        if ($iteration - $lastStatusLine -ge 15000) {
            Write-Host ('Samples: {0} | AED: {1} {2} | source: {3} | system peak: {4}' -f $sampleCount,$agent,$status.phase,$lastScope,$meter.SystemRender.Peak)
            $lastStatusLine = $iteration
        }
        if ($null -ne $idleSince -and $idleSince -eq $iteration) {
            Write-LiveSummary 'checkpoint' 'session_ended_awaiting_final_captions'
        }
        if ($null -ne $idleSince -and $iteration - $idleSince -ge 6000) { $reason = 'AED_session_finished'; break }
        if ($wasAttached -and $null -ne $unavailableSince -and $iteration - $unavailableSince -ge 12000 -and -not (Get-Process -Name 'AED Translator','sokuji' -ErrorAction SilentlyContinue)) { $reason = 'AED_closed'; break }
        if ($null -eq $finishRequestedAt -and (Test-LiveFinishKey)) {
            $finishRequestedAt = $clock.ElapsedMilliseconds
            Write-Host '正在收尾，等最后几条字幕写入。'
        }
        if ($null -ne $finishRequestedAt -and $iteration - $finishRequestedAt -ge 3000) { $reason = 'user_finished'; break }
        if ($env:AED_LIVE_QA_SECONDS -as [int] -and $clock.Elapsed.TotalSeconds -ge [int]$env:AED_LIVE_QA_SECONDS) { $reason = 'timed_smoke_test'; break }
        $delay = [int](1500 - ($clock.ElapsedMilliseconds - $iteration))
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    }
} catch {
    $reason = 'monitor_error'
    $message = $_.Exception.Message
    Write-Host $message
    $safeReason = switch ($message) {
        'Another live meeting diagnostic is already running.' { 'monitor_already_running' }
        'Place this CMD next to AED Translator.exe and run it again.' { 'adjacent_AED_missing' }
        'The adjacent executable is not AED Translator.' { 'unexpected_executable' }
        default { 'runtime_error' }
    }
    Write-LiveEvent 'error' @{ reason = $safeReason; category = $_.Exception.GetType().Name; line = $_.InvocationInfo.ScriptLineNumber }
} finally {
    Write-LiveSummary 'summary' $reason
    $writer.Dispose()
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    if ($changedLogging) { Write-Host '本次开启的应用诊断日志会保持开启，可在「设置 → 通用」关闭。' }
    Write-Host ('报告已保存  ' + $reportPath)
}
if ($reason -eq 'monitor_error') { exit 1 }
