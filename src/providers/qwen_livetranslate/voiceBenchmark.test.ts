import { expect, it, vi } from 'vitest';
import { SAMPLE_RATE } from '../../lib/contract/adapter';
import { FakeSocket } from '../../lib/contract/testing/fakeSocket';
import { BAILIAN_ENDPOINT_ID } from './endpoints';
import { runQwenVoiceBenchmark } from './voiceBenchmark';

it('runs each voice on the same single clip and reports only benchmark measurements', async () => {
  const sockets: FakeSocket[] = [];
  const fixedVoice = 'test-fixed-voice';
  const result = await runQwenVoiceBenchmark({
    endpoint: BAILIAN_ENDPOINT_ID,
    apiKey: 'test-key',
    fixedVoice,
    clips: [{ pcm: new Int16Array(480), sampleRate: SAMPLE_RATE }],
    sleep: async () => {},
    startRound: 1,
    openHeaderSocket: async (url) => {
      const socket = new FakeSocket(url, undefined);
      sockets.push(socket);
      socket.open();
      const send = socket.send.bind(socket);
      vi.spyOn(socket, 'send').mockImplementation((data) => {
        send(data);
        const { type } = JSON.parse(String(data));
        if (type === 'session.update') socket.receive(JSON.stringify({ type: 'session.updated' }));
        if (type === 'input_audio_buffer.commit') {
          socket.receive(JSON.stringify({ type: 'response.audio.delta', delta: 'AQI=' }));
          socket.receive(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
        }
      });
      setTimeout(() => socket.receive(JSON.stringify({ type: 'session.created' })), 0);
      return socket as unknown as WebSocket;
    },
  });

  expect(result.completedTrials).toBe(3);
  expect(result.trials.map(({ mode, clip, inputPcmSamples }) => [mode, clip, inputPcmSamples])).toEqual([
    ['clone_always', 1, 480], ['fixed_never', 1, 480], ['preset_tina', 1, 480],
  ]);
  expect(sockets.map((socket) => socket.sentJson<{ session: { audio: { output: { voice: string } } } }>()[0].session.audio.output.voice))
    .toEqual(['default', fixedVoice, 'Tina']);
  expect(JSON.stringify(result)).not.toContain(fixedVoice);
});
