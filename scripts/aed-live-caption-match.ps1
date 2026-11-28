# Passive, privacy-preserving live meeting caption cross-talk diagnostics.
# Text is inspected only in process memory; returned objects contain counts and relative timing only.

function Initialize-AedLiveSqlite {
    if ('AedLiveSqlite' -as [type]) { return }
    $savedLibPath = $env:LIB
    try {
        # This host can inherit a stale MSVC LIB path; csc treats that warning as fatal.
        # Clear it only while compiling these self-contained managed declarations.
        $env:LIB = $null
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AedLiveSqlite {
    private const int SQLITE_OK = 0;
    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;
    private const int SQLITE_OPEN_READONLY = 0x00000001;

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_busy_timeout(IntPtr db, int milliseconds);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close_v2(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int bytes, out IntPtr statement, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_count(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_name(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_type(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern long sqlite3_column_int64(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_bytes(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_bind_text(IntPtr statement, int index, byte[] value, int bytes, IntPtr destructor);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_bind_int64(IntPtr statement, int index, long value);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr db);

    private static string Utf8(IntPtr value, int length) {
        if (value == IntPtr.Zero || length <= 0) return "";
        byte[] bytes = new byte[length];
        Marshal.Copy(value, bytes, 0, length);
        return Encoding.UTF8.GetString(bytes);
    }
    private static string Ansi(IntPtr value) {
        return value == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(value);
    }
    public static List<Dictionary<string, object>> Query(string filename, string sql) {
        return QueryCore(filename, sql, null, false);
    }
    public static List<Dictionary<string, object>> QueryBound(string filename, string sql, string textParameter, long numberParameter) {
        return QueryCore(filename, sql, new object[] { textParameter, numberParameter }, true);
    }
    public static List<Dictionary<string, object>> QueryOne(string filename, string sql, string textParameter) {
        return QueryCore(filename, sql, new object[] { textParameter }, true);
    }
    private static List<Dictionary<string, object>> QueryCore(string filename, string sql, object[] parameters, bool bind) {
        IntPtr db = IntPtr.Zero;
        IntPtr statement = IntPtr.Zero;
        int rc = sqlite3_open_v2(Encoding.UTF8.GetBytes(filename + "\0"), out db, SQLITE_OPEN_READONLY, IntPtr.Zero);
        if (rc != SQLITE_OK) {
            string message = db == IntPtr.Zero ? "SQLite read-only open failed" : Ansi(sqlite3_errmsg(db));
            if (db != IntPtr.Zero) sqlite3_close_v2(db);
            throw new InvalidOperationException(message);
        }
        try {
            sqlite3_busy_timeout(db, 250);
            rc = sqlite3_prepare_v2(db, Encoding.UTF8.GetBytes(sql + "\0"), -1, out statement, IntPtr.Zero);
            if (rc != SQLITE_OK) throw new InvalidOperationException(Ansi(sqlite3_errmsg(db)));
            if (bind) {
                for (int i = 0; i < parameters.Length; i++) {
                    object parameter = parameters[i];
                    if (parameter is string) {
                        byte[] value = Encoding.UTF8.GetBytes((string)parameter + "\0");
                        rc = sqlite3_bind_text(statement, i + 1, value, value.Length - 1, new IntPtr(-1));
                    } else rc = sqlite3_bind_int64(statement, i + 1, Convert.ToInt64(parameter));
                    if (rc != SQLITE_OK) throw new InvalidOperationException(Ansi(sqlite3_errmsg(db)));
                }
            }
            List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
            int count = sqlite3_column_count(statement);
            while ((rc = sqlite3_step(statement)) == SQLITE_ROW) {
                Dictionary<string, object> row = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < count; i++) {
                    string name = Ansi(sqlite3_column_name(statement, i));
                    int type = sqlite3_column_type(statement, i);
                    object value = null;
                    if (type == 1 || type == 2) value = sqlite3_column_int64(statement, i);
                    else if (type == 3) value = Utf8(sqlite3_column_text(statement, i), sqlite3_column_bytes(statement, i));
                    row[name] = value;
                }
                rows.Add(row);
            }
            if (rc != SQLITE_DONE) throw new InvalidOperationException(Ansi(sqlite3_errmsg(db)));
            return rows;
        } finally {
            if (statement != IntPtr.Zero) sqlite3_finalize(statement);
            sqlite3_close_v2(db);
        }
    }
}

public static class AedLiveTextMatch {
    public static double Similarity(string left, string right, double threshold) {
        if (left == right) return 1.0;
        if (String.IsNullOrEmpty(left) || String.IsNullOrEmpty(right)) return 0.0;
        string shorter = left.Length <= right.Length ? left : right;
        string longer = left.Length <= right.Length ? right : left;
        int maxDistance = (int)Math.Floor(longer.Length * (1.0 - threshold) + 1e-9);
        if (longer.Length - shorter.Length > maxDistance) return 0.0;
        int[] previous = new int[shorter.Length + 1];
        int[] current = new int[shorter.Length + 1];
        for (int j = 0; j <= shorter.Length; j++) previous[j] = j;
        for (int i = 1; i <= longer.Length; i++) {
            current[0] = i;
            int start = Math.Max(1, i - maxDistance);
            int end = Math.Min(shorter.Length, i + maxDistance);
            for (int j = 1; j < start; j++) current[j] = maxDistance + 1;
            int rowMin = maxDistance + 1;
            for (int j = start; j <= end; j++) {
                int cost = longer[i - 1] == shorter[j - 1] ? 0 : 1;
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + cost);
                rowMin = Math.Min(rowMin, current[j]);
            }
            if (end < shorter.Length) current[end + 1] = maxDistance + 1;
            if (rowMin > maxDistance) return 0.0;
            int[] swap = previous; previous = current; current = swap;
        }
        int distance = previous[shorter.Length];
        return distance > maxDistance ? 0.0 : Math.Max(0.0, 1.0 - distance / (double)longer.Length);
    }
}
'@ -ErrorAction Stop
    } finally {
        $env:LIB = $savedLibPath
    }
}

function Get-AedLiveField {
    param([AllowNull()][object]$Object, [Parameter(Mandatory=$true)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in $Object.Keys) { if ([string]$key -ieq $Name) { return $Object[$key] } }
        return $null
    }
    $property = $Object.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($property) { return $property.Value }
    return $null
}

function ConvertTo-AedLiveText {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return '' }
    if ($Value -is [string]) { return $Value }
    $text = Get-AedLiveField -Object $Value -Name 'text'
    if ($text -is [string]) { return $text }
    return ''
}

function ConvertTo-AedLiveNormalizedText {
    param([Parameter(Mandatory=$true)][string]$Text)
    $normalized = $Text.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $normalized.ToCharArray()) {
        if ([char]::IsLetterOrDigit($character)) { [void]$builder.Append($character) }
    }
    return $builder.ToString()
}

function Test-AedLiveCjk {
    param([Parameter(Mandatory=$true)][string]$Text)
    foreach ($character in $Text.ToCharArray()) {
        $code = [int]$character
        if (($code -ge 0x3400 -and $code -le 0x9FFF) -or ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0x3040 -and $code -le 0x30FF) -or ($code -ge 0xAC00 -and $code -le 0xD7AF)) { return $true }
    }
    return $false
}

