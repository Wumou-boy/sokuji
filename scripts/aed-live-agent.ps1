# The released desktop build exposes these commands on its local named pipe.
function Invoke-AedLiveAgent {
    param([ValidateSet('status','logs.list','logs.enable','audio.inputs')][string]$Command,
          [hashtable]$Arguments = @{})
    $control = Join-Path $userDataPath 'agent-control.json'
    if (-not [IO.File]::Exists($control)) { throw 'control_off' }
    if ((Get-Item -LiteralPath $control).Length -gt 4096) { throw 'invalid_endpoint' }
    $meta = [IO.File]::ReadAllText($control) | ConvertFrom-Json
    $prefix = '\\.\pipe\'
    $address = [string]$meta.pipe
    if ($meta.version -ne 1 -or -not $address.StartsWith($prefix) -or
        $address.Substring($prefix.Length) -notmatch '^sokuji-agent-[a-f0-9]{32}$' -or
        $meta.token -notmatch '^[a-f0-9]{64}$') { throw 'invalid_endpoint' }
    $owner = Get-Process -Id ([int]$meta.pid) -ErrorAction SilentlyContinue
    if (-not $owner) { throw 'stale_control_owner' }
    if (-not $owner.Path) { throw 'control_owner_path_unknown' }
    if ($owner.Path -ine $exePath) { throw 'different_executable' }
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $address.Substring($prefix.Length), [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    $buffer = [IO.MemoryStream]::new()
    try {
        $pipe.Connect(500)
        $request = @{ token = $meta.token; command = $Command; args = $Arguments } | ConvertTo-Json -Depth 4 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($request + [char]10)
        $pipe.Write($bytes, 0, $bytes.Length)
        $chunk = New-Object byte[] 8192
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ($buffer.Length -lt 1MB) {
            $left = [int](3500 - $timer.ElapsedMilliseconds)
            if ($left -le 0) { throw 'agent_timeout' }
            $read = $pipe.ReadAsync($chunk, 0, $chunk.Length)
            if (-not $read.Wait($left)) { throw 'agent_timeout' }
            $n = $read.Result
            if ($n -eq 0) { throw 'pipe_closed' }
            $end = [Array]::IndexOf($chunk, [byte]10, 0, $n)
            if ($end -ge 0) {
                $buffer.Write($chunk, 0, $end)
                $reply = [Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
                if (-not $reply.ok) { throw 'command_unavailable' }
                return $reply.data
            }
            $buffer.Write($chunk, 0, $n)
        }
        throw 'oversize_reply'
    } finally { $pipe.Dispose(); $buffer.Dispose() }
}

function New-AedBackendState {
    return @{ signatureCounts = @{}; recent = @{}; initialized = $false;
              mic = 'unknown'; participant = 'unknown'; gaps = 0 }
}

# Logs are newest-first, limited, and have local timestamps at second resolution.
# Do not attribute the buffer from before attachment to the monitored session.
function Update-AedBackendState($State, $Entries, [switch]$Baseline) {
    $rows = @($Entries | Where-Object { $_ })
    [array]::Reverse($rows)
    $counts = @{}
    $fingerprints = @{}
    $overlap = $false
    $pending = @(
        foreach ($row in $rows) {
            $firstEvent = @($row.events)[0]
            $key = '{0}|{1}|{2}|{3}' -f $row.timestamp,$row.leg,$firstEvent.type,$firstEvent.data.atMs
            $fingerprints[$key] = $true
            if ($State.recent.ContainsKey($key)) { $overlap = $true }
            foreach ($event in $row.events) {
                if ($event.type -notin @('audio.capture.mic','audio.capture.participant','audio.echo.warning')) { continue }
                $sig = $row.timestamp + '|' + $event.type + '|' + ($event.data | ConvertTo-Json -Compress)
                $counts[$sig] = 1 + [int]$counts[$sig]
                if ($counts[$sig] -gt [int]$State.signatureCounts[$sig]) {
                    [pscustomobject]@{ appClock = $row.timestamp; type = $event.type; data = $event.data }
                }
            }
        }
    )
    if ($State.initialized -and $rows.Count -eq 100 -and -not $overlap -and -not $Baseline) {
        $State.gaps++
        $State.mic = $State.participant = 'unknown'
        Write-LiveEvent 'log_window_gap' @{ reason = '100_new_entries_since_previous_poll' }
    }
    $State.initialized = $true
    $State.signatureCounts = $counts
    $State.recent = $fingerprints
    if ($Baseline) { return }
    foreach ($entry in $pending) {
        $data = $entry.data
        switch ($entry.type) {
            'audio.capture.mic' { $State.mic = $data.applied }
            'audio.capture.participant' { $State.participant = [string]$data.backend }
        }
        Write-LiveEvent 'capture_event' $entry
    }
}
