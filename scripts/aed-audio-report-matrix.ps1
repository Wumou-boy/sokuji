function Test-AedCaptureMatrix {
    param(
        $inputs,
        [string]$endpointLabel
    )

    Add-Line '[Comprehensive local capture matrix]'
    Add-Line 'Scope: idle AED diagnostics with local synthetic playback; no meeting/session start, provider request, raw PCM, captions, or preference writes.'
    # Probe the saved source only when it is an exact physical endpoint or System.
    # In particular, never probe a saved application source: it could select
    # unrelated application audio and make the synthetic test misleading.
    $savedScope = [string]$inputs.participantSource.scope
    $savedLabel = [string]$inputs.participantSource.label
    $safeSavedEndpoint = $savedScope -eq 'endpoint' -and $savedLabel -and
        @($inputs.participantOutputs | Where-Object { $_ -ceq $savedLabel }).Count -eq 1
    if ($safeSavedEndpoint -or $savedScope -eq 'system') {
        $savedArgs = @{}
        if ($safeSavedEndpoint) { $savedArgs.endpointLabel = $savedLabel }
        try {
            $savedProbe = Invoke-Aed -Command audio.system-check -Arguments $savedArgs
            Add-Result ('audio.system-check saved source (' + $(if ($safeSavedEndpoint) { $savedLabel } else { 'System' }) + ')') $savedProbe
        } catch {
            Add-Line ('audio.system-check saved-source probe: failed (' + $_.Exception.Message + ')')
        }
    } else {
        Add-Line ('audio.system-check saved-source probe: skipped; saved source scope=' + $(if ($savedScope) { $savedScope } else { 'unknown' }) + '. application was not opened to avoid unrelated audio.')
    }
    if ($endpointLabel) {
        try {
            $endpointProbe = Invoke-Aed -Command audio.system-check -Arguments @{ endpointLabel = $endpointLabel }
            Add-Result ('audio.system-check exact endpoint (' + $endpointLabel + ')') $endpointProbe
        } catch {
            Add-Line ('audio.system-check exact endpoint (' + $endpointLabel + '): failed (' + $_.Exception.Message + ')')
        }
    } else {
        Add-Line 'audio.system-check exact endpoint: skipped; no unique verified physical endpoint label was supplied.'
    }
}