function Test-AedLiveEligibleText {
    param([Parameter(Mandatory=$true)][string]$Normalized)
    if ($Normalized.Length -lt 5 -or $Normalized.Length -gt 500) { return $false }
    if ($Normalized -in @('大家好','谢谢大家','非常感谢','好的好的','再见再见','你好','您好','好啊','好的','可以','收到','知道了','明白了','谢谢','谢谢你','没问题','不用谢','再见','拜拜','嗯嗯','是的','不是','goodmorning','thankyou','thankyouverymuch','howareyou','okthankyou','okay','thanks','yes','no','sure','allright','right')) { return $false }
    if (Test-AedLiveCjk -Text $Normalized) { return $Normalized.Length -ge 5 }
    # Latin/common short acknowledgements are too collision-prone for this diagnostic.
    return $Normalized.Length -ge 14
}

function Get-AedLiveSimilarity {
    param([Parameter(Mandatory=$true)][string]$Left, [Parameter(Mandatory=$true)][string]$Right, [bool]$LeftIsCjk = $false, [bool]$RightIsCjk = $false)
    if (-not ('AedLiveTextMatch' -as [type])) { Initialize-AedLiveSqlite }
    $threshold = 0.88
    if ($LeftIsCjk -and $RightIsCjk -and [Math]::Min($Left.Length, $Right.Length) -le 10) { $threshold = 0.80 }
    return [AedLiveTextMatch]::Similarity($Left, $Right, $threshold)
}

