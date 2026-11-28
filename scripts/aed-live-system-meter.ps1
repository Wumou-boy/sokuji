# Passive, read-only Windows render meter for AED diagnostics.
# Dot-source this file, then call Get-AedLiveSystemMeterSample once per sample
# (normally every 1-2 seconds). It does not consult or change AED's chosen
# capture source. This meter reads levels only; it never captures or stores PCM.

function ConvertFrom-AedLiveMeterJson {
    param([Parameter(Mandatory)][string]$Json)
    try {
        # Assign before wrapping in @(): Windows PowerShell 5.1 otherwise can
        # enumerate nested array output while building the result object.
        $parsed = ConvertFrom-Json -InputObject $Json -ErrorAction Stop
        if ($null -eq $parsed) {
            if ($Json.Trim() -eq '[]') { $rows = @() }
            else { throw 'empty_json' }
        }
        else {
            $rowList = New-Object 'System.Collections.Generic.List[object]'
            if ($parsed -is [System.Array]) {
                foreach ($item in $parsed) { [void]$rowList.Add($item) }
            }
            else { [void]$rowList.Add($parsed) }
            $rows = $rowList.ToArray()
        }
        return [pscustomobject]@{ Ok = $true; Rows = $rows; Error = $null }
    }
    catch {
        return [pscustomobject]@{ Ok = $false; Rows = @(); Error = 'invalid_helper_json' }
    }
}

function Test-AedTeamsOwner($Row) {
    $pattern = '^(teams|ms-teams|msteams)\.exe$'
    return ([IO.Path]::GetFileName([string]$Row.rootExe) -match $pattern -or [IO.Path]::GetFileName([string]$Row.exe) -match $pattern)
}

function Get-AedLiveEndpointOwnership {
    param([AllowEmptyCollection()][object[]]$Rows = @(), [string]$AudioHostPath)
    $active = @($Rows | Where-Object { $_.active -eq $true })
    foreach ($group in @($active | Group-Object endpointId)) {
        $teams = @($group.Group | Where-Object { Test-AedTeamsOwner $_ })
        if (-not $teams.Count) { continue }
        $identified = @($teams | Where-Object { $_.pid -gt 4 -and $_.rootPid -gt 4 -and $_.shared -eq $false -and $_.system -ne $true -and $null -ne $_.peak })
        $other = @($group.Group | Where-Object { -not (Test-AedTeamsOwner $_) })
        $readers = @($other | Where-Object {
            if (-not $AudioHostPath -or $_.exe -ine 'sokuji-audio-host.exe' -or $_.shared -ne $false -or $_.system -eq $true -or $_.pid -le 4) { return $false }
            $reader = Get-Process -Id $_.pid -ErrorAction SilentlyContinue
            return ($reader -and $reader.Path -ieq $AudioHostPath)
        })
        $other = @($other | Where-Object { $readers -notcontains $_ })
        $hotRoots = @($identified | Where-Object { $_.peak -ge 0.012 } | Select-Object -ExpandProperty rootPid -Unique)
        [pscustomobject]@{
            EndpointLabel = ConvertTo-AedLiveMeterLabel ([string]$teams[0].endpointLabel)
            ActiveTeamsRows = $teams.Count
            VerifiedTeamsRoots = @($identified | Select-Object -ExpandProperty rootPid -Unique).Count
            AudibleVerifiedTeamsRoots = $hotRoots.Count
            UnverifiedTeamsRows = $teams.Count - $identified.Count
            PackageLoopbackReaders = $readers.Count
            OtherAudibleRows = @($other | Where-Object { $_.peak -ge 0.012 }).Count
            OtherUncertainRows = @($other | Where-Object { $_.pid -le 4 -or $_.rootPid -le 4 -or -not $_.rootExe -or $_.shared -ne $false -or $_.system -eq $true -or $null -eq $_.peak }).Count
        }
    }
}

function Get-AedLiveTeamsRenderSessions {
    param([AllowEmptyCollection()][object[]]$Rows = @())
    $teamResults = New-Object 'System.Collections.Generic.List[object]'
    foreach ($row in $Rows) {
        if ($null -eq $row) { continue }
        if (-not (Test-AedTeamsOwner $row)) { continue }
        $peak = $null
        if ($null -ne $row.peak) {
            try {
                $candidate = [double]$row.peak
                if (-not [double]::IsNaN($candidate) -and -not [double]::IsInfinity($candidate) -and $candidate -ge 0 -and $candidate -le 1) {
                    $peak = [Math]::Round($candidate, 6)
                }
            } catch { }
        }
        $match = [pscustomobject]@{
            State = if ($row.active -eq $true) { 'active' } else { 'inactive' }
            Peak = $peak
            HasNonzeroPeak = [bool]($null -ne $peak -and $peak -gt 0)
            EndpointLabel = ConvertTo-AedLiveMeterLabel ([string]$row.endpointLabel)
        }
        [void]$teamResults.Add($match)
    }
    return $teamResults.ToArray()
}

