import { useLayoutEffect, useState } from 'react';
import useAudioStore from '../../stores/audioStore';
import { isElectron } from '../../utils/environment';
import { chooseOutput } from './deviceChoice';

// React may reuse the same media node when a recording URL changes. Keep the
// queue on the node itself so a request started by an old effect cannot land
// after a newer effect has already bound that live node to another output.
const sinkSwitches = new WeakMap<HTMLMediaElement, Promise<void>>();

function switchSink(el: HTMLMediaElement, sinkId: string): Promise<void> {
  const previous = sinkSwitches.get(el) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    if ((el.sinkId || '') !== sinkId) await el.setSinkId(sinkId);
  });
  sinkSwitches.set(el, next);
  return next;
}

/** Bind standalone players to a local speaker and stop them if the meeting can hear their output. */
export function useLocalMediaOutput(elements: () => HTMLMediaElement[], media: unknown) {
  const [ready, setReady] = useState(true);
  useLayoutEffect(() => {
    if (!isElectron()) return;
    const players = elements();
    let disposed = false;
    let requested: string | null | undefined;
    let generation = 0;
    const update = async () => {
      const state = useAudioStore.getState();
      const cablePresent = state.audioMonitorDevices.some(device => device.isVirtual);
      const selected = state.selectedMonitorDevice?.deviceId ?? null;
      const output = cablePresent
        ? chooseOutput({ devices: state.audioMonitorDevices, savedId: selected, currentId: null })?.deviceId ?? null : '';
      // Until every output has its own label, a placeholder can make a
      // virtual meeting cable look physical. Keep standalone media muted
      // until we can positively choose a local device.
      const next = !state.devicesLoaded || !state.outputLabelsKnown ? null : output;
      if (next === requested) return;
      requested = next;
      const mine = ++generation;
      for (const el of players) {
        el.muted = true;
        if (!el.paused) el.pause();
      }
      setReady(false);
      if (next === null) return;
      // Serialize each node independently. The queue survives effect cleanup,
      // which matters when React reuses a live <audio> for a different URL.
      const results = await Promise.allSettled(players.map(el => {
        if (disposed || generation !== mine) return Promise.resolve();
        return switchSink(el, next);
      }));
      if (disposed || generation !== mine || results.some(result => result.status === 'rejected')) return;
      for (const el of players) el.muted = false;
      setReady(true);
    };
    const offAudio = useAudioStore.subscribe(update);
    update();
    return () => {
      disposed = true;
      offAudio();
      for (const el of players) el.muted = true;
    };
  }, [elements, media]);
  return ready;
}
