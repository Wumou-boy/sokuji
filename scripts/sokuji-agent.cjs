#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs } = require('node:util');
const { agentControlCommunicate, normalizeWorkspaceId, isWorkspaceKey } = require('../electron/agent-control.js');

const HELP = `Usage: sokuji-agent [--profile <userData>] [--json] <command>

  doctor                  Check the Windows connection and session status
  status                  Read the selected provider, input mode and session status
  usage summary [--month YYYY-MM]
                          Read session Token counts and local quota snapshots
  mode meeting            Show Online Meeting while idle
  mode face-to-face       Show Face to Face while idle
  face start              Start Face to Face with the selected microphone
  face replay             Test Face to Face with synthetic audio supplied at launch
  face stop               Stop Face to Face and release its microphone
  audio inputs            Read audio devices, participant source and speech routes
  audio system-check [--auto]
                          Check the selected source or detect a meeting app locally
  audio echo-check [--mic-label <exact-label>]
                          Compare local speaker reference and configured mic capture
  voice benchmark --round N
                          Compare three Qwen voices with the synthetic audio supplied at launch
  credentials status      Check whether OpenAI, Qwen and workspace keys are configured
  notes check bailian     Test Bailian with a built-in sample transcript
  notes check compatible  Test the configured compatible endpoint with the same sample
  start                   Start an incoming-audio, subtitles-only session
  stop                    End the current session
  logs enable             Enable Sokuji diagnostic logging
  logs list [--limit N]    Read recent caption-translation and echo diagnostics
  captions [--limit N]    Read recent paired caption metadata
           [--include-text]  Include the actual source and translation text
  configure qwen-beijing --stdin
                          Configure the shared Bailian Beijing endpoint
  configure qwen-workspace --workspace <id> --stdin
                          Configure a Beijing workspace with its own key
  configure qwen-defaults Select Qwen LiveTranslate and Bailian notes

Start Sokuji with --agent-control first. The path defaults to the installed
Windows profile. Set SOKUJI_AGENT_PROFILE or pass --profile for a test profile.
Commands return JSON. Limits range from 1 to 100, with 20 as the default.`;

const commands = {
  doctor: 'status',
  status: 'status',
  'usage summary': 'usage.summary',
  'mode meeting': 'view.set-mode',
  'mode face-to-face': 'view.set-mode',
  'face start': 'face-to-face.start',
  'face replay': 'face-to-face.replay',
  'face stop': 'face-to-face.stop',
  'audio inputs': 'audio.inputs',
  'audio system-check': 'audio.system-check',
  'audio echo-check': 'audio.echo-check',
  'voice benchmark': 'voice.benchmark',
  'credentials status': 'credentials.status',
  'notes check bailian': 'notes.check',
  'notes check compatible': 'notes.check',
  start: 'session.start',
  stop: 'session.stop',
  'logs enable': 'logs.enable',
  'logs list': 'logs.list',
  captions: 'captions.list',
  'configure qwen-beijing': 'provider.configure-qwen-beijing',
  'configure qwen-workspace': 'provider.configure-qwen-workspace',
  'configure qwen-defaults': 'provider.configure-qwen-defaults',
};

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

async function apiKeyFromPipe(workspace) {
  if (process.stdin.isTTY) return undefined;
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > (workspace ? 4_096 : 300)) return undefined;
  }
  const key = input.trim();
  const valid = workspace ? isWorkspaceKey(key) : /^sk-[A-Za-z0-9._-]{20,250}$/.test(key);
  return valid ? key : undefined;
}