function Get-AedLiveEntryViews {
    param(
        [Parameter(Mandatory=$true)][object[]]$Entries,
        [Parameter(Mandatory=$true)][int]$WindowSeconds,
        [int]$MaxParts = 3
    )
    $ordered = @($Entries | Where-Object { $_.final } | Sort-Object -Property openedMs,index)
    $views = New-Object System.Collections.ArrayList
    $roles = @($ordered | Select-Object -ExpandProperty role -Unique)
    foreach ($viewRole in $roles) {
        $roleEntries = @($ordered | Where-Object { $_.role -eq $viewRole })
        for ($end = 0; $end -lt $roleEntries.Count; $end++) {
            $endEntry = $roleEntries[$end]
            $startMin = [Math]::Max(0, $end - $MaxParts + 1)
            for ($start = $startMin; $start -le $end; $start++) {
                $parts = @($roleEntries[$start..$end])
                if ($parts.Count -gt $MaxParts) { continue }
                $valid = $true
                $combined = New-Object System.Text.StringBuilder
                $partIds = New-Object System.Collections.ArrayList
                for ($partIndex = 0; $partIndex -lt $parts.Count; $partIndex++) {
                    $part = $parts[$partIndex]
                    if ($part.role -ne $endEntry.role) { $valid = $false; break }
                    if ($partIndex -gt 0) {
                        $previous = $parts[$partIndex - 1]
                        if (([long]$part.openedMs - [long]$previous.openedMs) -gt ($WindowSeconds * 1000)) { $valid = $false; break }
                    }
                    [void]$combined.Append($part.normalized)
                    [void]$partIds.Add([string]$part.index)
                }
                if (-not $valid) { continue }
                if (([long]$parts[$parts.Count - 1].openedMs - [long]$parts[0].openedMs) -gt ($WindowSeconds * 1000)) { continue }
                $normalized = $combined.ToString()
                if (-not (Test-AedLiveEligibleText -Normalized $normalized)) { continue }
                $isCjk = Test-AedLiveCjk -Text $normalized
                [void]$views.Add([pscustomobject]@{
                    role = $endEntry.role
                    normalized = $normalized
                    isCjk = $isCjk
                    firstMs = [long]$parts[0].openedMs
                    lastMs = [long]$parts[$parts.Count - 1].openedMs
                    ids = @($partIds.ToArray())
                })
            }
        }
    }
    return @($views.ToArray())
}

function Measure-AedLiveCaptionMatch {
    param([Parameter(Mandatory=$true)][string]$Left, [Parameter(Mandatory=$true)][string]$Right, [bool]$LeftIsCjk = $false, [bool]$RightIsCjk = $false)
    $shorter = if ($Left.Length -le $Right.Length) { $Left } else { $Right }
    $longer = if ($Left.Length -le $Right.Length) { $Right } else { $Left }
    $shorterIsCjk = if ($Left.Length -le $Right.Length) { $LeftIsCjk } else { $RightIsCjk }
    $minimumLength = if ($shorterIsCjk) { 5 } else { 14 }
    $contained = $shorter.Length -ge $minimumLength -and $longer.IndexOf($shorter, [StringComparison]::Ordinal) -ge 0
    $threshold = 0.88
    if ($LeftIsCjk -and $RightIsCjk -and [Math]::Min($Left.Length, $Right.Length) -le 10) { $threshold = 0.80 }
    $maxDistance = [int][Math]::Floor($longer.Length * (1.0 - $threshold) + 1e-9)
    if (-not $contained -and ($longer.Length - $shorter.Length) -gt $maxDistance) { return 0.0 }
    $similarity = Get-AedLiveSimilarity -Left $Left -Right $Right -LeftIsCjk $LeftIsCjk -RightIsCjk $RightIsCjk
    if ($contained) {
        $containment = $shorter.Length / [double]$longer.Length
        # A complete, meaningful phrase inside a differently grouped sentence is useful evidence
        # even when the surrounding words make whole-string edit distance low.
        if ($containment -ge 0.25) { $similarity = [Math]::Max($similarity, 0.90) }
    }
    return [double]$similarity
}

function New-AedLiveCaptionMatcherState {
    [CmdletBinding()]
    param(
        [ValidateRange(1,300)][int]$WindowSeconds = 20,
        [ValidateRange(10,200)][int]$MaxEntries = 100,
        [ValidateRange(10,600)][int]$MaxAgeSeconds = 120
    )
    return [pscustomobject]@{
        WindowSeconds = $WindowSeconds
        MaxEntries = $MaxEntries
        MaxAgeSeconds = $MaxAgeSeconds
        Entries = [System.Collections.ArrayList]::new()
        MatchedPairs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        MatchedPairOrder = [System.Collections.ArrayList]::new()
        ProcessedFinals = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        ProcessedFinalOrder = [System.Collections.ArrayList]::new()
        SeenPartialIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        SeenPartialOrder = [System.Collections.ArrayList]::new()
        LastSegmentRowId = 0L
        NextIndex = 0
        MonitorStartedAtUtc = [DateTime]::UtcNow
        PinnedRecordId = $null
        PinnedRecordStartedAtMs = $null
        LastSessionPhase = 'idle'
        Stats = [ordered]@{ polls = 0; rows = 0; finals = 0; partials = 0; speakerFinals = 0; participantFinals = 0; speakerPartials = 0; participantPartials = 0; pollDuplicates = 0; revisions = 0; eligible = 0; comparablePairs = 0; matches = 0; exactMatches = 0; nearMatches = 0 }
        ComparedPairs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        ComparedPairOrder = [System.Collections.ArrayList]::new()
        SuspectedEvents = [System.Collections.ArrayList]::new()
        Evidence = [System.Collections.ArrayList]::new()
    }
}