function Start-AedLiveMeterJson {
    param([Parameter(Mandatory)][string]$AudioHostPath)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $AudioHostPath
    $start.Arguments = '--sessions'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'helper_start_failed' }
        return [pscustomobject]@{
            Process = $process
            StdoutTask = $process.StandardOutput.ReadToEndAsync()
            StderrTask = $process.StandardError.ReadToEndAsync()
            Error = $null
        }
    }
    catch {
        $process.Dispose()
        $code = [string]$_.Exception.Message
        if ($code -notmatch '^(helper_[a-z_]+)$') { $code = 'helper_start_failed' }
        return [pscustomobject]@{ Process = $null; StdoutTask = $null; StderrTask = $null; Error = $code }
    }
}

function Complete-AedLiveMeterJson {
    param([Parameter(Mandatory)]$RunningHelper, [ValidateRange(100, 10000)][int]$TimeoutMs = 4000)
    $process = $RunningHelper.Process
    if (-not $process) { return [pscustomobject]@{ Ok = $false; Rows = @(); Error = $RunningHelper.Error } }
    try {
        if (-not $process.WaitForExit($TimeoutMs)) { throw 'helper_timeout' }
        if (-not $RunningHelper.StdoutTask.Wait(1000) -or -not $RunningHelper.StderrTask.Wait(1000)) { throw 'helper_read_timeout' }
        if ($process.ExitCode -ne 0) { throw 'helper_exit_nonzero' }
        $json = $RunningHelper.StdoutTask.Result
        if ([string]::IsNullOrWhiteSpace($json)) { throw 'helper_empty_response' }
        $parsed = ConvertFrom-AedLiveMeterJson -Json $json
        if (-not $parsed.Ok) { throw 'helper_invalid_json' }
        return $parsed
    }
    catch {
        $code = [string]$_.Exception.Message
        if ($code -notmatch '^(helper_[a-z_]+)$') { $code = 'helper_failed' }
        return [pscustomobject]@{ Ok = $false; Rows = @(); Error = $code }
    }
    finally {
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(1000) } } catch { }
        $process.Dispose()
    }
}

function ConvertTo-AedLiveMeterLabel {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $clean = [regex]::Replace($Value, '[\x00-\x1f\x7f]', ' ')
    $clean = [regex]::Replace($clean, '\s+', ' ').Trim()
    if ($clean.Length -gt 100) { $clean = $clean.Substring(0, 100) }
    return $clean
}