async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      profile: { type: 'string' },
      limit: { type: 'string' },
      'include-text': { type: 'boolean' },
      stdin: { type: 'boolean' },
      workspace: { type: 'string' },
      round: { type: 'string' },
      month: { type: 'string' },
      auto: { type: 'boolean' },
      'mic-label': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    } });
  } catch {
    return failure('invalid_arguments', 'Invalid command options. See sokuji-agent --help.');
  }
  if (parsed.values.help) return HELP;
  const requested = parsed.positionals.join(' ');
  const command = Object.hasOwn(commands, requested) ? commands[requested] : undefined;
  if (!command) return failure('unknown_command', 'Choose a command from sokuji-agent --help.');
  const { profile, limit, 'include-text': includeText } = parsed.values;
  const month = parsed.values.month;
  if (month !== undefined && (command !== 'usage.summary' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
    return failure('invalid_arguments', 'Use --month YYYY-MM with usage summary.');
  }
  if (limit !== undefined && command !== 'logs.list' && command !== 'captions.list') {
    return failure('invalid_arguments', '--limit is available for logs list and captions.');
  }
  if (includeText && command !== 'captions.list') {
    return failure('invalid_arguments', '--include-text is available for captions.');
  }
  if (limit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit)) {
    return failure('invalid_limit', 'The limit must be between 1 and 100.');
  }
  if (process.platform !== 'win32') {
    return failure('unsupported_platform', 'This version of Sokuji agent control requires Windows.');
  }
  const profileDir = profile || process.env.SOKUJI_AGENT_PROFILE
    || (process.env.APPDATA ? path.join(process.env.APPDATA, 'sokuji') : '');
  if (!profileDir) return failure('profile_required', 'Pass the Sokuji user-data path with --profile.');
  const args = {};
  if (parsed.values.auto) {
    if (command !== 'audio.system-check') return failure('invalid_arguments', '--auto is available for audio system-check.');
    args.auto = true;
  }
  if (parsed.values['mic-label'] !== undefined) {
    if (command !== 'audio.echo-check' || parsed.values['mic-label'].length < 1 || parsed.values['mic-label'].length > 180) {
      return failure('invalid_arguments', '--mic-label is available for audio echo-check and must be 1 to 180 characters.');
    }
    args.micLabel = parsed.values['mic-label'];
  }
  if (month !== undefined) args.month = month;
  if (command === 'voice.benchmark') {
    if (!/^[1-9]$/.test(parsed.values.round ?? '')) return failure('invalid_round', 'Use --round 1 through 9.');
    args.round = Number(parsed.values.round);
  } else if (parsed.values.round !== undefined) {
    return failure('invalid_arguments', '--round is available for voice benchmark.');
  }
  if (command === 'view.set-mode') args.mode = requested === 'mode meeting' ? 'meeting' : 'face-to-face';
  if (command === 'notes.check') args.service = requested === 'notes check bailian' ? 'bailian_notes' : 'compatible_notes';
  if (limit !== undefined) args.limit = Number(limit);
  if (includeText) args.includeText = true;
  const workspace = command === 'provider.configure-qwen-workspace';
  if (parsed.values.workspace !== undefined && !workspace) {
    return failure('invalid_arguments', '--workspace is available for configure qwen-workspace.');
  }
  if (workspace) {
    const id = normalizeWorkspaceId(parsed.values.workspace);
    if (!id) return failure('invalid_workspace', 'Pass a Beijing workspace ID with --workspace.');
    args.workspaceId = id;
  }
  if (workspace || command === 'provider.configure-qwen-beijing') {
    if (!parsed.values.stdin) return failure('stdin_required', 'Pipe the selected Bailian API key into the command with --stdin.');
    const key = await apiKeyFromPipe(workspace);
    if (!key) return failure('invalid_key_input', 'Standard input must contain one Bailian API key.');
    args.apiKey = key;
  } else if (parsed.values.stdin) {
    return failure('invalid_arguments', '--stdin is available for Bailian configuration commands.');
  }
  try {
    const result = await agentControlCommunicate({ profileDir: path.resolve(profileDir), command, args, timeoutMs: command === 'audio.echo-check' ? 25_000 : 45_000 });
    if (requested !== 'doctor' || !result.ok) return result;
    return { ok: true, data: { protocolVersion: 1, transport: 'windows-named-pipe', app: result.data } };
  } catch (error) {
    switch (error?.code) {
      case 'AGENT_CONTROL_UNAVAILABLE':
        return failure('endpoint_unavailable', 'Start Sokuji with --agent-control and verify the selected profile.');
      case 'AGENT_CONTROL_TIMEOUT':
        return failure('command_timeout', 'Sokuji did not return a result before the command deadline.');
      case 'AGENT_CONTROL_METADATA_INVALID':
        return failure('endpoint_invalid', 'The local endpoint metadata is invalid. Restart the opted-in Sokuji instance.');
      default:
        return failure('control_failed', 'Could not complete the Sokuji local control request.');
    }
  }
}

run(process.argv.slice(2)).then((result) => {
  if (typeof result === 'string') console.log(result);
  else {
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}).catch(() => {
  console.log(JSON.stringify(failure('control_failed', 'Could not contact the Sokuji local agent endpoint.')));
  process.exitCode = 1;
});
