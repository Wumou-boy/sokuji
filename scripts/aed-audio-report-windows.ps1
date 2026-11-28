# Windows-only, read-only evidence helpers for the one-shot AED audio report.
# Requires the caller to define Add-Line, Get-RenderInventory, $hostPath,
# $playerProcess and $env. This file never starts AED or a playback process.

function ConvertTo-AedSafeLabel {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '(unavailable)' }
    $clean = [regex]::Replace($Value, '[^\p{L}\p{N} _().,+&-]', '?')
    $clean = [regex]::Replace($clean, '\s+', ' ').Trim()
    if ($clean.Length -gt 80) { $clean = $clean.Substring(0, 80) }
    return $clean
}

function Get-AedProcessCategory {
    param([AllowNull()][string]$Exe)
    $base = [IO.Path]::GetFileName($Exe).ToLowerInvariant()
    switch -Regex ($base) {
        '^(teams|ms-teams|msteams)\.exe$' { return 'meeting:teams' }
        '^zoom(\.exe)?$' { return 'meeting:zoom' }
        '^(webex|webexmta|webexhost)\.exe$' { return 'meeting:webex' }
        '^(chrome|msedge|firefox|brave|opera)\.exe$' { return 'browser' }
        '^(vlc|wmplayer|music|spotify|foobar2000|mpc-hc|mpc-be)\.exe$' { return 'player' }
        '^sokuji(-audio-host)?\.exe$' { return 'aed' }
        default { return 'other' }
    }
}

function Invoke-AedHostJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = [ordered]@{ Ok = $false; Rows = @(); Error = 'unavailable' }
    $process = $null
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $script:hostPath
        $start.Arguments = ($Arguments -join ' ')
        $start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $start
        if (-not $process.Start()) { throw 'helper_start_failed' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(5000)) {
            throw 'helper_timeout'
        }
        if (-not $stdoutTask.Wait(2000) -or -not $stderrTask.Wait(2000)) { throw 'helper_read_timeout' }
        $outText = $stdoutTask.Result
        $null = $stderrTask.Result
        if ($process.ExitCode -ne 0) { $result.Error = 'helper_exit_nonzero'; return [pscustomobject]$result }
        $parsed = ConvertFrom-Json -InputObject $outText -ErrorAction Stop
        $result.Ok = $true
        $result.Rows = @($parsed)
        $result.Error = $null
    }
    catch [System.TimeoutException] {
        $result.Error = 'helper_timeout'
    }
    catch [System.ComponentModel.Win32Exception] {
        $result.Error = 'helper_start_failed'
    }
    catch {
        $result.Error = 'helper_failed'
    }
    finally {
        if ($process) {
            try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(1000) } } catch { }
            $process.Dispose()
        }
    }
    return [pscustomobject]$result
}

