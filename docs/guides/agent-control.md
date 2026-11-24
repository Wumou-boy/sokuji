# Local agent control on Windows

Start the Windows portable app with `& '.\AED Translator.exe' --agent-control`. The command interface
is disabled by default. It uses a Windows named pipe and a temporary credential
in the app's current user-data directory. A normal launch does not accept agent
commands.

To package the Windows portable app, set `AED_WINDOWS_PORTABLE=1` when running
`npm run package`. This gives the ZIP's launcher the name `AED Translator.exe`.

Run `node scripts/sokuji-agent.cjs --help` from this checkout. From a different
directory, use the absolute path to the script or install a local command shim.
Pass `--profile <user-data-dir>` or set `SOKUJI_AGENT_PROFILE` for a custom
profile. The CLI defaults to the installed Windows profile.

```powershell
sokuji-agent --json doctor
sokuji-agent status
sokuji-agent usage summary --month 2026-11
sokuji-agent credentials status
sokuji-agent notes check bailian
sokuji-agent notes check compatible
sokuji-agent logs enable
sokuji-agent start
sokuji-agent captions --limit 10
sokuji-agent stop
sokuji-agent logs list --limit 20
```

`usage summary` reads the current month by default. It returns current and recent
session Token counts, monthly use and the latest free-quota snapshots. It makes
no provider requests.

`start` uses incoming audio and turns off translated audio for that session.
It opens the selected provider using the app's existing configuration.
The status includes the app mode and the face-to-face phase. Incoming-audio
`start` is available from the Online Meeting mode.
Use `mode meeting` or `mode face-to-face` to open a mode while idle.
In Face to Face, use `face start` to open the selected microphone and
`face stop` to release it. `status` shows the startup stage, audio frame
count, subtitle coverage and speaker numbers without returning audio or conversation
text. With `--face-replay-pcm=<path>` at launch, `face replay` uses a 1–30 second
synthetic 24 kHz mono PCM16LE fixture with the same translation runtime. Use
`face stop` after the captions finish. The status reports how many source
turns needed a second Qwen LiveTranslate direction and the submitted PCM sample
count, alongside the recent subtitle and speaker metadata.
Use `audio inputs` to read the selected microphone, Windows default devices,
virtual microphone output, and configured speech routes without opening an
audio stream. `participantApplications` lists the applications Windows discovered
with audio sessions. `microphoneEchoMode` reports the configured echo mode.
`participantCaptureWidened` reports whether application capture
fell back to the system mix.
`audio system-check` briefly opens the current participant source in idle
Online Meeting and releases it. It runs locally and does not play audio or
contact a translation provider.
`audio system-check --auto` starts sampling meeting applications immediately
and waits up to 12 seconds for audio to appear. It reports the app it opened
and its local PCM peak (`peakLevel`, 0–1) without changing the saved source.
`audio echo-check` runs a local 5.5-second comparison between automatically
detected application audio and the configured microphone. It reports only the
selected app, configured and applied browser AEC, reference and microphone RMS
before and after Sokuji's software echo reduction, and the count of correlated
microphone chunks. It stores no audio, starts no session, contacts no provider,
and does not change saved devices. `--mic-label "Realtek Microphone"` captures
an exact listed device for this check only; omit it to use the configured mic.
If that microphone cannot open, the check fails instead of switching to another
device. Both sources are released when the check ends or fails.

`voice benchmark --round 1` compares a preset, the selected fixed Qwen
voice, and per-turn voice cloning against the same synthetic sample.
Start the app with `--agent-control --voice-benchmark-pcm=<path>` and supply
one to eight seconds of 24 kHz mono PCM16LE. Use rounds 1, 2, and 3 to rotate
the order. It uses the saved Bailian key, sends the sample for translation,
and reports timings and sample counts.
Inspect `status` before starting. Start and stop only when the current request
authorizes the corresponding action.

`logs list` returns caption request metadata, including status, elapsed time
and safe error categories. It includes speech boundary and caption delta event
times without the caption contents. Capture entries report the participant
backend and the echo cancellation mode requested and applied to the microphone.
Detected echo appears as `audio.echo.warning` with cause, delay, and correlation.
`captions` omits text unless `--include-text` is
present. Use that option only when the caller intends to read the caption
content. Keep the endpoint credential files in the app profile.

`sokuji-agent configure qwen-beijing --stdin` adds Bailian Beijing to the current
profile while Sokuji is idle. Pipe one API key from a credential source into
standard input. This keeps the current provider and language pair. Use
`credentials status` to check whether OpenAI and Qwen have keys configured.
Both commands return only status information.

`sokuji-agent configure qwen-workspace --workspace <id> --stdin` selects the
dedicated Beijing workspace connection and saves its key separately in the
same profile. Pipe the company workspace key to standard input. Use
`credentials status` to check the workspace key's presence.

`sokuji-agent configure qwen-defaults` selects Qwen 3.8 LiveTranslate and
Bailian notes with `qwen3.8-flash` in the current profile while Sokuji is idle.
It keeps the selected Qwen connection and saved credentials. `status` reports
the selected translation and notes services and the Qwen models when selected.

`notes check` runs the built-in synthetic transcript through a configured notes
service. It leaves the notes provider and meeting settings as selected, and
does not write a history record. It may incur model usage at the chosen service.

Commands emit one JSON object. Success is `{"ok":true,"data":...}` with exit
status 0. Failure is `{"ok":false,"error":{"code":"...","message":"..."}}`
with exit status 1. A missing endpoint usually means the app was launched
without the flag or the CLI is using the wrong profile.
