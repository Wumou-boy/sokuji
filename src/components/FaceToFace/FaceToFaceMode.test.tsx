import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../../locales';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { useSessionTokenStore } from '../../lib/usage/sessionTokens';
import { useLineUpStore } from '../../stores/lineUpStore';
import useAudioStore from '../../stores/audioStore';
import useSettingsStore from '../../stores/settingsStore';
import { readFaceToFaceInputPeak, startFaceToFaceRuntime } from '../../lib/faceToFace/runtime';
import FaceToFaceMode from './FaceToFaceMode';

vi.mock('../../lib/faceToFace/runtime', () => ({
  readFaceToFaceInputPeak: vi.fn(() => 0),
  startFaceToFaceRuntime: vi.fn(),
  stopFaceToFaceRuntime: vi.fn(),
}));

const captions = [
  { id: 'first', source: '你好', sourceLanguage: 'zh', speakerNumber: 1, subtitles: { zh: '你好', ja: 'こんにちは' }, final: true },
  { id: 'second', source: 'ありがとう', sourceLanguage: 'ja', speakerNumber: 2, subtitles: { zh: '谢谢', ja: 'ありがとう' }, final: true },
];

beforeEach(() => useLineUpStore.setState({ lineUp: {
  transcription: 'qwen_livetranslate', translation: 'qwen_livetranslate', speech: null, summarisation: null,
} }));

/** jsdom has no layout; model the captions section as a scrolling box. */
async function mountScrollable() {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({ languages: { first: 'zh', second: 'ja' }, captions });
  const view = render(<FaceToFaceMode />);
  const el = screen.getByRole('region', { name: 'Conversation subtitles' }) as HTMLElement;
  const box = { height: 800, client: 300, top: 0 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.top,
    set: (value: number) => { box.top = Math.max(0, Math.min(value, box.height - box.client)); },
  });
  el.scrollTo = vi.fn() as typeof el.scrollTo;
  const update = (height: number, next = [...captions]) => {
    box.height = height;
    act(() => useFaceToFaceStore.setState({ captions: next }));
  };
  return { view, el, box, update };
}

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    useSessionTokenStore.setState({ 'face-to-face': null });
    useFaceToFaceStore.setState({ phase: 'idle', historyStatus: 'idle', recordingFailed: false, settingsError: false, error: null, languages: { first: 'zh', second: 'ja' }, runLanguages: null, localSpeakerStatus: 'idle' });
  });
});

it('shows an accessible zero microphone level while idle without polling or opening audio', async () => {
  await i18n.changeLanguage('en');
  vi.mocked(readFaceToFaceInputPeak).mockClear();
  render(<FaceToFaceMode />);

  const meter = screen.getByRole('meter', { name: 'Microphone input level' });
  expect(meter).toHaveAttribute('aria-valuenow', '0');
  expect(meter).toHaveAttribute('aria-valuetext', '−∞ dBFS');
  expect(meter.querySelector('.face-to-face-mode__mic-meter-fill')).toHaveStyle({ width: '0%' });
  expect(readFaceToFaceInputPeak).not.toHaveBeenCalled();
  expect(startFaceToFaceRuntime).not.toHaveBeenCalled();
});

it('updates only the live microphone meter from the runtime peak', async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  vi.mocked(readFaceToFaceInputPeak).mockReturnValue(0.5);
  useFaceToFaceStore.setState({ phase: 'live' });
  render(<FaceToFaceMode />);

  const meter = screen.getByRole('meter', { name: 'Microphone input level' });
  expect(meter).toHaveAttribute('aria-valuenow', '50');
  expect(meter).toHaveAttribute('aria-valuetext', '-6 dBFS');
  expect(meter.querySelector('.face-to-face-mode__mic-meter-fill')).toHaveStyle({ width: '90%' });

  vi.mocked(readFaceToFaceInputPeak).mockReturnValue(0.25);
  act(() => { vi.advanceTimersByTime(100); });
  expect(screen.getByRole('meter', { name: 'Microphone input level' })).toHaveAttribute('aria-valuenow', '25');
});