function Invoke-AedPcmProbe {
    param(
        [Parameter(Mandatory)][string]$Target,
        [ValidateRange(100, 2000)][int]$DurationMs = 800
    )
    # This helper's stdout is PCM, so read it as bytes. No audio is written to disk,
    # exported, logged, or passed to another process. The captured buffer is discarded.
    $result = [ordered]@{ Ok = $false; Bytes = 0; Rms = $null; Peak = $null; SampleRate = $null; Channels = $null; Encoding = $null; Error = 'unavailable' }
    $proc = $null
    $memory = New-Object System.IO.MemoryStream
    $readTask = $null
    $stderrTask = $null
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $script:hostPath
        $start.Arguments = "--target $Target"
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $start
        if (-not $proc.Start()) { throw 'helper_start_failed' }
        $stdout = $proc.StandardOutput.BaseStream
        $readTask = $stdout.CopyToAsync($memory)
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        Start-Sleep -Milliseconds $DurationMs
        try { $proc.Kill() } catch { }
        if (-not $proc.WaitForExit(2000)) { $result.Error = 'capture_stop_timeout'; return [pscustomobject]$result }
        try {
            if (-not $readTask.Wait(2000) -or -not $stderrTask.Wait(1000)) { $result.Error = 'capture_read_timeout'; return [pscustomobject]$result }
        } catch { $result.Error = 'capture_read_failed'; return [pscustomobject]$result }
        $stderr = ''
        try { $stderr = $stderrTask.Result } catch { }
        foreach ($line in ($stderr -split "`r?`n")) {
            if ($line.Length -gt 512) { continue }
            try {
                $event = ConvertFrom-Json -InputObject $line -ErrorAction Stop
                if ($event.event -eq 'format' -and $event.sampleRate -eq 24000 -and $event.channels -eq 1 -and $event.encoding -eq 's16le') {
                    $result.SampleRate = 24000; $result.Channels = 1; $result.Encoding = 's16le'
                }
                elseif ($event.event -eq 'error' -and [string]$event.code -match '^[a-z_]{1,48}$') {
                    $result.Error = [string]$event.code
                }
            } catch { }
        }
        $bytes = $memory.ToArray()
        $result.Bytes = $bytes.Length - ($bytes.Length % 2)
        if ($result.Bytes -gt 0 -and $result.SampleRate -eq 24000) {
            $sum = 0.0; $peak = 0.0
            for ($i = 0; $i -lt $result.Bytes; $i += 2) {
                $sample = [BitConverter]::ToInt16($bytes, $i) / 32768.0
                $magnitude = [Math]::Abs($sample)
                $sum += $sample * $sample
                if ($magnitude -gt $peak) { $peak = $magnitude }
            }
            $result.Rms = [Math]::Round([Math]::Sqrt($sum / ($result.Bytes / 2)), 6)
            $result.Peak = [Math]::Round($peak, 6)
            $result.Ok = $true
            $result.Error = $null
        }
        elseif ($result.Error -eq 'unavailable') { $result.Error = 'no_pcm_or_format' }
    }
    catch [System.TimeoutException] {
        $result.Error = 'capture_timeout'
    }
    catch [System.ComponentModel.Win32Exception] {
        $result.Error = 'helper_start_failed'
    }
    catch [System.ObjectDisposedException] {
        $result.Error = 'capture_stream_closed'
    }
    catch {
        $result.Error = 'capture_failed'
    }
    finally {
        if ($proc) {
            try { if (-not $proc.HasExited) { $proc.Kill(); $null = $proc.WaitForExit(1000) } } catch { }
            $proc.Dispose()
        }
        $memory.Dispose()
    }
    return [pscustomobject]$result
}