function New-AedLiveCaptionPollResult {
    param([Parameter(Mandatory=$true)][object]$State)
    $evidence = @($State.Evidence | Select-Object -Last 10)
    return [pscustomobject]@{
        status = if ($State.Stats.comparablePairs -gt 0) { 'observed' } else { 'insufficient_data' }
        reason = if ($State.Stats.speakerFinals -eq 0 -or $State.Stats.participantFinals -eq 0) { 'need finalized source originals from both speaker and participant roles' } elseif ($State.Stats.comparablePairs -eq 0) { 'no comparable source phrases within the time window' } else { $null }
        counts = [pscustomobject]@{ polls = $State.Stats.polls; rows = $State.Stats.rows; finals = $State.Stats.finals; speakerFinals = $State.Stats.speakerFinals; participantFinals = $State.Stats.participantFinals; partials = $State.Stats.partials; speakerPartials = $State.Stats.speakerPartials; participantPartials = $State.Stats.participantPartials; duplicatePolls = $State.Stats.pollDuplicates; revisions = $State.Stats.revisions; eligible = $State.Stats.eligible; comparablePairs = $State.Stats.comparablePairs; matches = $State.Stats.matches; suspectedPairs = $State.Stats.matches; exactMatches = $State.Stats.exactMatches; nearMatches = $State.Stats.nearMatches }
        windowSeconds = $State.WindowSeconds
        evidence = $evidence
        privacy = 'caption text and text-derived identifiers are not returned or written by this function'
    }
}

