# Local agent control on Windows

Start the desktop app with `sokuji.exe --agent-control`. The command interface
is disabled by default. It uses a Windows named pipe and a temporary credential
in the app's current user-data directory. A normal launch does not accept agent
commands.

Run `node scripts/sokuji-agent.cjs --help` from this checkout. From a different
directory, use the absolute path to the script or install a local command shim.
Pass `--profile <user-data-dir>` or set `SOKUJI_AGENT_PROFILE` for a custom
profile. The CLI defaults to the installed Windows profile.

```powershell
sokuji-agent --json doctor
sokuji-agent status
sokuji-agent credentials status
sokuji-agent notes check bailian
sokuji-agent notes check compatible
sokuji-agent logs enable
sokuji-agent start
sokuji-agent captions --limit 10
sokuji-agent stop
sokuji-agent logs list --limit 20
```

`start` uses incoming audio and turns off translated audio for that session.
It opens the selected provider using the app's existing configuration.
Inspect `status` before starting. Start and stop only when the current request
authorizes the corresponding action.

`logs list` returns caption request metadata, including status, elapsed time
and safe error categories. `captions` omits text unless `--include-text` is
present. Use that option only when the caller intends to read the caption
content. Keep the endpoint credential files in the app profile.

`sokuji-agent configure qwen-beijing --stdin` adds Bailian Beijing to the current
profile while Sokuji is idle. Pipe one API key from a credential source into
standard input. This keeps the current provider and language pair. Use
`credentials status` to check whether OpenAI and Qwen have keys configured.
Both commands return only status information.

`notes check` runs the built-in synthetic transcript through a configured notes
service. It leaves the notes provider and meeting settings as selected, and
does not write a history record. It may incur model usage at the chosen service.

Commands emit one JSON object. Success is `{"ok":true,"data":...}` with exit
status 0. Failure is `{"ok":false,"error":{"code":"...","message":"..."}}`
with exit status 1. A missing endpoint usually means the app was launched
without the flag or the CLI is using the wrong profile.
