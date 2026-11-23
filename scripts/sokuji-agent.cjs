#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs } = require('node:util');
const { agentControlCommunicate } = require('../electron/agent-control.js');

const HELP = `Usage: sokuji-agent [--profile <userData>] [--json] <command>

  doctor                  Check the Windows connection and session status
  status                  Read the selected provider, input mode and session status
  credentials status      Check whether OpenAI and Qwen keys are configured
  notes check bailian     Test Bailian with a built-in sample transcript
  notes check compatible  Test the configured compatible endpoint with the same sample
  start                   Start an incoming-audio, subtitles-only session
  stop                    End the current session
  logs enable             Enable Sokuji diagnostic logging
  logs list [--limit N]    Read recent caption-translation diagnostics
  captions [--limit N]    Read recent paired caption metadata
           [--include-text]  Include the actual source and translation text
  configure qwen-beijing --stdin
                          Save one Bailian API Key without switching providers

Start Sokuji with --agent-control first. The path defaults to the installed
Windows profile. Set SOKUJI_AGENT_PROFILE or pass --profile for a test profile.
Commands return JSON. Limits range from 1 to 100, with 20 as the default.`;

const commands = {
  doctor: 'status',
  status: 'status',
  'credentials status': 'credentials.status',
  'notes check bailian': 'notes.check',
  'notes check compatible': 'notes.check',
  start: 'session.start',
  stop: 'session.stop',
  'logs enable': 'logs.enable',
  'logs list': 'logs.list',
  captions: 'captions.list',
  'configure qwen-beijing': 'provider.configure-qwen-beijing',
};

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

async function apiKeyFromPipe() {
  if (process.stdin.isTTY) return undefined;
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 300) return undefined;
  }
  const key = input.trim();
  return /^sk-[A-Za-z0-9._-]{20,250}$/.test(key) ? key : undefined;
}

async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      profile: { type: 'string' },
      limit: { type: 'string' },
      'include-text': { type: 'boolean' },
      stdin: { type: 'boolean' },
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
  if (command === 'notes.check') args.service = requested === 'notes check bailian' ? 'bailian_notes' : 'compatible_notes';
  if (limit !== undefined) args.limit = Number(limit);
  if (includeText) args.includeText = true;
  if (command === 'provider.configure-qwen-beijing') {
    if (!parsed.values.stdin) return failure('stdin_required', 'Pipe the key into configure qwen-beijing --stdin.');
    const key = await apiKeyFromPipe();
    if (!key) return failure('invalid_key_input', 'Standard input must contain one Bailian API key.');
    args.apiKey = key;
  } else if (parsed.values.stdin) {
    return failure('invalid_arguments', '--stdin is available for configure qwen-beijing.');
  }
  try {
    const result = await agentControlCommunicate({ profileDir: path.resolve(profileDir), command, args, timeoutMs: 45_000 });
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
