import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { settleReports } from '../../diagnostics/report';
import { SourceOpenError } from '../../session/source';
import useLogStore from '../../../stores/logStore';
import { TRACK_ENDED } from './core';
import {
  APP_CAPTURE_LOST, APP_MONITOR_MISSING, AUTO_MEETING_SOURCE, LOOPBACK_DENIED, LOOPBACK_MEETING_OUTPUT, SILENT_NO_PERMISSION, electronSystemAudio, openSystemAudio,
  type ParticipantCapture, type SystemAudioDeps, type SystemAudioSettings,
} from './systemAudio';

/** A participant recorder that records its calls; `push` delivers a chunk while it records. */
function fakeCapture(o: { begins?: boolean; started?: Promise<boolean>; stream?: MediaStream; failure?: unknown } = {}) {
  let callback: ((data: { mono: Int16Array }) => void) | null = null;
  const capture = {
    begun: [] as Array<{ deviceId?: string } | undefined>,
    ended: 0,
    beginFailure: o.failure,
    onLost: null as (() => void) | null,
    onWarning: null as ((code: string) => void) | null,
    onAudioSeen: null as (() => void) | null,
    async begin(options?: { deviceId?: string }) {
      capture.begun.push(options);
      return o.started ?? o.begins ?? true;
    },
    async record(fn: (data: { mono: Int16Array }) => void) {
      callback = fn;
      return true;
    },
    async end() {
      capture.ended += 1;
      // A helper killed by its own teardown reports an exit; `onLost` must be detached by now.
      capture.onLost?.();
      callback = null;
    },
    getStream: () => o.stream ?? null,
    push: (pcm = new Int16Array(4)) => callback?.({ mono: pcm }),
  };
  return capture satisfies ParticipantCapture;
}

