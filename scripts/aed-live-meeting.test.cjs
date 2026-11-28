'use strict';

// Windows integration with a synthetic AED session. Uses the production history schema,
// matcher, log reducer, report writer, and real Windows render meters. No cloud session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS } = require('../electron/history-schema');
const appDir = process.env.AED_LIVE_QA_APPDIR;

test('reports Teams tree counts and competing audio on the same endpoint without logging process IDs', {
  skip: process.platform !== 'win32',
}, () => {
  const script = path.join(__dirname, 'aed-live-system-meter.ps1');
  const probe = [
    '$t=$null; $e=$null; $parsed=[Management.Automation.Language.Parser]::ParseFile($env:AED_METER_SCRIPT,[ref]$t,[ref]$e)',
    'if ($e.Count) {throw $e[0]}; . $parsed.GetScriptBlock()',
    '$rows=ConvertFrom-Json $env:AED_METER_ROWS',
    'ConvertTo-Json -InputObject @(Get-AedLiveEndpointOwnership -Rows $rows) -Compress',
  ].join('\n');
  const rows = [[41, 'ms-teams.exe', 0.9], [42, 'ms-teams.exe', 0.3], [41, 'ms-teams.exe', 0],
    [43, 'other.exe', 0.1], [44, 'silent.exe', 0]].map(([pid, exe, peak]) =>
    ({ pid, rootPid: pid, rootExe: exe, exe, active: true, shared: false, system: false, peak, endpointId: 'private-id', endpointLabel: 'speaker' }));
  const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', probe], { encoding: 'utf8',
    env: { ...process.env, AED_METER_SCRIPT: script, AED_METER_ROWS: JSON.stringify(rows) } });
  assert.deepEqual(JSON.parse(result), [{ EndpointLabel: 'speaker', ActiveTeamsRows: 3, VerifiedTeamsRoots: 2,
    AudibleVerifiedTeamsRoots: 2, UnverifiedTeamsRows: 0, PackageLoopbackReaders: 0, OtherAudibleRows: 1, OtherUncertainRows: 0 }]);
});

const fakeAgent = `
$userDataPath = $env:AED_FIXTURE_PROFILE
$script:poll = 0
$script:events = @()
function Invoke-AedLiveAgent($Command, $Arguments) {
    switch ($Command) {
        'status' {
            $script:poll++
            if ($script:poll -eq 5) { throw 'agent_timeout' }
            $phase = if ($script:poll -eq 1 -or $script:poll -ge 8) { 'idle' } elseif ($script:poll -eq 2) { 'starting' } else { 'running' }
            return @{ phase = $phase; appVersion = 'fixture'; appMode = 'meeting'; audioMode = 'both'; appReady = $true; diagnosticLogsEnabled = $true }
        }
        'logs.list' {
            return @{events=@()}
        }
        'audio.inputs' {
            $pcm = if ($script:poll -ge 3 -and $script:poll -lt 7) {
                @{totalSamples=(480*$script:poll);blocksAtOrAboveThreshold=$script:poll;threshold=0.012}
            } else { $null }
            return @{participantSource=@{scope='system';label='System Audio'};participantCaptureWidened=$false;microphoneEchoMode='all';meetingMicMuted=$false;meetingInput=@{label='fixture mic';virtual=$false};systemOutputForm=@{formFactor='speakers';transport='builtin'};participantPcmRuntime=$pcm}
        }
        default { throw 'unexpected command' }
    }
}
`;

