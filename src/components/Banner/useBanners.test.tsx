// src/components/Banner/useBanners.test.tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Banners, MeetingHeadphonesNotice } from './useBanners';
import useAudioStore from '../../stores/audioStore';
import useAudioSystemStore from '../../stores/audioSystemStore';

// t(key) renders the key itself, so these assertions pin which keys the
// banners use, not their English copy.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);

const unavailable = (reason: string, extra: Record<string, unknown> = {}) =>
  useAudioSystemStore.setState({
    status: 'unavailable', platform: reason === 'mac-driver-not-loaded' ? 'darwin' : 'linux',
    reason: reason as never, message: null, dismissed: false, retrying: false, repairing: false, repairFailed: false, ...extra,
  });
beforeEach(() => {
  useAudioSystemStore.setState({ status: 'ok', dismissed: false, retry: vi.fn(async () => {}), repair: vi.fn(async () => {}) });
});

describe('Banners — the audio system (today’s AudioSystemBanner cases)', () => {
  it('offers a repair, not a retry, for a macOS driver that was never loaded', () => {
    unavailable('mac-driver-not-loaded');
    render(<Banners />);
    expect(screen.getByText('audioSystem.macDriverNotLoadedBody')).toBeTruthy();
    expect(screen.queryByText('audioSystem.retry')).toBeNull();
    fireEvent.click(screen.getByText('audioSystem.repair'));
    expect(useAudioSystemStore.getState().repair).toHaveBeenCalledWith('audioSystem.macRepairPrompt');
  });
  it('says so when the repair did not bring the device back', () => {
    unavailable('mac-driver-not-loaded', { repairFailed: true });
    render(<Banners />);
    expect(screen.getByText('audioSystem.macRepairFailedBody')).toBeTruthy();
  });
  it('disables the button while the repair runs', () => {
    unavailable('mac-driver-not-loaded', { repairing: true });
    render(<Banners />);
    expect((screen.getByText('audioSystem.repairing').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps the retry for the other reasons, and the command for a missing pactl', () => {
    unavailable('pulseaudio-unavailable');
    const { unmount } = render(<Banners />);
    fireEvent.click(screen.getByText('audioSystem.retry'));
    expect(useAudioSystemStore.getState().retry).toHaveBeenCalled();
    unmount();
    unavailable('pactl-missing');
    const { container } = render(<Banners />);
    expect(container.querySelector('.banner__code')?.textContent).toBe('audioSystem.installCommand');
  });
  it('is attention-toned, dismissible, and gone once dismissed', () => {
    unavailable('pulseaudio-unavailable');
    const { container } = render(<Banners />);
    expect(container.querySelector('.banner--attention')).not.toBeNull();
    fireEvent.click(container.querySelector('.banner__dismiss')!);
    expect(useAudioSystemStore.getState().dismissed).toBe(true);
  });
});

it('warns for the current speaker route and remembers dismissal during this launch', () => {
  useAudioStore.setState({ nativeFormsCurrent: false, defaultOutputForm: { formFactor: 'speakers', transport: 'builtin' } });
  const { rerender, unmount } = render(<MeetingHeadphonesNotice visible />);
  const notice = () => screen.queryByText('echoNotice.startupSpeakers');
  expect(notice()).toBeNull();
  act(() => useAudioStore.setState({ nativeFormsCurrent: true }));
  expect(notice()).toBeVisible();
  act(() => useAudioStore.setState({ defaultOutputForm: { formFactor: 'headphones', transport: 'usb' } }));
  expect(notice()).toBeNull();
  act(() => useAudioStore.setState({ defaultOutputForm: { formFactor: 'speakers', transport: 'builtin' } }));
  fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
  rerender(<MeetingHeadphonesNotice visible={false} />);
  rerender(<MeetingHeadphonesNotice visible />);
  expect(notice()).toBeNull();
  unmount();
  render(<MeetingHeadphonesNotice visible />);
  expect(notice()).toBeVisible();
  act(() => useAudioStore.setState({ nativeFormsCurrent: false }));
});
