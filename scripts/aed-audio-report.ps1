$ErrorActionPreference = 'Stop'
$cmdDirectory = Split-Path -Parent $env:AED_REPORT_CMD
$exePath = Join-Path $cmdDirectory 'AED Translator.exe'
$hostPath = Join-Path $cmdDirectory 'resources/resources/bin/win32-x64/sokuji-audio-host.exe'
$tempRoot = $env:AED_REPORT_WORK
$samplePath = Join-Path $tempRoot 'sample.wav'
$reportDirectory = [Environment]::GetFolderPath('DesktopDirectory')
if ($env:AED_AUDIO_TEST_REPORT_DIR -and [IO.Directory]::Exists($env:AED_AUDIO_TEST_REPORT_DIR)) {
    $reportDirectory = $env:AED_AUDIO_TEST_REPORT_DIR
}
if (-not [IO.Directory]::Exists($reportDirectory)) { $reportDirectory = $cmdDirectory }
$reportName = 'AED-Audio-Report-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.txt'
$reportPath = Join-Path $reportDirectory $reportName
$encoding = [Text.UTF8Encoding]::new($true)
try { $report = [IO.StreamWriter]::new($reportPath, $false, $encoding) }
catch {
    $reportPath = Join-Path $cmdDirectory $reportName
    $report = [IO.StreamWriter]::new($reportPath, $false, $encoding)
}
$report.AutoFlush = $true
$launch = $null
$playerProcess = $null
$inputs = $null
$app = $null
$appReadyForCapture = $false
$profile = $null
$exe = $null

function Add-Line([string]$Text) {
    foreach ($privatePath in @($tempRoot, $cmdDirectory, $env:APPDATA, $env:TEMP, $env:USERPROFILE)) {
        if ($privatePath) { $Text = [regex]::Replace($Text, [regex]::Escape($privatePath), '[local path]', 'IgnoreCase') }
    }
    $report.WriteLine($Text)
}

function Add-Result([string]$Title, $Result) {
    Add-Line ('[' + $Title + ']')
    Add-Line (ConvertTo-Json -InputObject $Result -Depth 12)
}

