'use strict';

// Assemble one transparent CMD for the existing portable install; no Node.js at the recipient.
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const launcher = String.raw`@echo off
setlocal DisableDelayedExpansion
rem The monitor loads only Windows framework assemblies, not a developer SDK.
set "LIB="
set "AED_LIVE_CMD=%~f0"
set "AED_LIVE_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%AED_LIVE_PS%" -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $raw=[IO.File]::ReadAllText($env:AED_LIVE_CMD); $marker=[regex]::Match($raw,'(?m)^# AED_LIVE_PAYLOAD\r?$'); if(-not $marker.Success){throw 'Missing monitor payload'}; $body=$raw.Substring($marker.Index+$marker.Length); $tokens=$null; $issues=$null; $parsed=[Management.Automation.Language.Parser]::ParseInput($body,[ref]$tokens,[ref]$issues); if($issues.Count){throw $issues[0]}; & $parsed.GetScriptBlock()"
if not errorlevel 1 exit /b 0
echo Could not finish the meeting monitor. See the message and desktop report above.
if not defined AED_LIVE_QA_SECONDS pause
exit /b 1`;
const files = ['aed-live-agent.ps1', 'aed-live-system-meter.ps1', 'aed-live-caption-match.ps1'];
const main = read('aed-live-meeting.ps1').replace('__AED_VERSION__', require('../package.json').aedVersion);
const marker = '# AED_LIVE_FUNCTIONS';
if (main.split(marker).length !== 2) throw new Error('Missing function insertion point');
const packed = main.replace(marker, () => files.map(read).join('\n'));
if (!process.argv[2]) throw new Error('Pass output .cmd path');
fs.writeFileSync(process.argv[2], [launcher, '# AED_LIVE_PAYLOAD', packed, ''].join('\n').replace(/\n/g, '\r\n'), 'utf8');
