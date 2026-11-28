import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { AudioDevice } from '../../stores/audioStore';
import useAudioStore from '../../stores/audioStore';
import { useLocalMediaOutput } from './useLocalMediaOutput';

vi.mock('../../utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/environment')>()),
  isElectron: () => true,
}));

const cable: AudioDevice = { deviceId: 'cable-output', label: 'CABLE Input', isVirtual: true };
const speakers: AudioDevice = { deviceId: 'speaker-1', label: 'Speakers', isVirtual: false };
const headphones: AudioDevice = { deviceId: 'headphones-1', label: 'Headphones', isVirtual: false };
const sinkIds = new WeakMap<HTMLMediaElement, string>();
const muted = new WeakMap<HTMLMediaElement, boolean>();
const paused = new WeakMap<HTMLMediaElement, boolean>();
let originalStore: ReturnType<typeof useAudioStore.getState>;

function makePlayer() {
  const element = document.createElement('audio');
  Object.defineProperty(element, 'sinkId', {
    configurable: true,
    get: () => sinkIds.get(element) ?? '',
    set: (value: string) => sinkIds.set(element, value),
  });
  Object.defineProperty(element, 'muted', {
    configurable: true,
    get: () => muted.get(element) ?? false,
    set: (value: boolean) => muted.set(element, value),
  });
  Object.defineProperty(element, 'paused', {
    configurable: true,
    get: () => paused.get(element) ?? true,
  });
  element.pause = vi.fn(() => { paused.set(element, true); });
  element.play = vi.fn(() => { paused.set(element, false); return Promise.resolve(); });
  element.setSinkId = vi.fn(async (id: string) => { sinkIds.set(element, id); });
  return element;
}

function setOutputs(devices: AudioDevice[], selected: AudioDevice | null, outputLabelsKnown = true) {
  useAudioStore.setState({ audioMonitorDevices: devices, selectedMonitorDevice: selected, devicesLoaded: true, outputLabelsKnown });
}

beforeEach(() => {
  originalStore = useAudioStore.getState();
  setOutputs([cable, speakers], cable);
});

afterEach(() => {
  cleanup();
  useAudioStore.setState(originalStore, true);
  vi.restoreAllMocks();
});