test('joined meeting, current captions only, two-leg match, system source and speaker output, automatic finish', {
  skip: process.platform !== 'win32' || !appDir, timeout: 60_000,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aed-live-'));
  try {
    const cmd = path.join(temp, 'live.cmd');
    execFileSync(process.execPath, [path.join(__dirname, 'build-aed-live-meeting.cjs'), cmd]);
    const payload = fs.readFileSync(cmd, 'utf8').split(/^# AED_LIVE_PAYLOAD\r?$/m)[1];
    assert.ok(payload.includes('$backend = New-AedBackendState'));
    const qaFile = path.join(temp, 'qa.ps1');
    fs.writeFileSync(qaFile, '\ufeff' + payload.replace('$backend = New-AedBackendState', () => fakeAgent + '\n$backend = New-AedBackendState'));

    fs.mkdirSync(path.join(temp, 'history'));
    const db = new DatabaseSync(path.join(temp, 'history', 'history.db'));
    const utterance = '测试相同原文覆盖中英文字幕诊断样本';
    const oldUtterance = 'private previous meeting not monitored';
    const t0 = Date.now();
    try {
      MIGRATIONS.forEach(sql => db.exec(sql));
      db.exec('pragma user_version=3');
      const rec = db.prepare("insert into records(id,started_at,state,mode,my_language,target_language,services,app_version) values(?,?,?,'both','zh','en','{}','fixture')");
      const leg = db.prepare("insert into legs(record_id,leg,source_language,target_language,input,translated,spoken) values(?,?,'zh','en',?,1,0)");
      const seg = db.prepare("insert into segments(record_id,id,leg,position,ref,side,text,final,opened_at,origin,marks) values(?,?,?,1,1,?,?,1,?,?,'[]')");
      for (const [id, state, when] of [['run-previous','closed', t0-180000], ['run-current','open',t0+2200]]) {
        rec.run(id, when, state);
        for (const [role, input] of [['participant','system'], ['speaker','microphone']]) {
          leg.run(id, role, input);
          const laneTime = when + (role === 'speaker' ? 1600 : 800);
          seg.run(id, role, role, 'source', id === 'run-current' ? utterance : oldUtterance, laneTime, role);
          seg.run(id, role+'-tr', role, 'translation', 'sensitive translated content', laneTime, role);
          seg.run(id, role+'-ack', role, 'source', '好的', laneTime+10, role+'-ack');
          seg.run(id, role+'-prior', role, 'source', 'an older sentence outside the monitoring interval', t0-10000, role+'-prior');
        }
      }
    } finally { db.close(); }
    const start = "$e=$null;$t=$null;$s=[Management.Automation.Language.Parser]::ParseFile($env:AED_FIXTURE_SCRIPT,[ref]$t,[ref]$e);if($e.Count){throw $e[0]};& $s.GetScriptBlock()";
    const ps = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const child = spawn(ps, ['-NoProfile','-NoLogo','-Command',start], { windowsHide: true,
      env: { ...process.env, LIB:'', AED_LIVE_CMD: path.join(appDir, 'AED-Teams-Live.cmd'), AED_LIVE_QA_OUTPUT:temp,
        AED_LIVE_QA_SECONDS:'40', AED_FIXTURE_PROFILE:temp, AED_FIXTURE_SCRIPT:qaFile },
      stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', v => {output += v;});
    child.stderr.on('data', v => {output += v;});
    await new Promise((resolve,reject) => { child.on('error',reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(output))); });
    const report = fs.readFileSync(path.join(temp, fs.readdirSync(temp).find(s => /^AED-Teams-Live.*\.txt$/.test(s))), 'utf8');
    const rows = report.trim().split(/\r?\n/).map(s => JSON.parse(s));
    assert.ok(!report.includes(utterance) && !report.includes(oldUtterance) && !report.includes('sensitive translated content'));
    const summary = rows.at(-1).data;
    const checkpoint = rows.find(row => row.kind === 'checkpoint');
    assert.ok(checkpoint && checkpoint.data.finish === 'session_ended_awaiting_final_captions');
    assert.ok(checkpoint.data.samples > 0 && checkpoint.data.samples < summary.samples);
    assert.equal(summary.finish, 'AED_session_finished');
    assert.ok(summary.attachedPolls > 0);
    assert.ok(!rows.some(r => r.data?.appClock === 'old'));
    assert.ok(rows.some(r => r.kind === 'sample' && r.data.systemOutputForm?.formFactor === 'speakers' && r.data.configuredBrowserEchoMode === 'all'));
    assert.ok(rows.some(r => r.kind === 'source' && r.data.scope === 'system'));
    assert.ok(rows.some(r => r.kind === 'source' && r.data.participantPcm?.totalSamples > 0 &&
      r.data.participantPcm.blocksAtOrAboveThreshold > 0 && r.data.participantPcm.threshold === 0.012));
    assert.ok(rows.some(r => r.kind === 'caption_check' && r.data.evidence?.length),
      'Expected a two-leg match: ' + JSON.stringify(rows.filter(r => r.kind === 'caption_check').map(r => [r.data.reason,r.data.counts])));
    assert.equal(summary.lastCaptionCheck.counts.crossRoleMatches, 1, 'exclude pre-monitor text, translations, and brief acknowledgements');
    assert.ok(summary.lastCaptionCheck.counts.comparablePairs >= 1);
  } finally {
    const real = fs.realpathSync(temp);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(real), /^aed-live-[A-Za-z0-9]+$/);
    fs.rmSync(real, {recursive:true,force:true});
  }
});
