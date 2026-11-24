/**
 * The page's run, read from React (plan 1e-3b-1 ruling 5): its whole state,
 * its phase, and whether the settings a run fixes are locked. Code outside
 * React reads the phase through `runPhase.ts`.
 */
import { useStore } from 'zustand';
import { planFromStores } from '../lib/plan/fromStores';
import { transcriptionProvider } from '../lib/plan/read';
import type { OutgoingTarget, RunState } from '../lib/session/types';
import { useProviderStore } from '../stores/providerStore';
import { getAppSession } from './session';

export function useRunState(): RunState {
  return useStore(getAppSession().runner.state);
}

export function useRunPhase(): RunState['phase'] {
  return useStore(getAppSession().runner.state, (s) => s.phase);
}

/** The settings "What may change during a run" does not list are locked while the phase is not idle — through starting and stopping too (1e-3 ruling 9). */
export function useSessionLocked(): boolean {
  return useRunPhase() !== 'idle';
}

/** The run's frozen Translation I hear while a run is not idle, else null: what the open participant leg actually does, whatever the live stores say now (the source picker stays live during a run). */
export function useRunParticipantSpeech(): boolean | null {
  return useStore(getAppSession().runner.state, (s) => (s.phase === 'idle' ? null : s.participantSpeech));
}

export function useRunOutgoingTarget(): OutgoingTarget | null {
  return useStore(getAppSession().runner.state, (s) => (s.phase === 'running' ? s.outgoingTarget ?? null : null));
}

export async function setRunOutgoingTarget(language: string): Promise<boolean> {
  const found = planFromStores();
  if (found.state !== 'ready') return false;
  const provider = transcriptionProvider(found.plan);
  if (!await getAppSession().runner.setOutgoingTarget(language)) return false;
  const store = useProviderStore.getState();
  const pair = store.entries[provider.id]?.pair;
  if (pair && pair.target !== language) {
    // Older profiles inferred the incoming source from the outgoing target.
    // Keep that source when the outgoing leg is changed during a run.
    if (provider.id === 'qwen_livetranslate' && store.incomingLanguage === undefined) store.setIncomingLanguage(pair.target);
    store.setPair(provider, { ...pair, target: language });
  }
  return true;
}