function Add-AedLiveCaptionPoll {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][object]$State,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Items,
        [DateTime]$PollUtc = [DateTime]::UtcNow,
        [ValidateSet('participant','speaker')][string]$DefaultRole = 'participant'
    )
    $pollMs = [DateTimeOffset]::new($PollUtc.ToUniversalTime()).ToUnixTimeMilliseconds()
    $cutoffMs = $pollMs - ($State.MaxAgeSeconds * 1000)
    while ($State.Entries.Count -gt 0 -and [long]$State.Entries[0].seenMs -lt $cutoffMs) { $State.Entries.RemoveAt(0) }
    $State.Stats.polls++
    if ($Items.Count -eq 0) { return New-AedLiveCaptionPollResult -State $State }
    foreach ($item in $Items) {
        $source = Get-AedLiveField -Object $item -Name 'source'
        if ($null -eq $source) { $source = $item }
        $raw = ConvertTo-AedLiveText -Value $source
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        $normalized = ConvertTo-AedLiveNormalizedText -Text $raw
        if ($normalized.Length -eq 0 -or $normalized.Length -gt 500) { continue }
        $origin = [string](Get-AedLiveField -Object $item -Name 'origin')
        if (-not $origin) { $origin = [string](Get-AedLiveField -Object $item -Name 'id') }
        $segmentId = [string](Get-AedLiveField -Object $item -Name 'id')
        $role = [string](Get-AedLiveField -Object $item -Name 'role')
        if (-not $role) { $role = [string](Get-AedLiveField -Object $item -Name 'leg') }
        if ($role -notin @('speaker','participant')) { $role = $DefaultRole }
        $timeValue = Get-AedLiveField -Object $item -Name 'openedAt'
        if ($null -eq $timeValue) { $timeValue = Get-AedLiveField -Object $item -Name 'at' }
        if ($null -eq $timeValue) { $timeValue = $pollMs }
        try { $openedMs = [long]$timeValue } catch { $openedMs = $pollMs }
        $identity = if ($segmentId) { $segmentId } else { $origin }
        $originKey = if ($identity) { "$role|$identity" } else { "$role|time:$openedMs" }
        $final = Get-AedLiveField -Object $source -Name 'final'
        if ($null -eq $final) { $final = Get-AedLiveField -Object $item -Name 'final' }
        $isFinal = ($final -eq $true)
        if ($isFinal) {
            if ($State.ProcessedFinals.Contains($originKey)) { $State.Stats.pollDuplicates++; continue }
            [void]$State.ProcessedFinals.Add($originKey)
            [void]$State.ProcessedFinalOrder.Add($originKey)
            while ($State.ProcessedFinalOrder.Count -gt 5000) { [void]$State.ProcessedFinals.Remove([string]$State.ProcessedFinalOrder[0]); $State.ProcessedFinalOrder.RemoveAt(0) }
        } else {
            if ($State.SeenPartialIds.Contains($originKey)) { $State.Stats.pollDuplicates++; continue }
            [void]$State.SeenPartialIds.Add($originKey)
            [void]$State.SeenPartialOrder.Add($originKey)
            while ($State.SeenPartialOrder.Count -gt 5000) { [void]$State.SeenPartialIds.Remove([string]$State.SeenPartialOrder[0]); $State.SeenPartialOrder.RemoveAt(0) }
        }
        $State.Stats.rows++
        if ($isFinal) {
            $State.Stats.finals++
            if ($role -eq 'speaker') { $State.Stats.speakerFinals++ } else { $State.Stats.participantFinals++ }
        } else {
            $State.Stats.partials++
            if ($role -eq 'speaker') { $State.Stats.speakerPartials++ } else { $State.Stats.participantPartials++ }
        }
        $prior = $null
        if ($identity) { $prior = @($State.Entries | Where-Object { $_.role -eq $role -and $_.origin -eq $identity } | Select-Object -Last 1) | Select-Object -First 1 }
        if ($prior -and $prior.normalized -ne $normalized) { $State.Stats.revisions++ }
        $State.NextIndex++
        $entry = [pscustomobject]@{ index = $State.NextIndex; role = $role; origin = $identity; normalized = $normalized; final = $isFinal; openedMs = $openedMs; seenMs = $pollMs }
        if (-not $isFinal) {
            [void]$State.Entries.Add($entry)
            while ($State.Entries.Count -gt $State.MaxEntries) { $State.Entries.RemoveAt(0) }
            continue
        }
        if (Test-AedLiveEligibleText -Normalized $normalized) { $State.Stats.eligible++ }
        if ($prior -and $identity) {
            for ($i = $State.Entries.Count - 1; $i -ge 0; $i--) {
                if ($State.Entries[$i].role -eq $role -and $State.Entries[$i].origin -eq $identity) { $State.Entries.RemoveAt($i) }
            }
        }
        [void]$State.Entries.Add($entry)
        while ($State.Entries.Count -gt $State.MaxEntries) { $State.Entries.RemoveAt(0) }
        $viewFloorMs = $openedMs - (2 * $State.WindowSeconds * 1000)
        $viewCeilingMs = $openedMs + ($State.WindowSeconds * 1000)
        $viewEntries = @($State.Entries | Where-Object { [long]$_.openedMs -ge $viewFloorMs -and [long]$_.openedMs -le $viewCeilingMs })
        $views = @(Get-AedLiveEntryViews -Entries $viewEntries -WindowSeconds $State.WindowSeconds)
        $currentViews = @($views | Where-Object { $_.ids -contains [string]$entry.index })
        $otherViews = @($views | Where-Object { $_.role -ne $role } | Sort-Object -Property lastMs -Descending | Select-Object -First 15)
        $observedPairs = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
        foreach ($currentView in $currentViews) {
            foreach ($otherView in $otherViews) {
                $firstMs = [Math]::Min([long]$currentView.firstMs, [long]$otherView.firstMs)
                $lastMs = [Math]::Max([long]$currentView.lastMs, [long]$otherView.lastMs)
                $separation = [Math]::Max(0, [Math]::Max([long]$currentView.firstMs, [long]$otherView.firstMs) - [Math]::Min([long]$currentView.lastMs, [long]$otherView.lastMs))
                if ($separation -gt ($State.WindowSeconds * 1000)) { continue }
                $leftIds = @($currentView.ids | Sort-Object)
                $rightIds = @($otherView.ids | Sort-Object)
                $leftGroup = [string]::Join(',', [string[]]$leftIds)
                $rightGroup = [string]::Join(',', [string[]]$rightIds)
                $pairKey = if ([String]::CompareOrdinal($leftGroup, $rightGroup) -le 0) { "$leftGroup||$rightGroup" } else { "$rightGroup||$leftGroup" }
                $similarity = Measure-AedLiveCaptionMatch -Left $currentView.normalized -Right $otherView.normalized -LeftIsCjk $currentView.isCjk -RightIsCjk $otherView.isCjk
                $speakerIdsForPair = if ($currentView.role -eq 'speaker') { $leftIds } else { $rightIds }
                $participantIdsForPair = if ($currentView.role -eq 'participant') { $leftIds } else { $rightIds }
                foreach ($speakerId in $speakerIdsForPair) {
                    foreach ($participantId in $participantIdsForPair) {
                        $sourcePairKey = "speaker|$speakerId||participant|$participantId"
                        if ($State.ComparedPairs.Add($sourcePairKey)) {
                            [void]$State.ComparedPairOrder.Add($sourcePairKey)
                            $State.Stats.comparablePairs++
                        }
                    }
                }
                if (-not $observedPairs.ContainsKey($pairKey)) {
                    $observedPairs[$pairKey] = [pscustomobject]@{ similarity = $similarity; separationMs = $separation; left = $currentView; right = $otherView }
                } elseif ($similarity -gt $observedPairs[$pairKey].similarity) {
                    $observedPairs[$pairKey] = [pscustomobject]@{ similarity = $similarity; separationMs = $separation; left = $currentView; right = $otherView }
                }
                while ($State.ComparedPairOrder.Count -gt ($State.MaxEntries * $State.MaxEntries)) { [void]$State.ComparedPairs.Remove([string]$State.ComparedPairOrder[0]); $State.ComparedPairOrder.RemoveAt(0) }
            }
        }
        foreach ($candidateKey in $observedPairs.Keys) {
            $candidateMatch = $observedPairs[$candidateKey]
            $similarity = [double]$candidateMatch.similarity
            $matchThreshold = 0.88
            if ($candidateMatch.left.isCjk -and $candidateMatch.right.isCjk -and [Math]::Min($candidateMatch.left.normalized.Length, $candidateMatch.right.normalized.Length) -le 10) { $matchThreshold = 0.80 }
            if ($similarity -lt $matchThreshold -or $State.MatchedPairs.Contains($candidateKey)) { continue }
            $speakerView = if ($candidateMatch.left.role -eq 'speaker') { $candidateMatch.left } else { $candidateMatch.right }
            $participantView = if ($candidateMatch.left.role -eq 'participant') { $candidateMatch.left } else { $candidateMatch.right }
            $speakerIds = [string[]]$speakerView.ids
            $participantIds = [string[]]$participantView.ids
            $eventStartMs = [Math]::Min([long]$candidateMatch.left.firstMs, [long]$candidateMatch.right.firstMs)
            $eventEndMs = [Math]::Max([long]$candidateMatch.left.lastMs, [long]$candidateMatch.right.lastMs)
            $sameEvent = $false
            foreach ($previousEvent in $State.SuspectedEvents) {
                $sharesSpeakerRow = @($speakerIds | Where-Object { $previousEvent.speakerIds -contains $_ }).Count -gt 0
                $sharesParticipantRow = @($participantIds | Where-Object { $previousEvent.participantIds -contains $_ }).Count -gt 0
                $eventGapMs = [Math]::Max(0, [Math]::Max($eventStartMs, [long]$previousEvent.startMs) - [Math]::Min($eventEndMs, [long]$previousEvent.endMs))
                if (($sharesSpeakerRow -or $sharesParticipantRow) -and $eventGapMs -le 3000) { $sameEvent = $true; break }
            }
            if ($sameEvent) {
                [void]$State.MatchedPairs.Add($candidateKey)
                [void]$State.MatchedPairOrder.Add($candidateKey)
                while ($State.MatchedPairOrder.Count -gt ($State.MaxEntries * 3)) { [void]$State.MatchedPairs.Remove([string]$State.MatchedPairOrder[0]); $State.MatchedPairOrder.RemoveAt(0) }
                continue
            }
            [void]$State.MatchedPairs.Add($candidateKey)
            [void]$State.MatchedPairOrder.Add($candidateKey)
            while ($State.MatchedPairOrder.Count -gt ($State.MaxEntries * 3)) { [void]$State.MatchedPairs.Remove([string]$State.MatchedPairOrder[0]); $State.MatchedPairOrder.RemoveAt(0) }
            $State.Stats.matches++
            if ($similarity -ge 0.999) { $State.Stats.exactMatches++ } else { $State.Stats.nearMatches++ }
            $monitorStartMs = [DateTimeOffset]::new($State.MonitorStartedAtUtc).ToUnixTimeMilliseconds()
            $speakerOpenedMs = [long]$speakerView.firstMs
            $participantOpenedMs = [long]$participantView.firstMs
            $method = if (($speakerView.ids.Count -gt 1) -or ($participantView.ids.Count -gt 1)) { 'segmented' } elseif ($similarity -ge 0.999) { 'exact' } elseif ([Math]::Min($speakerView.normalized.Length, $participantView.normalized.Length) -lt [Math]::Max($speakerView.normalized.Length, $participantView.normalized.Length) -and ($speakerView.normalized.Contains($participantView.normalized) -or $participantView.normalized.Contains($speakerView.normalized))) { 'contained' } else { 'near' }
            [void]$State.Evidence.Add([pscustomobject]@{
                first = [int]([Math]::Min([int]$candidateMatch.left.ids[0], [int]$candidateMatch.right.ids[0])); second = [int]([Math]::Max([int]$candidateMatch.left.ids[-1], [int]$candidateMatch.right.ids[-1])); roles = @('speaker','participant')
                monitorOffsetSeconds = [Math]::Round((([Math]::Max($speakerOpenedMs, $participantOpenedMs)) - $monitorStartMs) / 1000.0, 1)
                speakerOffsetMs = [Math]::Round(($speakerOpenedMs - $monitorStartMs), 0)
                participantOffsetMs = [Math]::Round(($participantOpenedMs - $monitorStartMs), 0)
                separationMs = [long]$candidateMatch.separationMs; similarity = [Math]::Round($similarity, 3); method = $method
                firstFinal = $true; secondFinal = $true
            })
            [void]$State.SuspectedEvents.Add([pscustomobject]@{ speakerIds = $speakerIds; participantIds = $participantIds; startMs = $eventStartMs; endMs = $eventEndMs })
            if ($State.SuspectedEvents.Count -gt 30) { $State.SuspectedEvents.RemoveAt(0) }
            if ($State.Evidence.Count -gt 30) { $State.Evidence.RemoveAt(0) }
        }
    }
    return New-AedLiveCaptionPollResult -State $State
}