function Test-AedWindowsInventory {
    $stage = [ordered]@{ DeviceQuery = $null; SessionBaseline = $null; RenderInventory = @() }
    try { $stage.RenderInventory = @(Get-RenderInventory) } catch { $stage.RenderInventory = @() }

    $devices = Invoke-AedHostJson -Arguments @('--devices')
    $sessions = Invoke-AedHostJson -Arguments @('--sessions')
    # Keep native IDs only in this private in-memory slot for exact default
    # topology matching later. Returned/stage data is deliberately ID-free.
    $script:aedWindowsPrivate = [ordered]@{ Devices = @(); Sessions = @() }
    if ($devices.Ok) { $script:aedWindowsPrivate.Devices = @($devices.Rows) }
    if ($sessions.Ok) { $script:aedWindowsPrivate.Sessions = @($sessions.Rows) }
    $stage.DeviceQuery = [pscustomobject]@{
        Ok = $devices.Ok
        Error = $devices.Error
        Devices = @($devices.Rows | ForEach-Object {
            [pscustomobject]@{ Label = ConvertTo-AedSafeLabel ([string]$_.label); Default = ($_.isDefault -eq $true); FormFactor = $_.formFactor; Enumerator = if ([string]$_.enumerator -match '^[A-Za-z0-9_-]{1,32}$') { [string]$_.enumerator } else { 'unknown' } }
        })
    }
    $stage.SessionBaseline = [pscustomobject]@{
        Ok = $sessions.Ok; Error = $sessions.Error
        Rows = @($sessions.Rows | ForEach-Object {
            [pscustomobject]@{ Category = Get-AedProcessCategory ([string]$_.exe); Endpoint = ConvertTo-AedSafeLabel ([string]$_.endpointLabel); Active = ($_.active -eq $true); Peak = if ($null -ne $_.peak) { [Math]::Round([double]$_.peak, 6) } else { $null }; Shared = $_.shared; System = ($_.system -eq $true) }
        })
    }
    Add-Line 'Windows audio endpoint inventory:'
    if (-not $devices.Ok) {
        Add-Line ("  endpoint enumeration unavailable ({0})" -f $devices.Error)
    }
    else {
        foreach ($device in $devices.Rows) {
            $name = ConvertTo-AedSafeLabel ([string]$device.label)
            $kind = if ($null -ne $device.formFactor) { [string]$device.formFactor } else { 'unknown' }
            $bus = if ($device.enumerator -and [string]$device.enumerator -match '^[A-Za-z0-9_-]{1,32}$') { [string]$device.enumerator } else { 'unknown' }
            $defaultText = if ($device.isDefault -eq $true) { 'default' } else { 'non-default' }
            Add-Line ("  {0}: {1}; form factor {2}; enumerator {3}" -f $defaultText, $name, $kind, $bus)
        }
    }
    if (-not $sessions.Ok) {
        Add-Line ("  baseline session meter unavailable ({0})" -f $sessions.Error)
    }
    else {
        $active = @($sessions.Rows | Where-Object { $_.active -eq $true })
        $peakRows = @($active | Where-Object { $null -ne $_.peak -and [double]$_.peak -gt 0 })
        Add-Line ("  baseline: {0} session(s), {1} active, {2} with nonzero peak" -f $sessions.Rows.Count, $active.Count, $peakRows.Count)
    }
    return [pscustomobject]$stage
}

function Get-AedPlaybackSafety {
    # A synthetic source is played only when the current-session native meter
    # is readable and no known meeting client is actively rendering. This is a
    # passive gate: it does not inspect titles, command lines, or window text.
    $meetingNames = @('teams', 'ms-teams', 'msteams', 'zoom', 'webex', 'webexmta', 'webexhost', 'skype', 'gotomeeting', 'ringcentral', 'discord')
    $meetingPresent = $false
    try {
        foreach ($name in $meetingNames) {
            if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { $meetingPresent = $true }
        }
    }
    catch { $meetingPresent = $true }

    $sessions = Invoke-AedHostJson -Arguments @('--sessions')
    if (-not $sessions.Ok) {
        if ($meetingPresent) { return [pscustomobject]@{ Allowed = $false; Reason = 'session_enumeration_failed_meeting_process_present' } }
        return [pscustomobject]@{ Allowed = $true; Reason = 'session_enumeration_failed_no_meeting_process_present' }
    }
    foreach ($row in $sessions.Rows) {
        if ($row.active -ne $true) { continue }
        $exe = [IO.Path]::GetFileName([string]$row.exe)
        $rootExe = [IO.Path]::GetFileName([string]$row.rootExe)
        if ($meetingNames -contains [IO.Path]::GetFileNameWithoutExtension($exe).ToLowerInvariant() -or
            $meetingNames -contains [IO.Path]::GetFileNameWithoutExtension($rootExe).ToLowerInvariant()) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'active_meeting_audio_session' }
        }
    }
    return [pscustomobject]@{ Allowed = $true; Reason = 'no_active_meeting_audio_session' }
}

