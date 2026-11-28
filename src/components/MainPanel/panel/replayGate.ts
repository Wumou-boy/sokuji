import { isApplicationSource } from '../../../lib/modern-audio/participantSource';
import type { RunState } from '../../../lib/session/types';
import type { Platform } from '../../../lib/provider/types';

export interface ReplayGateInput {
  run: RunState;
  platform: Platform;
  participantSourceId: string | undefined;
  captureWidened: boolean;
  /** Face-to-face: the participant leg captures nothing, so a replay is never recaptured. */
  faceToFace?: boolean;
}

/**
 * Replay is off while the participant leg captures the whole system during a
 * run: a replay would be captured and translated again as Other (decided for
 * 1e-3, roadmap "Decided for 1e"). Electron only — the extension captures the
 * meeting's tab, never the side panel; the web has no participant leg. A
 * source is the whole system unless it names one application (`app:…`) or
 * that application's capture fell back to the whole system this run.
 */
export function replayBlocked({ run, platform, participantSourceId, captureWidened, faceToFace }: ReplayGateInput): boolean {
  if (faceToFace) return false;
  if (run.phase !== 'running' || !run.legs.participant || platform !== 'electron') return false;
  return captureWidened || !isApplicationSource(participantSourceId);
}