function setup(o: {
  answer?: unknown;
  resolution?: unknown;
  devices?: Array<{ kind: string; label: string; deviceId: string; groupId?: string }>;
  app?: ReturnType<typeof fakeCapture>;
  device?: ReturnType<typeof fakeCapture>;
  loopback?: ReturnType<typeof fakeCapture>;
  nativeLoopback?: ReturnType<typeof fakeCapture>;
  sourceId?: string;
  screenRecording?: string;
} = {}) {
  const invoked: Array<[string, unknown]> = [];
  const answers: unknown[] = Array.isArray(o.answer) ? [...o.answer] : [o.answer ?? { success: true, capture: 'system' }];
  const app = o.app ?? fakeCapture();
  const device = o.device ?? fakeCapture();
  const loopback = o.loopback ?? fakeCapture();
  const wait = vi.fn(async () => {});
  const screenRecording = vi.fn(async () => o.screenRecording ?? 'granted');
  const appLostListeners = new Set<() => void>();
  const deps: SystemAudioDeps = {
    invoke: async (channel, data) => {
      invoked.push([channel, data]);
      if (channel === 'connect-system-audio-source') return answers.length > 1 ? answers.shift() : answers[0];
      if (channel === 'resolve-auto-system-audio-source') return typeof o.resolution === 'function' ? o.resolution() : o.resolution ?? { success: false };
      return { success: true };
    },
    enumerateDevices: async () => (o.devices ?? []) as MediaDeviceInfo[],
    wait,
    app: () => app,
    device: () => device,
    loopback: () => loopback,
    ...(o.nativeLoopback ? { nativeLoopback: () => o.nativeLoopback! } : {}),
    appLost: (listener) => {
      appLostListeners.add(listener);
      return () => { appLostListeners.delete(listener); };
    },
    screenRecording,
  };
  /** The main process says the application the PipeWire tap follows has quit. */
  const appQuit = () => { for (const listener of [...appLostListeners]) listener(); };
  let current = { sourceId: o.sourceId ?? 'desktop-audio-loopback', muted: false };
  const listeners = new Set<() => void>();
  const audioSeen = vi.fn();
  const widened = vi.fn();
  const autoResolved = vi.fn();
  const settings: SystemAudioSettings = {
    sourceId: () => current.sourceId,
    muted: () => current.muted,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    audioSeen,
    widened,
    autoResolved,
  };
  const set = (patch: Partial<typeof current>) => {
    current = { ...current, ...patch };
    for (const listener of listeners) listener();
  };
  return { deps, settings, set, invoked, app, device, loopback, wait, audioSeen, widened, autoResolved, screenRecording, appQuit, appLostListeners };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const live = () => new AbortController().signal;

describe('automatic meeting audio', () => {
  const zoom = { deviceId: 'app:pid:42', label: 'Zoom', appKey: 'Zoom.exe' };
  const teams = { deviceId: 'app:pid:43', label: 'Teams', appKey: 'ms-teams.exe' };
  const scan = ['resolve-auto-system-audio-source', undefined];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens silently, then attaches when a later scan hears a meeting app', async () => {
    const resolution = vi.fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValue({ success: true, source: zoom });
    const s = setup({ sourceId: AUTO_MEETING_SOURCE, answer: { success: true, capture: 'app' }, resolution });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const heard = vi.fn();
    const ended = vi.fn();
    source.onPcm(heard);
    source.onEnded(ended);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(s.invoked).toEqual([scan, scan]);
    expect(ended).not.toHaveBeenCalled();
    expect(s.app.begun).toHaveLength(0);
    expect(s.autoResolved).toHaveBeenLastCalledWith(null);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(s.app.begun).toEqual([{ deviceId: zoom.deviceId }]);
    expect(s.autoResolved).toHaveBeenLastCalledWith(zoom);
    s.app.push();
    expect(heard).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(resolution).toHaveBeenCalledTimes(3);

    await source.stop();
    expect(s.autoResolved).toHaveBeenLastCalledWith(null);
    expect(s.loopback.begun).toHaveLength(0);
  });

  it('returns to waiting when the chosen app exits and attaches to a later app', async () => {
    const resolution = vi.fn()
      .mockResolvedValueOnce({ success: true, source: zoom })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValue({ success: true, source: teams });
    const s = setup({ sourceId: AUTO_MEETING_SOURCE, answer: { success: true, capture: 'app' }, resolution });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const ended = vi.fn();
    source.onEnded(ended);
    await vi.advanceTimersByTimeAsync(0);
    s.app.onLost?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.autoResolved).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(s.app.begun).toEqual([{ deviceId: zoom.deviceId }, { deviceId: teams.deviceId }]);
    expect(s.autoResolved).toHaveBeenLastCalledWith(teams);
    expect(s.loopback.begun).toHaveLength(0);
    expect(ended).not.toHaveBeenCalled();
    await source.stop();
  });

  it('cancels search when stopped and ignores a probe overtaken by a manual choice', async () => {
    let resolveProbe: (result: unknown) => void = () => {};
    const resolution = vi.fn(() => new Promise((resolve) => { resolveProbe = resolve; }));
    const s = setup({ sourceId: AUTO_MEETING_SOURCE, resolution });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    await vi.advanceTimersByTimeAsync(0);
    s.set({ sourceId: 'desktop-audio-loopback' });
    resolveProbe({ success: true, source: zoom });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(resolution).toHaveBeenCalledOnce();
    expect(s.app.begun).toHaveLength(0);
    expect(s.loopback.begun).toHaveLength(1);
    s.set({ sourceId: AUTO_MEETING_SOURCE });
    await source.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolution).toHaveBeenCalledOnce();
  });
});