function Test-AedWindowsPlayback {
    param([Parameter(Mandatory)][int]$PlaybackPid)
    $stage = [ordered]@{ PlaybackPid = $PlaybackPid; SessionDuring = $null; SessionSamples = @(); SessionSummary = $null; PcmProbes = [ordered]@{}; Roles = @(); OnlySyntheticAudible = $false; OnlySyntheticAudibleReason = 'not_evaluated' }

    # The supplied PID is an already-running, explicitly selected synthetic player.
    # Never resolve names, command lines, or windows for unrelated processes.
    $before = Invoke-AedHostJson -Arguments @('--sessions')
    $deviceResult = if ($script:aedWindowsPrivate -and $script:aedWindowsPrivate.Devices.Count) {
        [pscustomobject]@{ Ok = $true; Error = $null; Rows = @($script:aedWindowsPrivate.Devices) }
    } else { Invoke-AedHostJson -Arguments @('--devices') }
    $stage.SessionDuring = [pscustomobject]@{ Ok = $before.Ok; Error = $before.Error; Rows = @() }
    if ($before.Ok) {
        $matching = @($before.Rows | Where-Object { $_.rootPid -eq $PlaybackPid -or $_.pid -eq $PlaybackPid })
        $stage.Roles = @($matching | ForEach-Object {
            $sessionRow = $_
            $mappedDevice = @($deviceResult.Rows | Where-Object { [string]$_.id -ceq [string]$sessionRow.endpointId } | Select-Object -First 1)[0]
            [pscustomobject]@{
                EndpointLabel = if ($mappedDevice) { ConvertTo-AedSafeLabel ([string]$mappedDevice.label) } else { ConvertTo-AedSafeLabel ([string]$sessionRow.endpointLabel) }
                Default = [bool]($mappedDevice -and $mappedDevice.isDefault -eq $true)
                Category = Get-AedProcessCategory ([string]$sessionRow.exe)
                Active = ($sessionRow.active -eq $true)
                Peak = if ($null -ne $sessionRow.peak) { [Math]::Round([double]$sessionRow.peak, 6) } else { $null }
            }
        })
        $stage.SessionDuring.Rows = @($before.Rows | ForEach-Object {
            [pscustomobject]@{ Category = Get-AedProcessCategory ([string]$_.exe); Endpoint = ConvertTo-AedSafeLabel ([string]$_.endpointLabel); Active = ($_.active -eq $true); Peak = if ($null -ne $_.peak) { [Math]::Round([double]$_.peak, 6) } else { $null }; Shared = $_.shared; System = ($_.system -eq $true) }
        })
        $active = @($before.Rows | Where-Object { $_.active -eq $true })
        $peaks = @($active | Where-Object { $null -ne $_.peak } | ForEach-Object { [double]$_.peak })
        $peak = if ($peaks.Count) { [Math]::Round(($peaks | Measure-Object -Maximum).Maximum, 6) } else { $null }
        Add-Line ("Playback session snapshot: {0} active session(s); maximum reported peak {1}; matching endpoint(s) {2}" -f $active.Count, $(if ($null -ne $peak) { $peak } else { 'unavailable' }), $matching.Count)
        foreach ($role in $stage.Roles) {
            Add-Line ("  selected player endpoint: {0}; active={1}; peak={2}" -f $role.EndpointLabel, $role.Active, $(if ($null -ne $role.Peak) { $role.Peak } else { 'unavailable' }))
        }
    }
    else { Add-Line ("Playback session snapshot unavailable ({0})" -f $before.Error) }

    # Re-sample the native meter over a short fixed window. These are maxima
    # and quiet/late counts only; process names beyond the known category and
    # endpoint identifiers are not retained in the returned report object.
    $samples = New-Object System.Collections.Generic.List[object]
    for ($sampleIndex = 0; $sampleIndex -lt 6; $sampleIndex++) {
        if ($sampleIndex -gt 0) { Start-Sleep -Milliseconds 250 }
        $sampleResult = Invoke-AedHostJson -Arguments @('--sessions')
        if (-not $sampleResult.Ok) {
            $samples.Add([pscustomobject]@{ Index = $sampleIndex + 1; Ok = $false; Error = $sampleResult.Error; ActiveCount = $null; PlayerActive = $null; PlayerPeak = $null; SystemPeak = $null; UnrelatedAudibleOrUnknown = $true })
            continue
        }
        $activeRows = @($sampleResult.Rows | Where-Object { $_.active -eq $true })
        $playerRows = @($sampleResult.Rows | Where-Object { $_.rootPid -eq $PlaybackPid -or $_.pid -eq $PlaybackPid })
        $playerActiveRows = @($playerRows | Where-Object { $_.active -eq $true })
        $unrelatedRows = @($activeRows | Where-Object { $_.rootPid -ne $PlaybackPid -and $_.pid -ne $PlaybackPid })
        $unrelatedRisk = @($unrelatedRows | Where-Object {
            if ($null -eq $_.peak) { $true }
            else {
                $v = [double]$_.peak
                ([double]::IsNaN($v) -or [double]::IsInfinity($v) -or $v -ge 0.012)
            }
        }).Count -gt 0
        $playerPeaks = @($playerActiveRows | Where-Object { $null -ne $_.peak } | ForEach-Object { [double]$_.peak })
        $systemPeaks = @($activeRows | Where-Object { $_.system -eq $true -and $null -ne $_.peak } | ForEach-Object { [double]$_.peak })
        $playerPeak = if ($playerPeaks.Count) { [Math]::Round(($playerPeaks | Measure-Object -Maximum).Maximum, 6) } else { $null }
        $systemPeak = if ($systemPeaks.Count) { [Math]::Round(($systemPeaks | Measure-Object -Maximum).Maximum, 6) } else { $null }
        $samples.Add([pscustomobject]@{ Index = $sampleIndex + 1; Ok = $true; Error = $null; ActiveCount = $activeRows.Count; PlayerActive = ($playerActiveRows.Count -gt 0); PlayerPeak = $playerPeak; SystemPeak = $systemPeak; UnrelatedAudibleOrUnknown = $unrelatedRisk })
    }
    $stage.SessionSamples = @($samples.ToArray())
    $validSamples = @($stage.SessionSamples | Where-Object { $_.Ok })
    $quietCount = @($validSamples | Where-Object { $_.PlayerActive -eq $false }).Count
    $playerPeakSamples = @($validSamples | Where-Object { $null -ne $_.PlayerPeak } | ForEach-Object { [double]$_.PlayerPeak })
    $lateSamples = @($validSamples | Where-Object { $_.Index -ge 5 })
    $latePeaks = @($lateSamples | Where-Object { $null -ne $_.PlayerPeak } | ForEach-Object { [double]$_.PlayerPeak })
    $maxActiveCount = if ($validSamples.Count) { ($validSamples | Measure-Object -Property ActiveCount -Maximum).Maximum } else { $null }
    $maxPlayerPeak = if ($playerPeakSamples.Count) { [Math]::Round(($playerPeakSamples | Measure-Object -Maximum).Maximum, 6) } else { $null }
    $lateMaxPeak = if ($latePeaks.Count) { [Math]::Round(($latePeaks | Measure-Object -Maximum).Maximum, 6) } else { $null }
    $stage.SessionSummary = [pscustomobject]@{ SampleCount = 6; SuccessfulSamples = $validSamples.Count; MaxActiveSessions = $maxActiveCount; QuietPlayerSamples = $quietCount; MaxPlayerPeak = $maxPlayerPeak; LatePlayerActiveSamples = @($lateSamples | Where-Object { $_.PlayerActive }).Count; LateMaxPlayerPeak = $lateMaxPeak }
    $finiteAudiblePlayerPeak = $false
    foreach ($peakValue in $playerPeakSamples) {
        if (-not [double]::IsNaN($peakValue) -and -not [double]::IsInfinity($peakValue) -and $peakValue -ge 0.012) { $finiteAudiblePlayerPeak = $true; break }
    }
    $baselineUnrelatedRisk = $false
    if ($before.Ok) {
        $baselineUnrelatedRows = @($before.Rows | Where-Object { $_.active -eq $true -and $_.rootPid -ne $PlaybackPid -and $_.pid -ne $PlaybackPid })
        $baselineUnrelatedRisk = @($baselineUnrelatedRows | Where-Object {
            if ($null -eq $_.peak) { $true }
            else { $v = [double]$_.peak; ([double]::IsNaN($v) -or [double]::IsInfinity($v) -or $v -ge 0.012) }
        }).Count -gt 0
    }
    $sampleUnrelatedRisk = @($stage.SessionSamples | Where-Object { $_.UnrelatedAudibleOrUnknown }).Count -gt 0
    if ($PlaybackPid -le 4) { $stage.OnlySyntheticAudibleReason = 'fixture_pid_unavailable' }
    elseif (-not $before.Ok -or $validSamples.Count -ne 6) { $stage.OnlySyntheticAudibleReason = 'session_meter_incomplete' }
    elseif ($baselineUnrelatedRisk -or $sampleUnrelatedRisk) { $stage.OnlySyntheticAudibleReason = 'unrelated_active_session_audible_or_unknown' }
    elseif (-not $finiteAudiblePlayerPeak) { $stage.OnlySyntheticAudibleReason = 'fixture_peak_below_0_012' }
    else { $stage.OnlySyntheticAudible = $true; $stage.OnlySyntheticAudibleReason = 'fixture_peak_at_or_above_0_012_only' }
    Add-Line ("Synthetic-only audio gate: {0} ({1})" -f $stage.OnlySyntheticAudible, $stage.OnlySyntheticAudibleReason)
    Add-Line ("Repeated session samples: {0}/6 successful; max active sessions {1}; player quiet {2}/6; max peak {3}; late peak {4}" -f $validSamples.Count, $(if ($null -ne $maxActiveCount) { $maxActiveCount } else { 'unavailable' }), $quietCount, $(if ($null -ne $maxPlayerPeak) { $maxPlayerPeak } else { 'unavailable' }), $(if ($null -ne $lateMaxPeak) { $lateMaxPeak } else { 'unavailable' }))

    # Read the default device ID from the exact enumeration and use it only as
    # an internal target. IDs are never returned in reports or printed.
    $defaultDevice = $null
    if ($deviceResult.Ok) { $defaultDevice = @($deviceResult.Rows | Where-Object { $_.isDefault -eq $true } | Select-Object -First 1)[0] }

    $probes = [ordered]@{}
    $probes['system'] = Invoke-AedPcmProbe -Target 'system'
    if ($defaultDevice -and [string]$defaultDevice.id -match '^\{[A-Za-z0-9._{}-]{4,180}\}$') {
        # Native CLI grammar: endpoint:<IMMDevice id>; the constrained ID comes
        # directly from the same helper's device enumeration and remains private.
        $probes['default-endpoint'] = Invoke-AedPcmProbe -Target ("endpoint:{0}" -f [string]$defaultDevice.id)
    }
    else { $probes['default-endpoint'] = [pscustomobject]@{ Ok=$false; Bytes=0; Rms=$null; Peak=$null; SampleRate=$null; Channels=$null; Encoding=$null; Error='default_endpoint_unavailable' } }
    if ($PlaybackPid -gt 4) { $probes['synthetic-process'] = Invoke-AedPcmProbe -Target ("pid:{0}" -f $PlaybackPid) }
    else { $probes['synthetic-process'] = [pscustomobject]@{ Ok=$false; Bytes=0; Rms=$null; Peak=$null; SampleRate=$null; Channels=$null; Encoding=$null; Error='invalid_process_id' } }
    $stage.PcmProbes = $probes
    foreach ($name in @('system', 'default-endpoint', 'synthetic-process')) {
        $probe = $probes[$name]
        if ($probe.Ok) {
            Add-Line ("PCM {0}: {1} bytes; {2} Hz, {3} channel {4}; RMS {5}; peak {6}" -f $name, $probe.Bytes, $probe.SampleRate, $probe.Channels, $probe.Encoding, $probe.Rms, $probe.Peak)
        }
        else { Add-Line ("PCM {0}: unavailable ({1}); received {2} bytes" -f $name, $probe.Error, $probe.Bytes) }
    }
    return [pscustomobject]$stage
}