describe('useLocalMediaOutput on the Windows desktop', () => {
  it('selects a physical sink when the saved/default output is the virtual cable', async () => {
    const player = makePlayer();
    const elements = () => [player];
    const { result } = renderHook(() => useLocalMediaOutput(elements, 'track-a'));

    await waitFor(() => expect(player.setSinkId).toHaveBeenCalledWith(speakers.deviceId));
    await waitFor(() => expect(player.muted).toBe(false));
    expect(result.current).toBe(true);
    expect(player.sinkId).toBe(speakers.deviceId);
  });

  it('mutes when no physical output is listed, then rebinds to the newly plugged-in device', async () => {
    const player = makePlayer();
    const elements = () => [player];
    const { result } = renderHook(() => useLocalMediaOutput(elements, 'track-a'));
    await waitFor(() => expect(player.muted).toBe(false));
    await act(async () => { await player.play(); });

    act(() => setOutputs([cable], cable));
    expect(player.muted).toBe(true);
    expect(player.pause).toHaveBeenCalled();
    expect(result.current).toBe(false);
    expect(player.setSinkId).toHaveBeenCalledTimes(1);

    act(() => setOutputs([cable, headphones], cable));
    await waitFor(() => expect(player.setSinkId).toHaveBeenLastCalledWith(headphones.deviceId));
    await waitFor(() => expect(player.muted).toBe(false));
    expect(player.sinkId).toBe(headphones.deviceId);
  });

  it('stays muted while output labels are placeholders, then selects the confirmed physical output', async () => {
    const player = makePlayer();
    const elements = () => [player];
    setOutputs([
      { deviceId: cable.deviceId, label: 'Speaker 12abc...', isVirtual: false },
      { deviceId: speakers.deviceId, label: 'Speaker 34def...', isVirtual: false },
    ], null, false);
    const { result } = renderHook(() => useLocalMediaOutput(elements, 'track-a'));

    expect(player.muted).toBe(true);
    expect(player.setSinkId).not.toHaveBeenCalled();
    expect(result.current).toBe(false);

    act(() => setOutputs([cable, speakers], cable, true));
    await waitFor(() => expect(player.setSinkId).toHaveBeenCalledWith(speakers.deviceId));
    await waitFor(() => expect(player.muted).toBe(false));
    expect(player.sinkId).toBe(speakers.deviceId);
  });

  it('keeps the element muted until a newer sink switch finishes after an older switch', async () => {
    const player = makePlayer();
    const requests: Array<{ id: string; finish(): void }> = [];
    player.setSinkId = vi.fn((id: string) => new Promise<void>((resolve) => {
      requests.push({ id, finish: () => { sinkIds.set(player, id); resolve(); } });
    }));
    const elements = () => [player];
    renderHook(() => useLocalMediaOutput(elements, 'track-a'));
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId]));

    act(() => setOutputs([cable, speakers, headphones], headphones));
    expect(player.muted).toBe(true);
    act(() => requests[0].finish());
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId, headphones.deviceId]));
    expect(player.muted).toBe(true);
    expect(player.sinkId).toBe(speakers.deviceId);

    act(() => requests[1].finish());
    await waitFor(() => expect(player.muted).toBe(false));
    expect(player.sinkId).toBe(headphones.deviceId);
  });

  it('does not let an earlier A request unmute during a later A→B→A sequence', async () => {
    const player = makePlayer();
    const requests: Array<{ id: string; finish(): void }> = [];
    player.setSinkId = vi.fn((id: string) => new Promise<void>((resolve) => {
      requests.push({ id, finish: () => { sinkIds.set(player, id); resolve(); } });
    }));
    const elements = () => [player];
    renderHook(() => useLocalMediaOutput(elements, 'track-a'));
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId]));

    act(() => setOutputs([cable, speakers, headphones], headphones));
    act(() => setOutputs([cable, speakers, headphones], speakers));
    expect(player.muted).toBe(true);
    act(() => requests[0].finish());
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId, headphones.deviceId]));
    expect(player.muted).toBe(true);

    act(() => requests[1].finish());
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId, headphones.deviceId, speakers.deviceId]));
    expect(player.muted).toBe(true);
    act(() => requests[2].finish());
    await waitFor(() => expect(player.muted).toBe(false));
    expect(player.sinkId).toBe(speakers.deviceId);
  });

  it('serializes sink switches on a reused element when its media source changes', async () => {
    const player = makePlayer();
    const requests: Array<{ id: string; finish(): void }> = [];
    player.setSinkId = vi.fn((id: string) => new Promise<void>((resolve) => {
      requests.push({ id, finish: () => { sinkIds.set(player, id); resolve(); } });
    }));
    const elements = () => [player];
    const hook = renderHook(({ media }) => useLocalMediaOutput(elements, media), { initialProps: { media: 'recording-a' } });
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId]));

    act(() => setOutputs([cable, speakers, headphones], headphones));
    hook.rerender({ media: 'recording-b' });
    expect(player.muted).toBe(true);
    expect(requests.map((request) => request.id)).toEqual([speakers.deviceId]);

    act(() => requests[0].finish());
    await waitFor(() => expect(requests.map((request) => request.id)).toEqual([speakers.deviceId, headphones.deviceId]));
    expect(player.muted).toBe(true);
    expect(player.sinkId).toBe(speakers.deviceId);

    act(() => requests[1].finish());
    await waitFor(() => expect(player.muted).toBe(false));
    expect(player.sinkId).toBe(headphones.deviceId);
  });

  it('does not unmute a released element when its sink request finishes after a new player mounts', async () => {
    const oldPlayer = makePlayer();
    let finishOld!: () => void;
    oldPlayer.setSinkId = vi.fn(() => new Promise<void>((resolve) => {
      finishOld = () => { sinkIds.set(oldPlayer, speakers.deviceId); resolve(); };
    }));
    const players = [oldPlayer];
    const elements = () => players;
    const old = renderHook(() => useLocalMediaOutput(elements, 'old-track'));
    await waitFor(() => expect(oldPlayer.setSinkId).toHaveBeenCalled());
    old.unmount();
    expect(oldPlayer.muted).toBe(true);

    const newPlayer = makePlayer();
    players.splice(0, 1, newPlayer);
    renderHook(() => useLocalMediaOutput(elements, 'new-track'));
    await waitFor(() => expect(newPlayer.muted).toBe(false));
    act(() => finishOld());
    await act(async () => { await Promise.resolve(); });

    expect(oldPlayer.muted).toBe(true);
    expect(newPlayer.muted).toBe(false);
    expect(newPlayer.sinkId).toBe(speakers.deviceId);
  });

  it('fails closed when setSinkId rejects and retries after the output changes', async () => {
    const player = makePlayer();
    player.setSinkId = vi.fn(async () => { throw new Error('device unavailable'); });
    const elements = () => [player];
    const { result } = renderHook(() => useLocalMediaOutput(elements, 'track-a'));
    await waitFor(() => expect(player.setSinkId).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(player.muted).toBe(true);
    expect(result.current).toBe(false);

    player.setSinkId = vi.fn(async (id: string) => { sinkIds.set(player, id); });
    act(() => setOutputs([cable, speakers, headphones], headphones));
    await waitFor(() => expect(player.muted).toBe(false));
    expect(player.sinkId).toBe(headphones.deviceId);
  });
});