describe('openSystemAudio — opening', () => {
  const cableDefault = [
    { kind: 'audiooutput', label: 'Default - CABLE Input', deviceId: 'default', groupId: 'same-endpoint' },
    { kind: 'audiooutput', label: 'CABLE Input', deviceId: 'send-to-meeting', groupId: 'same-endpoint' },
  ];

  it('keeps Auto closed if the connected source does not affirm app-scoped capture', async () => {
    const s = setup({
      sourceId: 'auto-meeting-audio',
      resolution: { success: true, source: { deviceId: 'app:pid:42', label: 'Zoom', appKey: 'Zoom.exe' } },
      answer: { success: true, capture: 'system' },
    });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    await vi.waitFor(() => expect(s.invoked).toContainEqual(['connect-system-audio-source', 'app:pid:42']));
    await source.stop();
    expect(s.invoked).toContainEqual(['connect-system-audio-source', 'app:pid:42']);
    expect(s.loopback.begun).toHaveLength(0);
    expect(s.autoResolved).toHaveBeenLastCalledWith(null);
  });

  it('blocks Windows system capture if it would capture the same endpoint as the outgoing translation', async () => {
    const s = setup({ devices: cableDefault, nativeLoopback: fakeCapture() });
    await expect(openSystemAudio({ ...s.settings, meetingOutput: () => 'send-to-meeting' }, live(), s.deps))
      .rejects.toMatchObject({ code: LOOPBACK_MEETING_OUTPUT });
    expect(s.loopback.begun).toHaveLength(0);
  });

  it('leaves a virtual default usable for incoming-only captions or when the capture is scoped to an app', async () => {
    const incomingOnly = setup({ devices: cableDefault, nativeLoopback: fakeCapture() });
    const system = await openSystemAudio(incomingOnly.settings, live(), incomingOnly.deps);
    await system.stop();
    expect(incomingOnly.loopback.begun).toHaveLength(1);

    const meeting = setup({ devices: cableDefault, nativeLoopback: fakeCapture(), sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    const source = await openSystemAudio({ ...meeting.settings, meetingOutput: () => 'send-to-meeting' }, live(), meeting.deps);
    await source.stop();
    expect(meeting.app.begun).toEqual([{ deviceId: 'app:42' }]);
  });

  it('does not widen a lost Windows app capture to the outbound virtual cable', async () => {
    const s = setup({ devices: cableDefault, nativeLoopback: fakeCapture(), sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    const source = await openSystemAudio({ ...s.settings, meetingOutput: () => 'send-to-meeting' }, live(), s.deps);
    const degraded = vi.fn();
    const ended = vi.fn();
    source.onDegraded(degraded);
    source.onEnded(ended);
    s.app.onLost?.();
    await settle();
    await source.stop();
    expect(ended).toHaveBeenCalledWith(expect.stringContaining('virtual microphone cable'));
    expect(degraded).not.toHaveBeenCalled();
    expect(s.loopback.begun).toHaveLength(0);
  });

  it('tries Windows shared-mode capture for the same system source after repeated NotReadableError', async () => {
    const failure = new DOMException('Could not start audio source', 'NotReadableError');
    const nativeLoopback = fakeCapture();
    const s = setup({ loopback: fakeCapture({ begins: false, failure }), nativeLoopback });
    const captureStarted = vi.fn();
    const source = await openSystemAudio({ ...s.settings, captureStarted }, live(), s.deps);
    const heard = vi.fn();
    source.onPcm(heard);
    nativeLoopback.push();
    expect(s.loopback.begun).toHaveLength(2);
    expect(nativeLoopback.begun).toEqual([{ deviceId: 'desktop-audio-loopback' }]);
    expect(s.widened).not.toHaveBeenCalledWith(true);
    expect(captureStarted).toHaveBeenCalledWith('native-loopback');
    expect(heard).toHaveBeenCalledOnce();
    await source.stop();
    expect(nativeLoopback.ended).toBe(1);
  });

  it('keeps the chosen application scope when a capture cannot open', async () => {
    const failure = new DOMException('Could not start audio source', 'NotReadableError');
    const nativeLoopback = fakeCapture();
    const s = setup({ sourceId: 'app:pid:42', answer: { success: true, capture: 'app' }, app: fakeCapture({ begins: false, failure }), nativeLoopback });
    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow('NotReadableError');
    expect(nativeLoopback.begun).toHaveLength(0);
    expect(s.widened).not.toHaveBeenCalledWith(true);
  });

  it('records an application through the helper when the main process asks for it', async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const heard = vi.fn();
    source.onPcm(heard);
    s.app.push();
    expect(s.invoked[0]).toEqual(['connect-system-audio-source', 'app:42']);
    expect(s.app.begun).toEqual([{ deviceId: 'app:42' }]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("records a PipeWire tap through its monitor device, found by label", async () => {
    const s = setup({
      sourceId: 'app:7',
      answer: { success: true, monitorLabel: 'Sokuji Capture' },
      devices: [{ kind: 'audioinput', label: 'Monitor of Sokuji Capture', deviceId: 'mon-1' }],
    });
    await openSystemAudio(s.settings, live(), s.deps);
    expect(s.device.begun).toEqual([{ deviceId: 'mon-1' }]);
  });

  it("widens to whole-system capture, visibly, when the tap's monitor never appears", async () => {
    const s = setup({ sourceId: 'app:7', answer: { success: true, monitorLabel: 'Sokuji Capture' } });
    const degraded = vi.fn();
    const source = await openSystemAudio(s.settings, live(), s.deps);
    // Raised while it opened, held by the core for the first listener (the leg's).
    source.onDegraded(degraded);
    expect(s.wait).toHaveBeenCalledTimes(10);
    expect(s.loopback.begun).toEqual([undefined]);
    expect(degraded).toHaveBeenCalledWith(expect.objectContaining({ code: APP_MONITOR_MISSING }));
  });

  it('records the whole system through loopback otherwise', async () => {
    const s = setup();
    await openSystemAudio(s.settings, live(), s.deps);
    expect(s.loopback.begun).toEqual([undefined]);
  });

  it('fails a whole-system capture in words when Screen Recording permission is denied (ruling 6)', async () => {
    const s = setup({ screenRecording: 'denied' });
    const error = await openSystemAudio(s.settings, live(), s.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceOpenError);
    expect((error as InstanceType<typeof SourceOpenError>).code).toBe(LOOPBACK_DENIED);
    expect(s.loopback.begun).toEqual([]);
    expect(s.invoked.map(([c]) => c)).toEqual(['connect-system-audio-source', 'disconnect-system-audio-source']);
  });

  it('opens an application capture without asking about Screen Recording permission at all', async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' }, screenRecording: 'denied' });
    await openSystemAudio(s.settings, live(), s.deps);
    expect(s.screenRecording).not.toHaveBeenCalled();
  });

  it('opens whole-system capture when the permission is merely undetermined: the OS asks at getDisplayMedia, as today', async () => {
    const s = setup({ screenRecording: 'not-determined' });
    await openSystemAudio(s.settings, live(), s.deps);
    expect(s.loopback.begun).toEqual([undefined]);
  });

  it('rejects when the source will not connect', async () => {
    const s = setup({ answer: { success: false, error: 'helper missing' } });
    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow('helper missing');
    expect(s.invoked.map(([c]) => c)).toEqual(['connect-system-audio-source']);
  });

  it('rejects and disconnects when the recorder will not begin', async () => {
    const s = setup({ loopback: fakeCapture({ begins: false }) });
    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow();
    expect(s.invoked.map(([c]) => c)).toEqual(['connect-system-audio-source', 'disconnect-system-audio-source']);
  });

  it("names the recorder's own reason when it will not begin", async () => {
    const failure = new DOMException('Could not start audio source', 'NotReadableError');
    const s = setup({ loopback: fakeCapture({ begins: false, failure }) });
    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow(
      'The system audio capture did not start (NotReadableError: Could not start audio source).',
    );
  });

  it('retries one transient monitor open on the same selected application tap', async () => {
    const failure = new DOMException('Could not start audio source', 'NotReadableError');
    const device = fakeCapture({ failure });
    let attempts = 0;
    device.begin = async (options) => {
      device.begun.push(options);
      return ++attempts === 2;
    };
    const s = setup({
      sourceId: 'app:pid:7',
      answer: { success: true, monitorLabel: 'Sokuji Capture' },
      devices: [{ kind: 'audioinput', label: 'Monitor of Sokuji Capture', deviceId: 'monitor-7' }],
      device,
    });

    await openSystemAudio(s.settings, live(), s.deps);

    expect(device.begun).toEqual([{ deviceId: 'monitor-7' }, { deviceId: 'monitor-7' }]);
    expect(s.loopback.begun).toEqual([]);
    expect(s.widened).not.toHaveBeenCalledWith(true);
    expect(s.wait).toHaveBeenCalledWith(250);
  });

  it('retries a transient whole-system loopback open once without changing its capture scope', async () => {
    const failure = new DOMException('Could not start audio source', 'NotReadableError');
    const loopback = fakeCapture({ failure });
    let attempts = 0;
    loopback.begin = async (options) => {
      loopback.begun.push(options);
      return ++attempts === 2;
    };
    const s = setup({ loopback });

    await openSystemAudio(s.settings, live(), s.deps);

    expect(loopback.begun).toEqual([undefined, undefined]);
    expect(s.device.begun).toEqual([]);
    expect(s.widened).not.toHaveBeenCalledWith(true);
    expect(s.wait).toHaveBeenCalledWith(250);
  });

  it('does not retry non-transient permission failures', async () => {
    const failure = new DOMException('Permission denied', 'NotAllowedError');
    const loopback = fakeCapture({ begins: false, failure });
    const s = setup({ loopback });

    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow('Permission denied');

    expect(loopback.begun).toEqual([undefined]);
    expect(s.wait).not.toHaveBeenCalled();
  });

  it('stops after one retry when a NotReadableError persists', async () => {
    const failure = new DOMException('Could not start audio source', 'NotReadableError');
    const loopback = fakeCapture({ begins: false, failure });
    const s = setup({ loopback });

    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow('NotReadableError');

    expect(loopback.begun).toEqual([undefined, undefined]);
    expect(s.widened).not.toHaveBeenCalledWith(true);
    expect(s.wait).toHaveBeenCalledTimes(1);
  });

  it('says only that it did not start when the recorder gives no reason', async () => {
    const s = setup({ loopback: fakeCapture({ begins: false }) });
    await expect(openSystemAudio(s.settings, live(), s.deps)).rejects.toThrow(/^The system audio capture did not start\.$/);
  });

  it('stops what it opened when the run was cancelled while it opened', async () => {
    let finish: (started: boolean) => void = () => {};
    const started = new Promise<boolean>((resolve) => { finish = resolve; });
    const s = setup({ loopback: fakeCapture({ started }) });
    const cancel = new AbortController();
    const opening = openSystemAudio(s.settings, cancel.signal, s.deps);
    await vi.waitFor(() => expect(s.loopback.begun).toHaveLength(1));
    cancel.abort(new Error('the run ended'));
    finish(true);
    await expect(opening).rejects.toThrow('the run ended');
    expect(s.loopback.ended).toBe(1);
    expect(s.invoked.map(([c]) => c)).toContain('disconnect-system-audio-source');
  });
});

describe('openSystemAudio — running', () => {
  it('falls back to whole-system capture, visibly, when the helper dies', async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const degraded = vi.fn();
    source.onDegraded(degraded);
    s.app.onLost?.();
    await settle();
    expect(degraded).toHaveBeenCalledWith(expect.objectContaining({ code: APP_CAPTURE_LOST }));
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(s.app.ended).toBe(1);
    expect(s.loopback.begun).toEqual([undefined]);
  });

  it('falls back to whole-system capture, visibly, when the application a PipeWire tap follows quits (#617)', async () => {
    const s = setup({
      sourceId: 'app:pid:7',
      answer: { success: true, monitorLabel: 'Sokuji Capture' },
      devices: [{ kind: 'audioinput', label: 'Sokuji Capture', deviceId: 'mon-1' }],
    });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const degraded = vi.fn();
    source.onDegraded(degraded);
    s.appQuit();
    await settle();
    expect(degraded).toHaveBeenCalledWith(expect.objectContaining({ code: APP_CAPTURE_LOST }));
    expect(s.device.ended).toBe(1);
    expect(s.loopback.begun).toEqual([undefined]);
    expect(s.widened).toHaveBeenLastCalledWith(true);
    // Heard once: the whole-system capture it fell back to follows no application.
    expect(s.appLostListeners.size).toBe(0);
  });

  it('ends a tap recorder still starting when the application quits, instead of letting it record beside the fallback', async () => {
    let start!: (begun: boolean) => void;
    const device = fakeCapture({ started: new Promise<boolean>((resolve) => { start = resolve; }) });
    const s = setup({
      sourceId: 'app:pid:7',
      answer: { success: true, monitorLabel: 'Sokuji Capture' },
      devices: [{ kind: 'audioinput', label: 'Sokuji Capture', deviceId: 'mon-1' }],
      device,
    });
    const opening = openSystemAudio(s.settings, live(), s.deps);
    await settle(); // the tap's recorder is starting
    s.appQuit();
    await settle(); // the fallback is recording the whole system
    const endedBefore = device.ended;
    start(true);
    const source = await opening;
    const heard = vi.fn();
    source.onPcm(heard);
    device.push();
    expect(heard).not.toHaveBeenCalled();
    expect(device.ended).toBe(endedBefore + 1);
    s.loopback.push();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('stops listening for the tapped application when the source stops', async () => {
    const s = setup({
      sourceId: 'app:pid:7',
      answer: { success: true, monitorLabel: 'Sokuji Capture' },
      devices: [{ kind: 'audioinput', label: 'Sokuji Capture', deviceId: 'mon-1' }],
    });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    expect(s.appLostListeners.size).toBe(1);
    await source.stop();
    expect(s.appLostListeners.size).toBe(0);
  });

  it('ends when the fallback cannot start', async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' }, loopback: fakeCapture({ begins: false }) });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const ended = vi.fn();
    source.onEnded(ended);
    s.app.onLost?.();
    await settle();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("passes the helper's warning on as a coded degradation, and its first audible audio to the settings", async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const degraded = vi.fn();
    source.onDegraded(degraded);
    s.app.onWarning?.(SILENT_NO_PERMISSION);
    s.app.onAudioSeen?.();
    expect(degraded).toHaveBeenCalledWith(expect.objectContaining({ code: SILENT_NO_PERMISSION }));
    expect(s.audioSeen).toHaveBeenCalledTimes(1);
  });

  it('ends when the captured track ends', async () => {
    const track = new EventTarget() as MediaStreamTrack;
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    const s = setup({ loopback: fakeCapture({ stream }) });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const ended = vi.fn();
    source.onEnded(ended);
    track.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledWith(TRACK_ENDED);
  });

  it('delivers nothing while muted', async () => {
    const s = setup();
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const heard = vi.fn();
    source.onPcm(heard);
    s.set({ muted: true });
    s.loopback.push();
    expect(heard).not.toHaveBeenCalled();
  });

  it('moves to a newly chosen source in place: stops, disconnects, connects and records again', async () => {
    const s = setup({ answer: [{ success: true, capture: 'system' }, { success: true, capture: 'app' }] });
    await openSystemAudio(s.settings, live(), s.deps);
    s.set({ sourceId: 'app:9' });
    await settle();
    expect(s.loopback.ended).toBe(1);
    expect(s.invoked.map(([c, d]) => `${c}:${d ?? ''}`)).toEqual([
      'connect-system-audio-source:desktop-audio-loopback',
      'disconnect-system-audio-source:',
      'connect-system-audio-source:app:9',
    ]);
    expect(s.app.begun).toEqual([{ deviceId: 'app:9' }]);
  });

  it('ignores a helper death from a recorder a queued switch has already replaced, and raises no APP_CAPTURE_LOST', async () => {
    // A fresh recorder object per 'app' connection (as the real deps do), so identity can be checked.
    const recorders: Array<ReturnType<typeof fakeCapture>> = [];
    const loopback = fakeCapture();
    const deps: SystemAudioDeps = {
      invoke: async (channel) => (channel === 'connect-system-audio-source' ? { success: true, capture: 'app' } : { success: true }),
      enumerateDevices: async () => [],
      wait: async () => {},
      app: () => { const c = fakeCapture(); recorders.push(c); return c; },
      device: () => fakeCapture(),
      loopback: () => loopback,
      appLost: () => () => {},
      screenRecording: async () => 'granted',
    };
    let current = { sourceId: 'app:1', muted: false };
    const listeners = new Set<() => void>();
    const settings: SystemAudioSettings = {
      sourceId: () => current.sourceId,
      muted: () => current.muted,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      audioSeen: () => {},
      widened: () => {},
    };
    const set = (patch: Partial<typeof current>) => { current = { ...current, ...patch }; for (const listener of listeners) listener(); };

    const source = await openSystemAudio(settings, live(), deps);
    const degraded = vi.fn();
    source.onDegraded(degraded);

    // Switch once, fully: the recorder it opens is the one that is about to "die".
    set({ sourceId: 'app:2' });
    await settle();
    const died = recorders[1];
    expect(died).toBeDefined();

    // Queue a second switch, and fire the first recorder's death in the same tick,
    // before that switch has had any chance to run — it is still waiting on `chain`.
    set({ sourceId: 'app:3' });
    died.onLost?.();
    await settle();

    expect(degraded).not.toHaveBeenCalledWith(expect.objectContaining({ code: APP_CAPTURE_LOST }));
    // A live fallback would have widened to whole-system capture; it must not have run.
    expect(loopback.begun).toEqual([]);
    expect(recorders).toHaveLength(3);
    expect(recorders[2].begun).toHaveLength(1);
  });

  it('stops once: ends the recorder without reading its own teardown as a loss, then disconnects', async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    const degraded = vi.fn();
    source.onDegraded(degraded);
    await source.stop();
    await source.stop();
    expect(s.app.ended).toBe(1);
    expect(degraded).not.toHaveBeenCalled();
    expect(s.loopback.begun).toEqual([]);
    expect(s.invoked.filter(([c]) => c === 'disconnect-system-audio-source')).toHaveLength(1);
  });
});

describe('electronSystemAudio', () => {
  it("screenRecording() reports one warning and answers 'unknown' when the check fails, as its neighbours do", async () => {
    useLogStore.getState().setEnabled(true);
    useLogStore.getState().clearLogs();
    (window as unknown as { electron: { invoke: (channel: string, data?: unknown) => Promise<unknown> } }).electron = {
      invoke: async () => { throw new Error('boom'); },
    };
    try {
      await expect(electronSystemAudio().screenRecording()).resolves.toBe('unknown');
      await settleReports();
      expect(useLogStore.getState().logs.filter((l) => l.type === 'warning')).toHaveLength(1);
    } finally {
      delete (window as { electron?: unknown }).electron;
      useLogStore.getState().setEnabled(false);
    }
  });
});

describe('openSystemAudio — the widening flag', () => {
  it("flags the capture as widened when the tap's monitor never appears, and clears it when the source stops", async () => {
    const s = setup({ sourceId: 'app:7', answer: { success: true, monitorLabel: 'Sokuji Capture' } });
    const source = await openSystemAudio(s.settings, live(), s.deps);
    expect(s.widened).toHaveBeenLastCalledWith(true);
    await source.stop();
    expect(s.widened).toHaveBeenLastCalledWith(false);
  });

  it('flags it when the helper dies and the capture falls back to the whole system', async () => {
    const s = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    await openSystemAudio(s.settings, live(), s.deps);
    expect(s.widened).not.toHaveBeenCalledWith(true);
    s.app.onLost?.();
    await settle();
    expect(s.widened).toHaveBeenLastCalledWith(true);
  });

  it('never flags a whole-system source chosen as such, nor an application capture that works', async () => {
    const whole = setup({ sourceId: 'desktop-audio-loopback' });
    await openSystemAudio(whole.settings, live(), whole.deps);
    expect(whole.widened).not.toHaveBeenCalledWith(true);
    const app = setup({ sourceId: 'app:42', answer: { success: true, capture: 'app' } });
    await openSystemAudio(app.settings, live(), app.deps);
    expect(app.widened).not.toHaveBeenCalledWith(true);
  });

  it('clears it when the open fails after the flag was raised', async () => {
    const s = setup({ sourceId: 'app:7', answer: { success: true, monitorLabel: 'Sokuji Capture' }, screenRecording: 'denied' });
    const error = await openSystemAudio(s.settings, live(), s.deps).catch((e: unknown) => e);
    expect((error as InstanceType<typeof SourceOpenError>).code).toBe(LOOPBACK_DENIED);
    expect(s.widened).toHaveBeenCalledWith(true);
    expect(s.widened).toHaveBeenLastCalledWith(false);
  });

  it('clears it when a switch lands on a working application capture', async () => {
    const s = setup({ sourceId: 'app:7', answer: [{ success: true, monitorLabel: 'Sokuji Capture' }, { success: true, capture: 'app' }] });
    await openSystemAudio(s.settings, live(), s.deps);
    expect(s.widened).toHaveBeenLastCalledWith(true);
    s.set({ sourceId: 'app:9' });
    await settle();
    expect(s.widened).toHaveBeenLastCalledWith(false);
  });
});
