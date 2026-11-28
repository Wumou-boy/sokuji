// A reconnect numbers people from 1 again: a speaker label carries its connection, so two connections' speaker 3 stay apart.
import { describe, it, expect } from 'vitest';
import { recordEvents } from '../../lib/contract/events';
import { QwenSegments } from './segments';

function personOf(connection: number): string | undefined {
  const { events, log } = recordEvents();
  const s = new QwenSegments({ sink: events, person: true, connection });
  s.heard('item1', 3);
  s.text('item1', 'source', 'Hello');
  const opened = log.find((e) => e.kind === 'segmentOpened');
  return (opened?.payload as { person?: string } | undefined)?.person;
}

describe('Qwen segments — person', () => {
  it("scopes the other side's speaker to its connection", () => {
    expect([personOf(1), personOf(2)]).toEqual(['1.3', '2.3']);
  });

  it('applies a late local assignment to the source and its linked translation', () => {
    const { events, log } = recordEvents();
    const s = new QwenSegments({ sink: events, person: true, localSpeakers: true });
    s.heard('heard', 8);
    s.text('heard', 'source', 'Hello');
    s.answer('translated', 'heard');
    s.text('translated', 'translation', '你好');

    s.localSpeaker('heard', 2);

    expect(log.filter((e) => e.kind === 'segmentSpeaker').map((e) => e.payload)).toEqual([
      { ref: 1, person: 'local.2' },
      { ref: 2, person: 'local.2' },
    ]);
  });

  it('does not mix provider speaker ids into a stream using local attribution', () => {
    const { events, log } = recordEvents();
    const s = new QwenSegments({ sink: events, person: true, localSpeakers: true, connection: 3 });
    s.heard('short-turn', 6);
    s.text('short-turn', 'source', 'Hi');

    expect(log.find((e) => e.kind === 'segmentOpened')?.payload).not.toHaveProperty('person');
  });

  it('keeps a local result that arrives before Qwen opens the source caption', () => {
    const { events, log } = recordEvents();
    const s = new QwenSegments({ sink: events, person: true, localSpeakers: true });
    s.localSpeaker('late-transcript', 1);
    s.heard('late-transcript', 5);
    s.text('late-transcript', 'source', 'Hello');

    expect(log.find((e) => e.kind === 'segmentOpened')?.payload).toMatchObject({ person: 'local.1' });
  });

  it('falls back to provider attribution when local recognition becomes unavailable', () => {
    const { events, log } = recordEvents();
    const s = new QwenSegments({ sink: events, person: true, localSpeakers: true, connection: 2 });
    s.heard('heard', 4);
    s.text('heard', 'source', 'Hello');
    s.answer('translated', 'heard');
    s.text('translated', 'translation', '你好');

    s.fallBackToProviderSpeakers();

    expect(log.filter((e) => e.kind === 'segmentSpeaker').map((e) => e.payload)).toEqual([
      { ref: 1, person: '2.4' },
      { ref: 2, person: '2.4' },
    ]);
  });
});
