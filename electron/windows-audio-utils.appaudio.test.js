// Per-application capture behaviour of the Windows platform module (issue #335).
//
// These inject a fake `host` rather than vi.mock'ing audio-host.js:
// windows-audio-utils.js is CommonJS and reaches it through require(), which
// vi.mock does not reliably intercept.
import { describe, it, expect, vi } from 'vitest';
import {
  listSystemAudioSources,
  resolveAutoSystemAudioSource,
  connectSystemAudioSource,
  disconnectSystemAudioSource,
} from './windows-audio-utils.js';

const host = () => ({
  listAppSources: vi.fn(async () => [{ deviceId: 'app:pid:42', label: 'Zoom' }]),
  startCapture: vi.fn(() => true),
  stopCapture: vi.fn(),
});

const SYSTEM = { deviceId: 'desktop-audio-loopback', label: 'System Audio (All Applications)' };

describe('listSystemAudioSources (Windows)', () => {
  it('keeps whole-system capture first, then the applications', async () => {
    const sources = await listSystemAudioSources({ host: host() });
    expect(sources[0]).toEqual(SYSTEM);
    expect(sources.map((s) => s.deviceId)).toEqual(['desktop-audio-loopback', 'auto-meeting-audio', 'app:pid:42']);
  });

  it('still offers whole-system capture when no helper is available', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue([]);
    expect((await listSystemAudioSources({ host: h })).map((s) => s.deviceId)).toEqual(['desktop-audio-loopback', 'auto-meeting-audio']);
  });
});

describe('connectSystemAudioSource (Windows)', () => {
  it('marks app: ids as application capture and leaves any helper alone', async () => {
    const h = host();
    expect(await connectSystemAudioSource('app:pid:42', { host: h }))
      .toEqual({ success: true, capture: 'app' });
    // The helper is started later by start-app-audio-capture, not here.
    expect(h.startCapture).not.toHaveBeenCalled();
  });

  it('marks the loopback id as system capture and releases a running helper', async () => {
    const h = host();
    expect(await connectSystemAudioSource('desktop-audio-loopback', { host: h }))
      .toEqual({ success: true, capture: 'system' });
    // A helper left running would keep capturing the previously chosen app.
    expect(h.stopCapture).toHaveBeenCalled();
  });
});

describe('resolveAutoSystemAudioSource (Windows)', () => {
  it('chooses an audible meeting process from bounded app-scoped PCM probes', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue([
      { deviceId: 'app:pid:42', label: 'Zoom', appKey: 'Zoom.exe', active: true },
      { deviceId: 'app:pid:51', label: 'Spotify', appKey: 'Spotify.exe', active: true },
    ]);
    h.probeAppSource = vi.fn(async (id) => id === 'app:pid:42' ? 0.12 : 0);
    const result = await resolveAutoSystemAudioSource({ host: h, wait: async () => {} });
    expect(result).toMatchObject({ success: true, source: { deviceId: 'app:pid:42', label: 'Zoom' } });
    expect(h.listAppSources).toHaveBeenCalledWith({ activeOnly: true });
    expect(h.probeAppSource).toHaveBeenCalledTimes(4);
    expect(h.probeAppSource.mock.calls.filter(([id]) => id === 'app:pid:42')).toHaveLength(2);
    expect(h.probeAppSource).toHaveBeenCalledWith('app:pid:42', { durationMs: 260 });
  });

  it('recognizes Teams rows whose identity comes from the native Teams process tree', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue([
      { deviceId: 'app:pid:420', label: 'Microsoft Teams (420)', appKey: 'ms-teams.exe', active: true },
    ]);
    h.probeAppSource = vi.fn(async () => 0.08);
    const result = await resolveAutoSystemAudioSource({ host: h, wait: async () => {} });
    expect(result).toMatchObject({ success: true, source: { deviceId: 'app:pid:420', appKey: 'ms-teams.exe' } });
    expect(h.probeAppSource).toHaveBeenCalledTimes(2);
  });

  it('chooses quiet, intermittent Teams speech before a louder browser', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue([
      { deviceId: 'app:pid:420', label: 'Microsoft Teams', appKey: 'ms-teams.exe' },
      { deviceId: 'app:pid:421', label: 'Google Chrome', appKey: 'chrome.exe' },
    ]);
    const teamsPeaks = [0, 0.014];
    h.probeAppSource = vi.fn(async (id) => id === 'app:pid:420' ? teamsPeaks.shift() : 0.2);
    expect(await resolveAutoSystemAudioSource({ host: h, wait: async () => {} }))
      .toMatchObject({ success: true, source: { deviceId: 'app:pid:420' } });
  });

  it('can resolve an audible active application without a meeting app name', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue([
      { deviceId: 'app:pid:77', label: 'Acme Client (77)', appKey: 'AcmeClient.exe', active: true },
    ]);
    h.probeAppSource = vi.fn(async () => 0.09);
    expect(await resolveAutoSystemAudioSource({ host: h, wait: async () => {} }))
      .toMatchObject({ success: true, source: { deviceId: 'app:pid:77', appKey: 'AcmeClient.exe' } });
  });

  it('continues probing later batches when active applications exceed eight', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({
      deviceId: `app:pid:${100 + i}`,
      label: `Unknown App ${i + 1}`,
      appKey: `unknown-${i + 1}.exe`,
      active: true,
    })));
    h.probeAppSource = vi.fn(async (id) => id === 'app:pid:108' ? 0.09 : 0);
    expect(await resolveAutoSystemAudioSource({ host: h, wait: async () => {} }))
      .toMatchObject({ success: true, source: { deviceId: 'app:pid:108' } });
    expect(h.probeAppSource).toHaveBeenCalledTimes(18);
    expect(h.probeAppSource).toHaveBeenLastCalledWith('app:pid:108', { durationMs: 260 });
  });

  it('does not return whole-system capture when no active application is audible', async () => {
    const h = host();
    h.listAppSources.mockResolvedValue([{ deviceId: 'app:pid:42', label: 'Unknown App', active: true }]);
    h.probeAppSource = vi.fn(async () => 0);
    expect(await resolveAutoSystemAudioSource({ host: h, wait: async () => {} }))
      .toMatchObject({ success: false });
  });
});

describe('disconnectSystemAudioSource (Windows)', () => {
  it('always stops the helper', async () => {
    const h = host();
    expect(await disconnectSystemAudioSource({ host: h })).toEqual({ success: true });
    expect(h.stopCapture).toHaveBeenCalled();
  });
});
