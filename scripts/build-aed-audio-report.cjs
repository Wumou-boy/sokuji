'use strict';

const fs = require('node:fs');
const path = require('node:path');

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/build-aed-audio-report.cjs <output.cmd>');

const launcher = String.raw`@echo off
setlocal
set "AED_REPORT_CMD=%~f0"
set "AED_REPORT_WORK=%TEMP%\AED-Audio-Report-%RANDOM%-%RANDOM%"
set "AED_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
echo AED offline audio diagnostics are running. This may take a couple of minutes and briefly play a test sound.
"%AED_PS%" -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $r=[IO.File]::ReadAllText($env:AED_REPORT_CMD); $m=[regex]::Match($r,'(?ms)^# AED_REPORT_PS\r?$\n(.*?)^# AED_REPORT_WAV\r?$\n(.*)\z'); if(-not $m.Success){throw 'Invalid AED report package'}; $t=$null; $e=$null; [void][Management.Automation.Language.Parser]::ParseInput($m.Groups[1].Value,[ref]$t,[ref]$e); if($e.Count){throw 'Invalid AED report PowerShell syntax'}; [void][IO.Directory]::CreateDirectory($env:AED_REPORT_WORK); [IO.File]::WriteAllText((Join-Path $env:AED_REPORT_WORK 'run-aed-audio-report.ps1'),$m.Groups[1].Value,[Text.UTF8Encoding]::new($true)); [IO.File]::WriteAllBytes((Join-Path $env:AED_REPORT_WORK 'sample.wav'),[Convert]::FromBase64String($m.Groups[2].Value))"
if errorlevel 1 goto failed
"%AED_PS%" -NoLogo -NoProfile -File "%AED_REPORT_WORK%\run-aed-audio-report.ps1"
if errorlevel 1 goto failed
exit /b 0
:failed
"%AED_PS%" -NoLogo -NoProfile -Command "$dir=[Environment]::GetFolderPath('DesktopDirectory'); if(-not [IO.Directory]::Exists($dir)){$dir=Split-Path -Parent $env:AED_REPORT_CMD}; $p=Join-Path $dir ('AED-Audio-Report-Bootstrap-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.txt'); @('AED Audio Report r2 bootstrap failed','Check Windows PowerShell policy or AED folder access. No cloud call or audio recording was started.','PowerShell: '+$PSVersionTable.PSVersion) | Set-Content -LiteralPath $p -Encoding UTF8; Write-Host ('Report: '+$p); if($env:AED_AUDIO_SUPPRESS_VIEWER -ne '1'){Start-Process notepad.exe -ArgumentList ([char]34+$p+[char]34)}"
exit /b 1`;

function createPlaybackFixture() {
  const rate = 24000;
  const notes = [182, 223, 154, 264, 197, 172, 238, 208, 161, 249, 192, 218];
  const framesPerNote = 4800;
  const frameCount = notes.length * framesPerNote;
  const bytes = Buffer.alloc(44 + frameCount * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frameCount * 2, 40);

  notes.forEach((frequency, noteIndex) => {
    for (let frame = 0; frame < framesPerNote; frame += 1) {
      const progress = frame / framesPerNote;
      const phase = 2 * Math.PI * frequency * (frame / rate);
      const envelope = Math.sin(Math.PI * progress) ** 2;
      const amplitude = 0.34 + 0.08 * Math.sin(noteIndex * 1.62);
      const tone = 0.55 * Math.sin(phase) + 0.3 * Math.sin(2.03 * phase) + 0.15 * Math.sin(5.17 * phase);
      const sample = Math.round(amplitude * envelope * tone * 32767);
      bytes.writeInt16LE(sample, 44 + (noteIndex * framesPerNote + frame) * 2);
    }
  });
  return bytes;
}

const readScript = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const fragments = ['aed-audio-report-windows.ps1', 'aed-audio-report-matrix.ps1'].map(readScript);
const main = readScript('aed-audio-report.ps1');
const marker = '# AED_REPORT_FUNCTIONS';
if (main.split(marker).length !== 2) throw new Error('Expected exactly one function insertion marker.');
const script = main.replace(marker, () => fragments.join('\n'));
const wav = createPlaybackFixture().toString('base64').match(/.{1,120}/g).join('\n');
const archive = [launcher, '# AED_REPORT_PS', script, '# AED_REPORT_WAV', wav, ''].join('\n');
fs.writeFileSync(destination, archive.replace(/\n/g, '\r\n'), 'utf8');
