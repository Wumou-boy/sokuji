import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '../../locales';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import FaceToFaceMode from './FaceToFaceMode';

vi.mock('../../lib/faceToFace/runtime', () => ({
  startFaceToFaceRuntime: vi.fn(),
  stopFaceToFaceRuntime: vi.fn(),
}));

const captions = [
  { id: 'first', source: '你好', sourceLanguage: 'zh', speakerNumber: 1, subtitles: { zh: '你好', ja: 'こんにちは' }, final: true },
  { id: 'second', source: 'ありがとう', sourceLanguage: 'ja', speakerNumber: 2, subtitles: { zh: '谢谢', ja: 'ありがとう' }, final: true },
];

/** jsdom has no layout; model the captions section as a scrolling box. */
async function mountScrollable() {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({ languages: { first: 'zh', second: 'ja' }, captions });
  const view = render(<FaceToFaceMode onExit={() => {}} />);
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

afterEach(() => { vi.useRealTimers(); });

it('shows both languages in the chosen order for each automatically numbered speaker', async () => {
  await i18n.changeLanguage('en');
  useFaceToFaceStore.setState({
    languages: { first: 'zh', second: 'ja' },
    captions: [
      { id: 'first', source: '你好', sourceLanguage: 'zh', speakerNumber: 1, subtitles: { zh: '你好', ja: 'こんにちは' }, final: true },
      { id: 'second', source: 'ありがとう', sourceLanguage: 'ja', speakerNumber: 2, subtitles: { zh: '谢谢', ja: 'ありがとう' }, final: true },
    ],
  });
  render(<FaceToFaceMode onExit={() => {}} />);

  expect(screen.getAllByRole('combobox')).toHaveLength(2);
  const [first, second] = screen.getAllByRole('article');
  expect(within(first).getByText('Speaker 1')).toBeInTheDocument();
  expect(within(second).getByText('Speaker 2')).toBeInTheDocument();
  expect(within(first).getAllByText(/^(你好|こんにちは)$/).map((element) => element.textContent)).toEqual(['你好', 'こんにちは']);
  expect(within(second).getAllByText(/^(谢谢|ありがとう)$/).map((element) => element.textContent)).toEqual(['谢谢', 'ありがとう']);
  expect(screen.queryByRole('button', { name: /person [ab]|assign/i })).toBeNull();
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
  render(<FaceToFaceMode onExit={() => {}} />);

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