function Get-AedLiveHistoryDiagnostics {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$UserDataPath,
        [Parameter(Mandatory=$true)][ValidateSet('idle','starting','joining','running','stopping','ended','unverified')][string]$SessionPhase,
        [Parameter(Mandatory=$true)][object]$State,
        [DateTime]$MonitorStartedAtUtc = [DateTime]::MinValue,
        [ValidateRange(10,1000)][int]$MaxRows = 200
    )
    $nowUtc = [DateTime]::UtcNow
    if ($MonitorStartedAtUtc -eq [DateTime]::MinValue) { $MonitorStartedAtUtc = $State.MonitorStartedAtUtc }
    $MonitorStartedAtUtc = $MonitorStartedAtUtc.ToUniversalTime()
    $State.MonitorStartedAtUtc = $MonitorStartedAtUtc
    $State.LastSessionPhase = $SessionPhase
    $dbPath = Join-Path (Join-Path $UserDataPath 'history') 'history.db'
    $base = [ordered]@{ status = 'insufficient_data'; reason = $null; sessionPhase = $SessionPhase; sampledAtUtc = $nowUtc.ToString('o'); counts = $null; evidence = @(); privacy = 'read-only; no text returned or saved' }
    if ($SessionPhase -eq 'idle' -and -not $State.PinnedRecordId) { $base.reason = 'no active session'; return [pscustomobject]$base }
    if (-not [IO.File]::Exists($dbPath)) { $base.reason = 'history database unavailable'; return [pscustomobject]$base }
    try {
        Initialize-AedLiveSqlite
        $version = [AedLiveSqlite]::Query($dbPath, 'pragma user_version')
        if (-not $version -or [int]$version[0]['user_version'] -gt 3) { $base.reason = 'unsupported history schema'; return [pscustomobject]$base }
        $candidates = [AedLiveSqlite]::Query($dbPath, "select r.id, r.started_at, r.ended_at, r.state, r.mode, l.input as participant_input from records r join legs l on l.record_id = r.id and l.leg = 'participant' where r.state = 'open' and r.mode in ('speaker','participant','both') and l.input in ('app','system','tab') order by r.started_at desc limit 8")
        $picked = $null
        if ($State.PinnedRecordId) {
            $pinnedSql = "select r.id, r.started_at, r.ended_at, r.state, r.mode, l.input as participant_input from records r join legs l on l.record_id = r.id and l.leg = 'participant' where r.id = ? and r.mode in ('speaker','participant','both') and l.input in ('app','system','tab') limit 1"
            $pinned = [AedLiveSqlite]::QueryOne($dbPath, $pinnedSql, [string]$State.PinnedRecordId)
            if ($pinned.Count -gt 0) { $picked = $pinned[0] }
        } elseif ($SessionPhase -in @('starting','joining','running','stopping','unverified')) {
            $floorMs = [DateTimeOffset]::new($MonitorStartedAtUtc.ToUniversalTime()).ToUnixTimeMilliseconds()
            $fresh = @($candidates | Where-Object { [long]$_['started_at'] -ge ($floorMs - 5000) })
            if ($fresh.Count -eq 1) { $picked = $fresh[0] }
            elseif ($fresh.Count -eq 0 -and $candidates.Count -eq 1 -and $SessionPhase -in @('running','unverified')) { $picked = $candidates[0] }
            elseif ($fresh.Count -gt 1 -or $candidates.Count -gt 1) { $base.reason = 'multiple open online meeting records; refusing ambiguous binding'; return [pscustomobject]$base }
        }
        if (-not $picked) { $base.reason = 'no unique open online meeting record'; return [pscustomobject]$base }
        if (-not $State.PinnedRecordId) {
            if ([string]$picked['id'] -notmatch '^[A-Za-z0-9-]{8,64}$') { $base.reason = 'record identifier is outside the accepted format'; return [pscustomobject]$base }
            if ($SessionPhase -eq 'unverified') {
                $floorMs = [DateTimeOffset]::new($MonitorStartedAtUtc.ToUniversalTime()).ToUnixTimeMilliseconds()
                $hasRecentSource = [AedLiveSqlite]::QueryBound($dbPath, "select count(*) as n from segments where record_id = ? and leg in ('speaker','participant') and side = 'source' and opened_at >= ?", [string]$picked['id'], $floorMs)
                if (-not $hasRecentSource -or [long]$hasRecentSource[0]['n'] -lt 1) { $base.reason = 'waiting for a post-monitor source segment before binding an unverified session'; return [pscustomobject]$base }
            }
            $State.PinnedRecordId = [string]$picked['id']
            $State.PinnedRecordStartedAtMs = [long]$picked['started_at']
        }
        $floorMs = [DateTimeOffset]::new($MonitorStartedAtUtc).ToUnixTimeMilliseconds()
        $limit = [Math]::Min(500, [Math]::Max(10, $MaxRows))
        $newRowsSql = "select rowid as segment_rowid, id, leg, side, text, final, opened_at, language, origin from segments where rowid > $([long]$State.LastSegmentRowId) and record_id = ? and leg in ('speaker','participant') and side = 'source' and opened_at >= ? order by rowid asc limit $limit"
        $rows = [AedLiveSqlite]::QueryBound($dbPath, $newRowsSql, [string]$State.PinnedRecordId, $floorMs)
        $items = @()
        foreach ($row in $rows) {
            $rowId = [long]$row['segment_rowid']
            if ($rowId -gt $State.LastSegmentRowId) { $State.LastSegmentRowId = $rowId }
            $items += [pscustomobject]@{ id = $row['id']; role = $row['leg']; source = [pscustomobject]@{ text = $row['text']; final = ([long]$row['final'] -eq 1) }; openedAt = [long]$row['opened_at']; origin = $row['origin'] }
        }
        $match = Add-AedLiveCaptionPoll -State $State -Items $items -PollUtc $nowUtc -DefaultRole participant
        $base.status = $match.status
        $base.reason = $match.reason
        $base.counts = [pscustomobject]@{ sourceRows = $rows.Count; matchedSources = $match.counts.eligible; comparablePairs = $match.counts.comparablePairs; suspectedPairs = $match.counts.suspectedPairs; speakerFinals = $match.counts.speakerFinals; participantFinals = $match.counts.participantFinals; crossRoleMatches = $match.counts.matches; exactMatches = $match.counts.exactMatches; nearMatches = $match.counts.nearMatches; finalRows = $match.counts.finals; partialRows = $match.counts.partials; duplicatePolls = $match.counts.duplicatePolls; revisions = $match.counts.revisions }
        $base.evidence = $match.evidence
        $base.recordState = [string]$picked['state']
        $base.recordMode = [string]$picked['mode']
        $base.relativeClock = [pscustomobject]@{ monitorElapsedSeconds = [Math]::Round(($nowUtc - $MonitorStartedAtUtc).TotalSeconds, 1); sessionElapsedSeconds = [Math]::Round(([DateTimeOffset]::new($nowUtc).ToUnixTimeMilliseconds() - [long]$picked['started_at']) / 1000.0, 1) }
        return [pscustomobject]$base
    } catch {
        $base.reason = 'history reader error: ' + $_.Exception.GetType().Name
        return [pscustomobject]$base
    }
}
