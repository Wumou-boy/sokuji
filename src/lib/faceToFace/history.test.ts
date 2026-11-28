// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { realStorePort } from '../history/testing/realStorePort';
import { createVirtualClock } from '../contract/clock';
import { createHistoryRecorder } from '../history/recording/recorder';
import type { OpusEncoderFactory } from '../history/recording/track';
import type { FaceToFaceCaption } from '../../stores/faceToFaceStore';
import type { HistoryPort } from '../history/port';
import { FaceToFaceHistory, faceToFaceTranslation } from './history';

let real: ReturnType<typeof realStorePort> | undefined;
const { openHistory } = createRequire(import.meta.url)('../../../electron/history-store.js') as {
  openHistory(options: { dir: string }): Record<string, (arg?: unknown) => unknown> & { close(): void };
};
afterEach(() => { real?.dispose(); real = undefined; });

const make = () => {
  real = realStorePort();
  return new FaceToFaceHistory({
    id: 'face-0001-aaaa', startedAt: 1_800_000_000_000, provider: 'qwen_livetranslate',
    firstLanguage: 'zh', secondLanguage: 'en', thirdLanguage: 'ja', appVersion: 'test', port: real.port,
  });
};

const caption = (id: string, source: string, overrides: Partial<FaceToFaceCaption> = {}): FaceToFaceCaption => ({
  id, source, sourceLanguage: 'zh', speakerNumber: 1,
  subtitles: { zh: source, en: `English ${source}`, ja: `日本語 ${source}` }, final: false,
  ...overrides,
});
const settleWrites = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

const HEAD = new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 156, 0, 192, 93, 0, 0, 0, 0, 0]);
const encoder: OpusEncoderFactory = (onPacket, onHead) => {
  let held = 0;
  let head = false;
  return {
    encode(pcm) {
      if (!head) { head = true; onHead(HEAD); }
      held += pcm.length;
      while (held >= 480) { held -= 480; onPacket(new Uint8Array([1, 2, 3]), 960); }
    },
    async flush() { if (held > 0) { held = 0; onPacket(new Uint8Array([4, 5, 6]), 960); } },
    close() {},
  };
};

