import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import '../locales';
import type { AudioDevice } from '../stores/audioStore';
import useAudioStore from '../stores/audioStore';
import RecordPlayer, { type SeekFn } from './History/RecordPlayer';
import SonioxCloneReviewStep from './Settings/sections/SonioxCloneReviewStep';
import type { HistoryTrack } from '../lib/history/types';

vi.mock('../utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/environment')>()),
  isElectron: () => true,
}));

const cable: AudioDevice = { deviceId: 'cable-output', label: 'CABLE Input', isVirtual: true };
const speakers: AudioDevice = { deviceId: 'speaker-1', label: 'Speakers', isVirtual: false };
const sinkIds = new WeakMap<HTMLMediaElement, string>();
const mutedValues = new WeakMap<HTMLMediaElement, boolean>();
const pausedValues = new WeakMap<HTMLMediaElement, boolean>();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let storeBefore: ReturnType<typeof useAudioStore.getState>;

function restoreProperty(name: string) {
  const descriptor = descriptors.get(name);
  if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
  else delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[name];
}

function installMediaProperties() {
  for (const name of ['sinkId', 'muted', 'paused', 'setSinkId', 'play', 'pause', 'load']) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name));
  }
  Object.defineProperties(HTMLMediaElement.prototype, {
    sinkId: {
      configurable: true,
      get() { return sinkIds.get(this) ?? ''; },
      set(value: string) { sinkIds.set(this, value); },
    },
    muted: {
      configurable: true,
      get() { return mutedValues.get(this) ?? false; },
      set(value: boolean) { mutedValues.set(this, value); },
    },
    paused: { configurable: true, get() { return pausedValues.get(this) ?? true; } },
    setSinkId: {
      configurable: true,
      value: vi.fn(function (this: HTMLMediaElement, id: string) {
        sinkIds.set(this, id);
        return Promise.resolve();
      }),
    },
    play: {
      configurable: true,
      value: vi.fn(function (this: HTMLMediaElement) {
        pausedValues.set(this, false);
        return Promise.resolve();
      }),
    },
    pause: {
      configurable: true,
      value: vi.fn(function (this: HTMLMediaElement) { pausedValues.set(this, true); }),
    },
    load: { configurable: true, value: vi.fn() },
  });
}

function selectCableDefault() {
  useAudioStore.setState({
    audioMonitorDevices: [cable, speakers],
    selectedMonitorDevice: cable,
    devicesLoaded: true,
    outputLabelsKnown: true,
  });
}

beforeEach(() => {
  storeBefore = useAudioStore.getState();
  selectCableDefault();
  installMediaProperties();
});

afterEach(() => {
  cleanup();
  useAudioStore.setState(storeBefore, true);
  for (const name of descriptors.keys()) restoreProperty(name);
  descriptors.clear();
  vi.restoreAllMocks();
});

const track = (source: string): HistoryTrack => ({
  source, file: `${source}.opus`, format: 'ogg-opus', durationMs: 10_000, bytes: 100, offsetMs: 0, goneAt: null,
});

describe('standalone audio players bind locally when a virtual meeting output is present', () => {
  it('keeps history playback on a physical output in StrictMode', async () => {
    const seekRef = createRef<SeekFn>();
    const { unmount } = render(
      <StrictMode>
        <RecordPlayer recordId="run-0001-aaaa" tracks={[track('speaker')]} onPosition={() => {}} seekRef={seekRef} />
      </StrictMode>,
    );
    const player = document.querySelector('audio')!;
    await waitFor(() => expect(player.sinkId).toBe(speakers.deviceId));
    await waitFor(() => expect(player.muted).toBe(false));
    expect(HTMLMediaElement.prototype.setSinkId).toHaveBeenCalledWith(speakers.deviceId);

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(player.paused).toBe(false);
    expect(player.sinkId).toBe(speakers.deviceId);
    unmount();
  });

  it('keeps the Soniox review clip muted until its physical sink is ready', async () => {
    const oldCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const oldRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:review-clip') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const { unmount } = render(<SonioxCloneReviewStep
      audioBlob={new Blob(['clip'], { type: 'audio/wav' })}
      error={null}
      busy={false}
      onConfirm={() => {}}
    />);

    try {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
      const player = document.querySelector('audio')!;
      await waitFor(() => expect(player.sinkId).toBe(speakers.deviceId));
      await waitFor(() => expect(player.muted).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
      expect(player.paused).toBe(false);
      expect(player.sinkId).toBe(speakers.deviceId);
      expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
      unmount();
    } finally {
      if (oldCreate) Object.defineProperty(URL, 'createObjectURL', oldCreate);
      else delete (URL as unknown as Record<string, unknown>).createObjectURL;
      if (oldRevoke) Object.defineProperty(URL, 'revokeObjectURL', oldRevoke);
      else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });
});