function Initialize-AedLiveSystemMeterType {
    if (-not ('Aed.LiveSystemMeter.Reader' -as [type])) {
        $source = @'
using System;
using System.Runtime.InteropServices;

namespace Aed.LiveSystemMeter {
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int classContext, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId(out IntPtr id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey { public Guid format; public uint id; }

    [StructLayout(LayoutKind.Explicit, Size=24)]
    internal struct PropVariant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioMeterInformation {
        [PreserveSig] int GetPeakValue(out float peak);
        [PreserveSig] int GetMeteringChannelCount(out uint count);
        [PreserveSig] int GetChannelsPeakValues(uint count, IntPtr values);
        [PreserveSig] int QueryHardwareSupport(out uint mask);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorCom { }

    public sealed class Result {
        public bool Available { get; set; }
        public string Status { get; set; }
        public string EndpointLabel { get; set; }
        public double? Peak { get; set; }
        public double? PeakDbfs { get; set; }
        public int SampleCount { get; set; }
        public int WindowMs { get; set; }
        public string Error { get; set; }
    }

    public static class Reader {
        [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);

        public static Result ReadDefaultRenderPeak(int sampleCount, int sampleWindowMs) {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IPropertyStore properties = null;
            IAudioMeterInformation meter = null;
            object meterObject = null;
            Result result = new Result { Available = false, Status = "unavailable", Error = "endpoint_unavailable" };
            try {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
                int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
                if (hr < 0 || device == null) { result.Error = "default_render_endpoint_unavailable"; return result; }

                try {
                    hr = device.OpenPropertyStore(0, out properties);
                    if (hr >= 0 && properties != null) {
                        PropertyKey key = new PropertyKey { format = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), id = 14 };
                        PropVariant value;
                        hr = properties.GetValue(ref key, out value);
                        if (hr >= 0 && value.type == 31 && value.pointer != IntPtr.Zero)
                            result.EndpointLabel = Marshal.PtrToStringUni(value.pointer);
                        if (hr >= 0) PropVariantClear(ref value);
                    }
                } catch { }

                Guid meterIid = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
                hr = device.Activate(ref meterIid, 23, IntPtr.Zero, out meterObject);
                meter = meterObject as IAudioMeterInformation;
                if (hr < 0 || meter == null) { result.Error = "endpoint_meter_unavailable"; return result; }
                float peak = 0;
                int validSamples = 0;
                int interval = Math.Max(1, sampleWindowMs / Math.Max(1, sampleCount - 1));
                var timer = System.Diagnostics.Stopwatch.StartNew();
                for (int i = 0; i < sampleCount; i++) {
                    float current;
                    hr = meter.GetPeakValue(out current);
                    if (hr >= 0 && !float.IsNaN(current) && !float.IsInfinity(current) && current >= 0 && current <= 1) {
                        if (validSamples == 0 || current > peak) peak = current;
                        validSamples++;
                    }
                    if (i + 1 < sampleCount) System.Threading.Thread.Sleep(interval);
                }
                timer.Stop();
                if (validSamples == 0) { result.Error = "endpoint_meter_read_failed"; return result; }
                result.Available = true;
                result.Status = peak > 0 ? "active" : "silent";
                result.Peak = Math.Round((double)peak, 6);
                result.PeakDbfs = peak > 0 ? (double?)Math.Round(20.0 * Math.Log10(peak), 2) : null;
                result.SampleCount = validSamples;
                result.WindowMs = (int)timer.ElapsedMilliseconds;
                result.Error = null;
                return result;
            } catch {
                result.Error = "endpoint_meter_unavailable";
                return result;
            } finally {
                if (meter != null) Marshal.ReleaseComObject(meter);
                if (meterObject != null && !Object.ReferenceEquals(meterObject, meter) && Marshal.IsComObject(meterObject)) Marshal.ReleaseComObject(meterObject);
                if (properties != null) Marshal.ReleaseComObject(properties);
                if (device != null) Marshal.ReleaseComObject(device);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }
    }
}
'@
        # Some PowerShell 5.1 hosts inherit a stale Visual C++ LIB search path.
        # It is irrelevant to this framework-only COM interop shim and makes
        # Add-Type treat the missing directory warning as a compilation error.
        $savedLib = $env:LIB
        try {
            $env:LIB = $null
            Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
        }
        finally { $env:LIB = $savedLib }
    }
}

function Get-AedLiveSystemEndpointMeter {
    Initialize-AedLiveSystemMeterType | Out-Null
    return [Aed.LiveSystemMeter.Reader]::ReadDefaultRenderPeak(4, 300)
}

function Get-AedLiveSystemMeterSample {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AudioHostPath
    )

    $timestamp = [DateTime]::UtcNow.ToString('o')
    $system = [ordered]@{ Available = $false; Status = 'unavailable'; EndpointLabel = $null; Peak = $null; PeakDbfs = $null; SampleCount = 0; WindowMs = 0; Error = $null }
    $teams = [ordered]@{ Available = $false; Status = 'unavailable'; Sessions = @(); EndpointOwnership = @(); Error = $null }

    # The COM endpoint meter is independent of the helper, so missing helper
    # files degrade only Teams-session reporting, not the system render level.
    $meterInitError = $null
    try { Initialize-AedLiveSystemMeterType | Out-Null }
    catch { $meterInitError = 'endpoint_meter_unavailable' }

    $runningSessions = $null
    if (Test-Path -LiteralPath $AudioHostPath -PathType Leaf) {
        $runningSessions = Start-AedLiveMeterJson -AudioHostPath $AudioHostPath
    }
    else {
        $sessions = [pscustomobject]@{ Ok = $false; Rows = @(); Error = 'helper_not_found' }
    }

    try {
        if ($meterInitError) {
            $endpointMeter = [pscustomobject]@{ Available = $false; Status = 'unavailable'; EndpointLabel = $null; Peak = $null; PeakDbfs = $null; SampleCount = 0; WindowMs = 0; Error = $meterInitError }
        }
        else { $endpointMeter = Get-AedLiveSystemEndpointMeter }
    }
    catch {
        $endpointMeter = [pscustomobject]@{ Available = $false; Status = 'unavailable'; EndpointLabel = $null; Peak = $null; PeakDbfs = $null; SampleCount = 0; WindowMs = 0; Error = 'endpoint_meter_unavailable' }
    }
    finally {
        # Complete owns the helper lifetime and kills/disposes it even if meter
        # activation or sampling above throws unexpectedly.
        if ($runningSessions) { $sessions = Complete-AedLiveMeterJson -RunningHelper $runningSessions }
    }

    foreach ($property in @('Available','Status','EndpointLabel','Peak','PeakDbfs','SampleCount','WindowMs','Error')) {
        $system[$property] = $endpointMeter.$property
    }
    $system.EndpointLabel = ConvertTo-AedLiveMeterLabel $system.EndpointLabel

    if ($sessions -and $sessions.Ok) {
        $teams.Available = $true
        $teamRows = @(Get-AedLiveTeamsRenderSessions -Rows $sessions.Rows)
        $teams.Sessions = @($teamRows)
        $teams.EndpointOwnership = @(Get-AedLiveEndpointOwnership -Rows $sessions.Rows -AudioHostPath $AudioHostPath)
        $teams.Status = if ($teamRows.Count -eq 0) { 'no_render_session' } else { 'sessions_found' }
        $teams.Error = $null
    }
    elseif ($sessions) { $teams.Error = $sessions.Error }
    else { $teams.Error = 'helper_unavailable' }

    return [pscustomobject]@{
        TimestampUtc = $timestamp
        SystemRender = [pscustomobject]$system
        TeamsRenderSessions = [pscustomobject]$teams
    }
}