describe('face-to-face History lifecycle', () => {
  it('archives German as a selected subtitle and keeps a region-tagged original only once', () => {
    expect(faceToFaceTranslation(caption('de-1', 'Guten Morgen.', {
      sourceLanguage: 'de-DE', subtitles: { de: 'Guten Morgen.', zh: '早上好。' },
    }))).toBe('中文: 早上好。');
    expect(faceToFaceTranslation(caption('zh-1', '早上好。', {
      subtitles: { zh: '早上好。', de: 'Guten Morgen.' },
    }))).toBe('Deutsch: Guten Morgen.');
  });

  it('writes more than 100 stable turns with the final text and all selected subtitle languages, then reads them after reopening', async () => {
    const history = make();
    for (let index = 1; index <= 121; index += 1) {
      const id = `turn-${index}`;
      history.caption(caption(id, `临时 ${index}`), 1_800_000_000_000 + index * 1000);
      history.caption(caption(id, `定稿 ${index}`, { final: true }), 1_800_000_000_500 + index * 1000);
    }
    await history.close(1_800_000_200_000);

    const dir = real!.dir;
    real!.store.close();
    const restarted = openHistory({ dir });
    const reopened = restarted.getRecord('face-0001-aaaa') as Awaited<ReturnType<HistoryPort['getRecord']>>;
    expect(reopened).toMatchObject({ mode: 'face-to-face', state: 'closed', notes: [] });
    expect(reopened?.transcripts).toHaveLength(1);
    const rows = restarted.getSentences({ transcriptId: reopened!.transcripts[0].id }) as Awaited<ReturnType<HistoryPort['getSentences']>>;
    expect(rows).toHaveLength(121);
    expect(rows[0]).toMatchObject({ n: 1, segmentId: 'turn-1', text: '定稿 1', language: 'zh', speaker: '1' });
    expect(rows[0].translation).toBe('English: English 定稿 1\n日本語: 日本語 定稿 1');
    expect(rows[rows.length - 1]).toMatchObject({ n: 121, segmentId: 'turn-121', text: '定稿 121' });
    expect(restarted.listRecords({})).toHaveLength(1);
    restarted.close();
    rmSync(dir, { recursive: true, force: true });
    real = undefined;
  });

  it('keeps source-only partial captions and later revisions, without creating any external notes', async () => {
    const history = make();
    history.caption(caption('turn-a', 'partial', { subtitles: { zh: 'partial' } }), 1_800_000_000_100);
    history.caption(caption('turn-a', 'final source', { final: true, subtitles: { zh: 'final source', en: 'final translation' } }), 1_800_000_000_500);
    await history.close(1_800_000_010_000);
    const record = await real!.port.getRecord('face-0001-aaaa');
    const rows = await real!.port.getSentences({ transcriptId: record!.transcripts[0].id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'final source', translation: 'English: final translation' });
    expect(record!.notes).toEqual([]);
  });

  it('reports a partial write and retries the same stable sentence on the next update', async () => {
    real = realStorePort();
    let appendAttempts = 0;
    const statuses: string[] = [];
    const append = real.port.appendSentences.bind(real.port);
    const port = {
      ...real.port,
      appendSentences: async (args: Parameters<HistoryPort['appendSentences']>[0]) => {
        appendAttempts += 1;
        if (appendAttempts <= 3) throw new Error('temporary local store failure');
        return append(args);
      },
    } as HistoryPort;
    const history = new FaceToFaceHistory({
      id: 'face-0002-bbbb', startedAt: 1_800_000_000_000, provider: 'qwen_livetranslate',
      firstLanguage: 'zh', secondLanguage: 'en', appVersion: 'test', port,
      onStatus: (status) => statuses.push(status),
    });
    history.caption(caption('turn-a', 'partial'), 1_800_000_000_100);
    history.caption(caption('turn-a', 'recovered', { final: true }), 1_800_000_000_500);
    await history.close(1_800_000_010_000);
    const record = await real.port.getRecord('face-0002-bbbb');
    const rows = await real.port.getSentences({ transcriptId: record!.transcripts[0].id });
    expect(appendAttempts).toBe(4);
    expect(statuses).toContain('partial');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n: 1, segmentId: 'turn-a', text: 'recovered' });
  });

  it('labels each target language separately while omitting a repeated source line', () => {
    expect(faceToFaceTranslation(caption('x', 'こんにちは', {
      sourceLanguage: 'ja', subtitles: { ja: 'こんにちは', en: 'Hello', zh: '你好' },
    }))).toBe('English: Hello\n中文: 你好');
  });

  it('opens on the first PCM, stores one microphone track through the shared encoder lifecycle, then closes it', async () => {
    real = realStorePort();
    const startedAt = 1_800_000_000_000;
    const clock = createVirtualClock(startedAt);
    const order: string[] = [];
    const baseOpen = real.port.openRecord.bind(real.port);
    const baseClose = real.port.closeRecord.bind(real.port);
    const baseAppend = real.port.appendTrack.bind(real.port);
    const port = {
      ...real.port,
      openRecord: async (value: Parameters<HistoryPort['openRecord']>[0]) => { order.push('open'); return baseOpen(value); },
      appendTrack: async (value: Parameters<HistoryPort['appendTrack']>[0]) => { order.push(`track:${value.source}`); return baseAppend(value); },
      closeRecord: async (value: Parameters<HistoryPort['closeRecord']>[0]) => { order.push('close'); return baseClose(value); },
    } as HistoryPort;
    const recorder = createHistoryRecorder({ port, clock, encoder, report: vi.fn(), tell: vi.fn() });
    const history = new FaceToFaceHistory({
      id: 'face-audio-0001', startedAt, provider: 'qwen_livetranslate', firstLanguage: 'zh', secondLanguage: 'en',
      appVersion: 'test', port, recorder,
    });
    const pcm = new Int16Array(24_000).fill(100);
    history.pcm(pcm);
    history.pcm(pcm);
    history.caption(caption('audio-turn', 'spoken'), startedAt + 1900);
    clock.advance(2000);
    const result = await history.close(startedAt + 2000);

    expect(result).toMatchObject({ kept: true, complete: true });
    expect(order[0]).toBe('open');
    expect(order[order.length - 1]).toBe('close');
    expect(order.filter((item) => item === 'track:speaker')).toHaveLength(1);
    expect(order).not.toContain('track:participant');
    const record = await real.port.getRecord('face-audio-0001');
    expect(record?.tracks).toHaveLength(1);
    expect(record?.tracks[0]).toMatchObject({ source: 'speaker', offsetMs: 0, durationMs: 1997 });
    expect(record?.tracks[0].bytes).toBeGreaterThan(0);
    const rows = await real.port.getSentences({ transcriptId: result.transcriptId! });
    expect(rows).toHaveLength(1);
  });

  it('keeps a captionless face-to-face speaker track but never starts notes for that empty transcript', async () => {
    real = realStorePort();
    const startedAt = 1_800_000_000_000;
    const clock = createVirtualClock(startedAt);
    const written: string[] = [];
    const port = {
      ...real.port,
      appendTrack: async (value: Parameters<HistoryPort['appendTrack']>[0]) => {
        written.push(value.source);
        return real!.port.appendTrack(value);
      },
    } as HistoryPort;
    const recorder = createHistoryRecorder({ port, clock, encoder, report: vi.fn(), tell: vi.fn() });
    const history = new FaceToFaceHistory({
      id: 'face-audio-only-01', startedAt, provider: 'qwen_livetranslate', firstLanguage: 'zh', secondLanguage: 'en',
      appVersion: 'test', port, recorder,
    });
    history.pcm(new Int16Array(24_000).fill(100));
    clock.advance(1000);
    const result = await history.close(startedAt + 1000);
    expect(written).toEqual(['speaker']);
    expect(result).toMatchObject({ kept: true, complete: true, transcriptId: null });
    const record = await real.port.getRecord('face-audio-only-01');
    expect(record).toMatchObject({ state: 'closed', hasRecording: true, notes: [], transcripts: [] });
  });

  it('drops a face-to-face run that never receives PCM or captions', async () => {
    const history = make();
    expect(await history.close(1_800_000_010_000)).toMatchObject({ kept: false, complete: false });
    expect(await real!.port.getRecord('face-0001-aaaa')).toBeNull();
  });

  it('revises a flushed provisional cue to the final provider range and keeps it after reopening', async () => {
    const history = make();
    const startedAt = 1_800_000_000_000;
    history.caption(caption('timed', 'partial', { startAt: startedAt + 1200 }), startedAt + 2200);
    await settleWrites();
    const record = await real!.port.getRecord('face-0001-aaaa');
    const first = await real!.port.getSentences({ transcriptId: record!.transcripts[0].id });
    expect(first[0]).toMatchObject({ startMs: 1200, endMs: 2200, timeKind: 'estimated' });
    history.caption(caption('timed', 'final', {
      final: true, startAt: startedAt + 1200, endAt: startedAt + 1900, timeKind: 'given',
    }), startedAt + 2400);
    history.caption(caption('timed', 'final', { final: true, speakerNumber: 2 }), startedAt + 2800);
    const result = await history.close(startedAt + 3000);
    const rows = await real!.port.getSentences({ transcriptId: result.transcriptId! });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startMs: 1200, endMs: 1900, timeKind: 'given', text: 'final' });
    const dir = real!.dir;
    real!.store.close();
    const reopened = openHistory({ dir });
    const persisted = reopened.getRecord('face-0001-aaaa') as Awaited<ReturnType<HistoryPort['getRecord']>>;
    const replay = reopened.getSentences({ transcriptId: persisted!.transcripts[0].id }) as Awaited<ReturnType<HistoryPort['getSentences']>>;
    expect(replay[0]).toMatchObject({ startMs: 1200, endMs: 1900, timeKind: 'given', text: 'final' });
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
    real = undefined;
  });
});