it('shows Face to Face session token usage beside its start control', async () => {
  await i18n.changeLanguage('en');
  useSessionTokenStore.setState({ 'face-to-face': { inputTokens: 40, outputTokens: 12, totalTokens: 52, billableTokens: 48, reported: true } });
  render(<FaceToFaceMode />);

  const meter = document.querySelector('.face-to-face-mode__toolbar .session-token-meter')!;
  expect(meter.textContent).toContain('52');
  expect(meter.getAttribute('title')).toBe('Session tokens: 52 total (40 input, 12 output; 48 billable)');
});

it('shows both languages in the chosen order for each automatically numbered speaker', async () => {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({
    languages: { first: 'zh', second: 'ja' },
    captions: [
      { id: 'first', source: '你好', sourceLanguage: 'zh', speakerNumber: 1, subtitles: { zh: '你好', ja: 'こんにちは' }, final: true },
      { id: 'second', source: 'ありがとう', sourceLanguage: 'ja', speakerNumber: 2, subtitles: { zh: '谢谢', ja: 'ありがとう' }, final: true },
    ],
  });
  render(<FaceToFaceMode />);

  expect(screen.getAllByRole('combobox')).toHaveLength(3);
  expect(screen.queryByRole('combobox', { name: 'Translation service' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Microphone' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'First subtitle language' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Second subtitle language' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Third subtitle language' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'First subtitle language' }).querySelectorAll('option')).toHaveLength(60);
  const [first, second] = screen.getAllByRole('article');
  expect(within(first).getByText('Speaker 1')).toBeInTheDocument();
  expect(within(second).getByText('Speaker 2')).toBeInTheDocument();
  expect(within(first).getAllByText(/^(你好|こんにちは)$/).map((element) => element.textContent)).toEqual(['你好', 'こんにちは']);
  expect(within(second).getAllByText(/^(谢谢|ありがとう)$/).map((element) => element.textContent)).toEqual(['谢谢', 'ありがとう']);
  expect(screen.queryByRole('button', { name: /person [ab]|assign/i })).toBeNull();
});

it('offers an optional third language and shows the original first in the subtitles', async () => {
  await i18n.changeLanguage('en');
  render(<FaceToFaceMode />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Third subtitle language' }), { target: { value: 'en' } });
  act(() => useFaceToFaceStore.setState({ captions: [{
    id: 'three', source: 'Good morning', sourceLanguage: 'en',
    subtitles: { zh: '早上好', ja: 'おはよう', en: 'Good morning' }, final: true,
  }] }));
  expect(screen.getByText('Speaker not identified')).toBeInTheDocument();
  expect(within(screen.getByRole('article')).getAllByText(/^(Good morning|早上好|おはよう)$/).map((line) => line.textContent))
    .toEqual(['Good morning', '早上好', 'おはよう']);
  expect(screen.queryByRole('checkbox', { name: 'Local speaker recognition' })).toBeNull();
});

it('follows the shared translation service and opens its settings when the selected service is unsupported', async () => {
  await i18n.changeLanguage('en');
  const previous = useLineUpStore.getState().lineUp;
  const previousTarget = useSettingsStore.getState().settingsNavigationTarget;
  const { selectedInputDevice, devicesLoaded, isMicMuted, audioInputDevices } = useAudioStore.getState();
  const inputs = [{ deviceId: 'test-mic', label: 'Desk microphone' }, { deviceId: 'second-mic', label: 'Second microphone' }];
  const stages = { transcription: 'qwen_livetranslate', translation: 'qwen_livetranslate', speech: null, summarisation: null };
  try {
    useLineUpStore.setState({ lineUp: stages });
    useAudioStore.setState({ devicesLoaded: true, isMicMuted: false, audioInputDevices: inputs, selectedInputDevice: inputs[0] });
    render(<FaceToFaceMode />);
    const start = screen.getByRole('button', { name: 'Start listening' });
    expect(start).toBeEnabled();
    act(() => useLineUpStore.setState({ lineUp: { ...stages, translation: 'local_inference' } }));
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(startFaceToFaceRuntime).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Translation settings' }));
    expect(useSettingsStore.getState().settingsNavigationTarget).toBe('lineup');
    act(() => useLineUpStore.setState({ lineUp: { ...stages, translation: 'openai_translate' } }));
    expect(start).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'First subtitle language' }).querySelectorAll('option')).toHaveLength(13);
    expect(screen.queryByRole('button', { name: 'Translation settings' })).toBeNull();
    act(() => useAudioStore.setState({ isMicMuted: true }));
    act(() => useFaceToFaceStore.getState().setPhase('error', 'Previously muted microphone', true));
    expect(screen.queryByText('Previously muted microphone')).toBeNull();
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Microphone settings' }));
    expect(useSettingsStore.getState().settingsNavigationTarget).toBe('microphone');
    act(() => useAudioStore.setState({ isMicMuted: false, selectedInputDevice: null }));
    expect(start).toBeDisabled();
    act(() => useAudioStore.setState({ selectedInputDevice: inputs[1] }));
    expect(start).toBeEnabled();
    expect(start).toHaveAccessibleName('Start listening');
  } finally {
    act(() => {
      useLineUpStore.setState({ lineUp: previous });
      useAudioStore.setState({ selectedInputDevice, devicesLoaded, isMicMuted, audioInputDevices });
      useSettingsStore.setState({ settingsNavigationTarget: previousTarget });
    });
  }
});

it('uses the effective OpenAI targets for selection edits without rewriting the preference on service change', async () => {
  await i18n.changeLanguage('en');
  const stages = { transcription: 'qwen_livetranslate', translation: 'qwen_livetranslate', speech: null, summarisation: null };
  useLineUpStore.setState({ lineUp: stages });
  useFaceToFaceStore.setState({ languages: { first: 'de', second: 'yue', third: 'en' } });
  const firstWrites = useFaceToFaceStore.getState().languages;
  act(() => useLineUpStore.setState({ lineUp: { ...stages, translation: 'openai_translate' } }));
  render(<FaceToFaceMode />);

  const first = screen.getByRole('combobox', { name: 'First subtitle language' });
  const second = screen.getByRole('combobox', { name: 'Second subtitle language' });
  expect(first).toHaveValue('de');
  expect(second).toHaveValue('zh');
  expect(second.querySelectorAll('option')).toHaveLength(13);
  expect(useFaceToFaceStore.getState().languages).toEqual(firstWrites);

  fireEvent.change(first, { target: { value: 'fr' } });
  expect(useFaceToFaceStore.getState().languages).toEqual({ first: 'fr', second: 'zh', third: 'en' });
});

it('shows the active third subtitle during replay and preserves the saved language preference', async () => {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({
    languages: { first: 'zh', second: 'ja' },
    runLanguages: { first: 'zh', second: 'ja', third: 'en' },
    phase: 'live',
    captions: [{ id: 'replay-third', source: '早上好', sourceLanguage: 'zh', subtitles: { zh: '早上好', ja: 'おはよう', en: 'Good morning' }, final: true }],
  });
  render(<FaceToFaceMode />);

  expect(screen.getByRole('combobox', { name: 'Third subtitle language' })).toHaveValue('en');
  expect(useFaceToFaceStore.getState().languages.third).toBeUndefined();
  expect(within(screen.getByRole('article')).getAllByText(/^(早上好|おはよう|Good morning)$/).map((line) => line.textContent))
    .toEqual(['早上好', 'おはよう', 'Good morning']);
});

it('shows local speaker loading and unavailable states while listening', async () => {
  await i18n.changeLanguage('en');
  render(<FaceToFaceMode />);
  act(() => useFaceToFaceStore.getState().setLocalSpeakerStatus('loading'));
  expect(screen.getByText('Loading local speaker recognition…')).toBeInTheDocument();
  act(() => {
    useFaceToFaceStore.getState().setLocalSpeakerStatus('unavailable');
    useFaceToFaceStore.getState().setPhase('live');
  });
  expect(screen.getByText('Local speaker recognition unavailable for this session.')).toBeInTheDocument();
});

it('groups consecutive turns under one visible speaker header and starts a new header when the speaker changes', async () => {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({
    languages: { first: 'zh', second: 'ja' },
    captions: [
      { id: 'first', source: '你好', sourceLanguage: 'zh', speakerNumber: 1, subtitles: { zh: '你好', ja: 'こんにちは' }, final: true },
      { id: 'second', source: '今天好吗？', sourceLanguage: 'zh', speakerNumber: 1, subtitles: { zh: '今天好吗？', ja: '今日は元気ですか？' }, final: true },
      { id: 'third', source: '元気です', sourceLanguage: 'ja', speakerNumber: 2, subtitles: { zh: '我很好', ja: '元気です' }, final: true },
    ],
  });
  render(<FaceToFaceMode />);

  const [first, second, third] = screen.getAllByRole('article');
  expect(first).toHaveClass('conversation-row', 'with-header');
  expect(second).toHaveClass('conversation-row', 'grouped');
  expect(third).toHaveClass('conversation-row', 'with-header');
  expect(within(first).getByText('Speaker 1')).toBeInTheDocument();
  expect(within(second).queryByText('Speaker 1')).toBeNull();
  expect(within(third).getByText('Speaker 2')).toBeInTheDocument();
  expect(screen.getAllByText(/^Speaker [12]$/)).toHaveLength(2);
  expect(within(first).getAllByText(/^(你好|こんにちは)$/).map((element) => element.textContent)).toEqual(['你好', 'こんにちは']);
  expect(within(second).getAllByText(/^(今天好吗？|今日は元気ですか？)$/).map((element) => element.textContent)).toEqual(['今天好吗？', '今日は元気ですか？']);
  expect(within(third).getAllByText(/^(我很好|元気です)$/).map((element) => element.textContent)).toEqual(['我很好', '元気です']);
  expect(second).toHaveAccessibleName('Speaker 1');
});

it('follows a newly added caption row and text growth in the latest row', async () => {
  const { box, update } = await mountScrollable();

  const third = { id: 'third', source: 'おはよう', sourceLanguage: 'ja', speakerNumber: 1, subtitles: { zh: '早上好', ja: 'おはよう' }, final: true };
  update(1000, [...captions, third]);
  expect(box.top).toBe(700);

  const expanded = { ...third, subtitles: { zh: '早上好，今天也请多关照', ja: 'おはようございます。今日もよろしくお願いします' } };
  update(1100, [...captions, expanded]);
  expect(box.top).toBe(800);
});

it('keeps the reader on older captions while the latest caption changes', async () => {
  const { el, box, update } = await mountScrollable();
  fireEvent.wheel(el, { deltaY: -20 });
  box.top = 220;
  fireEvent.scroll(el);

  const changed = { ...captions[1], subtitles: { zh: '非常感谢', ja: '本当にありがとうございます' } };
  update(900, [captions[0], changed]);
  expect(box.top).toBe(220);
});

it('offers Back to live after reading back and restores following when clicked', async () => {
  const { el, box, update } = await mountScrollable();
  vi.useFakeTimers();
  fireEvent.wheel(el, { deltaY: -20 });
  box.top = 200;
  fireEvent.scroll(el);
  act(() => { vi.advanceTimersByTime(250); });

  const backToLive = screen.getByRole('button', { name: 'Back to latest' });
  expect(el.nextElementSibling).toBe(backToLive);
  fireEvent.click(backToLive);
  expect(box.top).toBe(500);
  expect(screen.queryByRole('button', { name: 'Back to latest' })).toBeNull();

  update(1000, [...captions, { id: 'third', source: 'おはよう', sourceLanguage: 'ja', speakerNumber: 1, subtitles: { zh: '早上好', ja: 'おはよう' }, final: true }]);
  expect(box.top).toBe(700);
});

it('keeps routine History saves quiet and shows a recording failure', async () => {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({ historyStatus: 'saved', recordingFailed: false });
  const { container } = render(<FaceToFaceMode />);
  expect(container.querySelector('.face-to-face-mode__history-status')).toBeNull();
  act(() => useFaceToFaceStore.setState({ historyStatus: 'saving' }));
  expect(container.querySelector('.face-to-face-mode__history-status')).toBeNull();
  act(() => useFaceToFaceStore.setState({ recordingFailed: true }));
  expect(screen.getByText('The microphone recording could not be saved in full.')).toBeVisible();
});