function Get-ArtifactHash([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return 'missing' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
}

function Test-AedReportProduct($VersionInfo) {
    if (-not $VersionInfo -or $VersionInfo.ProductName -ne 'AED Translator' -or
        [string]::IsNullOrWhiteSpace($VersionInfo.ProductVersion)) { return $false }
    $release = [version]::new($VersionInfo.ProductMajorPart, $VersionInfo.ProductMinorPart, $VersionInfo.ProductBuildPart)
    return $release -ge [version]'0.2.6'
}

function Invoke-Aed {
    param(
        [ValidateSet('status','audio.inputs','audio.system-check')][string]$Command,
        [hashtable]$Arguments = @{}
    )
    $controlFile = Join-Path $profile 'agent-control.json'
    if (-not [IO.File]::Exists($controlFile)) { throw 'The AED diagnostic interface is not ready.' }
    if ((Get-Item -LiteralPath $controlFile).Length -gt 4096) { throw 'Invalid diagnostic metadata size.' }
    $metadata = [IO.File]::ReadAllText($controlFile) | ConvertFrom-Json
    $pipePrefix = '\\.\pipe\'
    $pipePath = [string]$metadata.pipe
    if ($metadata.version -ne 1 -or -not $pipePath.StartsWith($pipePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $pipePath.Substring($pipePrefix.Length) -notmatch '^sokuji-agent-[a-f0-9]{32}$' -or
        $metadata.token -notmatch '^[a-f0-9]{64}$') { throw 'Invalid AED diagnostic endpoint metadata.' }
    $owner = Get-Process -Id ([int]$metadata.pid) -ErrorAction Stop
    if ($owner.Id -ne $launch.Id -or $owner.Path -ine $exePath) { throw 'Another process owns the AED diagnostic interface.' }
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipePath.Substring($pipePrefix.Length), [IO.Pipes.PipeDirection]::InOut)
    $buffer = [IO.MemoryStream]::new()
    try {
        $pipe.Connect(2500)
        $request = @{ token = $metadata.token; command = $Command; args = $Arguments } | ConvertTo-Json -Compress -Depth 5
        $bytes = [Text.Encoding]::UTF8.GetBytes($request + "`n")
        $pipe.Write($bytes, 0, $bytes.Length)
        $pipe.Flush()
        $chunk = New-Object byte[] 4096
        $timer = [Diagnostics.Stopwatch]::StartNew()
        # Let the renderer return its own timeout and release the audio devices before the next probe.
        $timeoutMs = if ($Command -eq 'audio.system-check') { 45000 } else { 6000 }
        while ($buffer.Length -lt 512KB) {
            $remaining = [int]($timeoutMs - $timer.ElapsedMilliseconds)
            if ($remaining -le 0) { throw 'AED diagnostic timed out.' }
            $pending = $pipe.ReadAsync($chunk, 0, $chunk.Length, [Threading.CancellationToken]::None)
            if (-not $pending.Wait($remaining)) { throw 'AED diagnostic timed out.' }
            $count = $pending.Result
            if ($count -lt 1) { throw 'AED closed the diagnostic connection before replying.' }
            $lineEnd = [Array]::IndexOf($chunk, [byte]10, 0, $count)
            if ($lineEnd -ge 0) {
                if ($buffer.Length + $lineEnd -gt 512KB) { throw 'Oversize AED diagnostic response.' }
                $buffer.Write($chunk, 0, $lineEnd)
                return ([Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json)
            }
            $buffer.Write($chunk, 0, $count)
        }
        throw 'Oversize AED diagnostic response.'
    } finally { $buffer.Dispose(); $pipe.Dispose() }
}

function Get-RenderInventory {
    if (-not [IO.File]::Exists($hostPath)) { return [pscustomobject]@{ status = 'helper_missing'; devices = @() } }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $hostPath
    $start.Arguments = '--devices'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $process = $null
    try {
        $process = [Diagnostics.Process]::Start($start)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(4000) -or -not $stdout.Wait(500) -or -not $stderr.Wait(500)) {
            return [pscustomobject]@{ status = 'timeout'; devices = @() }
        }
        if ($process.ExitCode -ne 0) {
            return [pscustomobject]@{ status = 'native_error'; exitCode = $process.ExitCode; devices = @() }
        }
        if (-not $stdout.Result.TrimStart().StartsWith('[')) { throw 'Expected a render device array.' }
        $rows = ConvertFrom-Json -InputObject $stdout.Result
        $safe = @(foreach ($row in $rows) {
            [pscustomobject]@{
                label = $row.label
                browserLabel = $row.browserLabel
                idPresent = $row.id -is [string] -and -not [string]::IsNullOrWhiteSpace($row.id)
                enumerator = $row.enumerator
                physical = $row.physical
                isDefault = $row.isDefault
                formFactor = $row.formFactor
            }
        })
        return [pscustomobject]@{ status = 'ok'; devices = $safe }
    } catch {
        return [pscustomobject]@{ status = 'helper_unavailable'; devices = @() }
    } finally {
        if ($process) {
            if (-not $process.HasExited) { try { $process.Kill() } catch { } }
            $process.Dispose()
        }
    }
}

function Wait-AedReady([string]$Command, [scriptblock]$Ready, [int]$Seconds) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastFailure = 'no ready response'
    do {
        if ($launch.HasExited) { throw ('AED quit during startup. Exit code: ' + $launch.ExitCode) }
        try {
            $reply = Invoke-Aed -Command $Command
            if ($reply.ok -and (& $Ready $reply.data)) { return $reply.data }
            if (-not $reply.ok) { $lastFailure = [string]$reply.error.code }
        } catch { $lastFailure = $_.Exception.Message }
        Start-Sleep -Milliseconds 250
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw ($Command + ' did not become ready: ' + $lastFailure)
}

function Close-OwnedProcess($Process, [switch]$Graceful) {
    if (-not $Process) { return }
    try {
        if ($Process.HasExited) { return }
        if ($Graceful -and $Process.CloseMainWindow() -and $Process.WaitForExit(3000)) { return }
        $Process.Kill()
        [void]$Process.WaitForExit(3000)
    } catch { Add-Line ('Owned process cleanup: ' + $_.Exception.GetType().Name) }
    finally { $Process.Dispose() }
}

# AED_REPORT_FUNCTIONS

Add-Line 'AED Translator | Comprehensive offline audio report r2'
Add-Line ('Started: ' + (Get-Date).ToString('o'))
Add-Line ('Environment: Windows ' + [Environment]::OSVersion.Version + ', PowerShell ' + $PSVersionTable.PSVersion + ', x64 OS=' + [Environment]::Is64BitOperatingSystem)
Add-Line 'Scope: local synthetic playback, device metadata and numeric signal measurements. No cloud, recordings, subtitles, or meeting audio samples are exported.'
try {
    try {
        if (-not [IO.File]::Exists($exePath)) { throw 'AED Translator.exe was not found beside the CMD.' }
        $exe = Get-Item -LiteralPath $exePath
        Add-Result 'AED executable' ([ordered]@{
            name = $exe.Name
            product = $exe.VersionInfo.ProductName
            productVersion = $exe.VersionInfo.ProductVersion
            fileVersion = $exe.VersionInfo.FileVersion
            helperSha256 = Get-ArtifactHash $hostPath
            syntheticFixtureSha256 = Get-ArtifactHash $samplePath
        })
    } catch { Add-Line ('AED executable check: ' + $_.Exception.Message) }

    $inventory = Get-RenderInventory
    Add-Result 'Windows render endpoint inventory' $inventory
    try {
        $windowsInventory = Test-AedWindowsInventory
        Add-Result 'Windows session baseline' $windowsInventory.SessionBaseline
    } catch { Add-Line ('Windows passive inventory error: ' + $_.Exception.Message) }

    $existing = @(Get-Process -Name 'AED Translator','sokuji' -ErrorAction SilentlyContinue)
    try {
        if ($existing.Count) { throw 'An AED or Sokuji instance is already running; this run will not attach to it.' }
        if (-not $exe -or -not (Test-AedReportProduct $exe.VersionInfo)) {
            throw 'Place this CMD beside AED Translator.exe version 0.2.6 or newer. The running app must support diagnostic protocol 1.'
        }
        $roaming = [Environment]::GetFolderPath('ApplicationData')
        if (-not $roaming) { throw 'Windows roaming profile is unavailable.' }
        $profile = Join-Path $roaming 'Sokuji'
        if (-not [IO.Directory]::Exists((Join-Path $profile 'Local Storage'))) { throw 'Existing AED preferences were not found.' }
        Add-Line 'Profile: existing %APPDATA%\Sokuji'
        $launch = Start-Process -FilePath $exePath -ArgumentList '--agent-control' -PassThru -WindowStyle Hidden -WorkingDirectory $cmdDirectory
        $app = Wait-AedReady 'status' { param($data) $data.appReady } 20
        Add-Result 'AED runtime state' ([ordered]@{
            version = $app.appVersion
            mode = $app.appMode
            session = $app.phase
            faceToFaceSession = $app.faceToFacePhase
        })
        if ($app.appVersion -ne $exe.VersionInfo.ProductVersion) {
            throw ('The running AED version (' + $app.appVersion + ') differs from the adjacent executable (' + $exe.VersionInfo.ProductVersion + ').')
        }
        if ($app.appMode -ne 'meeting' -or $app.phase -ne 'idle' -or $app.faceToFacePhase -ne 'idle') { throw 'Online Meeting idle state was not verified.' }
        $inputs = Wait-AedReady 'audio.inputs' { param($data) $data.devicesLoaded } 15
        $appReadyForCapture = $true
        Add-Result 'AED audio routes and preferences' ([ordered]@{
            meetingMic = $inputs.meetingInput
            micMuted = $inputs.meetingMicMuted
            microphoneEchoMode = $inputs.microphoneEchoMode
            systemDefaultMic = $inputs.systemDefault
            systemDefaultOutput = $inputs.systemOutput
            virtualOutput = $inputs.virtualOutput
            participantSource = $inputs.participantSource
            sourceWidened = $inputs.participantCaptureWidened
            speechRoutes = $inputs.speechRoutes
            physicalOutputs = @($inputs.participantOutputs)
            inputs = @($inputs.inputs)
        })
    } catch { Add-Line ('AED renderer status: incomplete; ' + $_.Exception.Message) }

    $defaults = @($inventory.devices | Where-Object { $_.isDefault -eq $true })
    $defaultOutput = if ($defaults.Count -eq 1) { $defaults[0] } else { $null }
    $safeWindowsOutput = $defaultOutput -and ($defaultOutput.physical -eq $true -or (
        $defaultOutput.enumerator -ieq 'SOUNDWIRE' -and $defaultOutput.formFactor -eq 1)) -and
        $defaultOutput.label -and $defaultOutput.label -notmatch '(?i)virtual|vb-audio|voicemeeter|cable in'
    $safeAedOutput = $inputs.systemOutput.label -and $inputs.systemOutput.virtual -eq $false
    $conflictingOutput = $inputs.systemOutput.virtual -eq $true -or ($defaultOutput -and $defaultOutput.label -match '(?i)virtual|vb-audio|voicemeeter|cable in')
    $playbackSafety = Get-AedPlaybackSafety
    Add-Result 'Windows playback safety before test' $playbackSafety
    if ($existing.Count) { Add-Line 'DYNAMIC SKIPPED: another AED process is open.' }
    elseif ($app -and ($app.phase -ne 'idle' -or $app.faceToFacePhase -ne 'idle')) { Add-Line 'DYNAMIC SKIPPED: AED has an active session.' }
    elseif (-not $playbackSafety.allowed) { Add-Line ('DYNAMIC SKIPPED: ' + $playbackSafety.reason) }
    elseif ($conflictingOutput -or (-not $safeWindowsOutput -and -not $safeAedOutput)) { Add-Line 'DYNAMIC SKIPPED: a safe physical playback output could not be identified.' }
    elseif (-not [IO.File]::Exists($samplePath)) { Add-Line 'DYNAMIC SKIPPED: the synthetic test WAV is missing.' }
    else {
        $playerCode = @'
param([string]$Wav)
$ErrorActionPreference = 'Stop'
$player = [System.Media.SoundPlayer]::new($Wav)
try { $player.Load(); $player.PlayLooping(); Start-Sleep -Seconds 180 }
finally { $player.Stop(); $player.Dispose() }
'@
        $playerPath = Join-Path $tempRoot 'play.ps1'
        [IO.File]::WriteAllText($playerPath, $playerCode, [Text.UTF8Encoding]::new($true))
        $playerArgs = @('-NoLogo','-NoProfile','-File',('"' + $playerPath + '"'),('"' + $samplePath + '"'))
        $playerProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $playerArgs -PassThru -WindowStyle Hidden
        Start-Sleep -Milliseconds 900
        if ($playerProcess.HasExited) { Add-Line ('DYNAMIC SKIPPED: synthetic playback exited with code ' + $playerProcess.ExitCode) }
        else {
            Add-Line 'Playback: the script is looping its embedded synthetic sample on the Windows default output.'
            $duringPlaybackSafety = Get-AedPlaybackSafety
            Add-Result 'Windows playback safety during test' $duringPlaybackSafety
            if (-not $duringPlaybackSafety.allowed) {
                Add-Line ('DYNAMIC SKIPPED: ' + $duringPlaybackSafety.reason)
            } else {
                $windowsPlayback = $null
                try {
                    $windowsPlayback = Test-AedWindowsPlayback $playerProcess.Id
                    Add-Result 'Windows playback meters and PCM numeric results' $windowsPlayback
                } catch { Add-Line ('Windows playback probe error: ' + $_.Exception.Message) }
                if ($appReadyForCapture) {
                    $label = [string]$inputs.systemOutput.label -replace '^Default - ', ''
                    $nativeLabels = @($inventory.devices | Where-Object { $_.browserLabel -ieq $label } | ForEach-Object label)
                    $matches = @($inputs.participantOutputs | Where-Object { $_ -and ($_ -ieq $label -or $nativeLabels -icontains $_) })
                    if (-not $label -and $defaultOutput) {
                        $matches = @($inputs.participantOutputs | Where-Object { $_ -and $_ -ieq $defaultOutput.label })
                    }
                    $endpointLabel = if ($matches.Count -eq 1) { $matches[0] } else { '' }
                    Add-Line ('AED explicit default endpoint match count: ' + $matches.Count)
                    try { Test-AedCaptureMatrix $inputs $endpointLabel }
                    catch { Add-Line ('AED capture matrix error: ' + $_.Exception.Message) }
                    try {
                        $after = Invoke-Aed -Command audio.inputs
                        if ($after.ok) {
                            $beforeRoute = ConvertTo-Json -InputObject @($inputs.meetingInput,$inputs.participantSource,$inputs.speechRoutes) -Compress -Depth 5
                            $afterRoute = ConvertTo-Json -InputObject @($after.data.meetingInput,$after.data.participantSource,$after.data.speechRoutes) -Compress -Depth 5
                            $unchanged = $beforeRoute -ceq $afterRoute -and $inputs.microphoneEchoMode -eq $after.data.microphoneEchoMode -and
                                $inputs.meetingMicMuted -eq $after.data.meetingMicMuted
                            Add-Line ('Saved microphone, AEC, participant source and voice routes match after probes: ' + $unchanged)
                        } else { Add-Line ('Post-check settings read unavailable: ' + $after.error.code) }
                    } catch { Add-Line ('Post-check settings read error: ' + $_.Exception.Message) }
                } else { Add-Line 'AED capture matrix: skipped because the renderer or preferences were unavailable.' }
            }
        }
    }
} catch { Add-Line ('Diagnostic runner error: ' + $_.Exception.Message) }
finally {
    Close-OwnedProcess $playerProcess
    Close-OwnedProcess $launch -Graceful
    foreach ($temporary in @('sample.wav','play.ps1','run-aed-audio-report.ps1')) {
        $created = Join-Path $tempRoot $temporary
        if ([IO.File]::Exists($created)) { Remove-Item -LiteralPath $created -ErrorAction SilentlyContinue }
    }
    if ([IO.Directory]::Exists($tempRoot) -and -not @(Get-ChildItem -LiteralPath $tempRoot -Force).Count) {
        Remove-Item -LiteralPath $tempRoot -ErrorAction SilentlyContinue
    }
    Add-Line ('Finished: ' + (Get-Date).ToString('o'))
    $report.Dispose()
    Write-Host ('Report: ' + $reportPath)
    if ($env:AED_AUDIO_SUPPRESS_VIEWER -ne '1') {
        Start-Process notepad.exe -ArgumentList ('"' + $reportPath + '"') -ErrorAction SilentlyContinue
    }
}
