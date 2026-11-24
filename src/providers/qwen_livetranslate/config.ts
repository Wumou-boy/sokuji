/**
 * Qwen LiveTranslate's `C`, `build` and `describe` (spec 2026-10-13, §5).
 * One builder for both legs: the participant's is the reversed direction,
 * in its own voice and with person labels unless they are off (D7). The
 * endpoint is the one the check found, or null for the adapter to find (§2).
 * A text-only target on a leg that speaks is refused here, so the update the
 * server would refuse is never sent.
 */
import { wordsFor } from '../../lib/words/forService';
import type { SessionContext } from '../../lib/contract/adapter';
import type { UsageDelta } from '../../lib/usage/ledger';
import { AUTO } from '../../lib/provider/languages';
import type { QwenTurnAudioBuffer } from '../../lib/faceToFace/audioBuffer';
import type { ProviderRefusal, SharedSettings } from '../../lib/run/types';
import { BAILIAN_ENDPOINT_ID, BAILIAN_WORKSPACE_CONNECTION, isEndpointId, normalizeBailianWorkspaceId, type EndpointId } from './endpoints';
import {
  QWEN_LANGUAGES, QWEN_MODEL, QWEN_PAUSE, QWEN_SPOKEN, qwenParticipantVoice, qwenSpeakerVoice, SPEAKER_CLONE, SPEAKER_CLONE_ONCE, QWEN_FIXED_VOICE_PREFIX, type QwenSettings,
} from './settings';

/** A preset by name, or the speaker cloned on every turn (`always`) or once at the start (`once`). */
export type QwenVoiceChoice = { kind: 'preset'; name: string } | { kind: 'clone'; frequency: 'always' | 'once' } | { kind: 'fixed'; id: string; ownerHash: string };

export interface QwenConfig {
  model: typeof QWEN_MODEL;
  /** Set only for real app activity sessions; diagnostic adapters leave this absent. */
  activity?: 'meeting' | 'face-to-face';
  tokenSink?: (delta: UsageDelta) => void;
  /** Kept with the run so workspace sessions can be recognized without inspecting a secret. */
  connection: QwenSettings['connection'];
  /** A validated DNS label only for `bailian-workspace`; never a base URL. */
  workspaceId: string | null;
  /** The key's endpoint as the check found it; null: the adapter finds it before it opens. */
  endpoint: EndpointId | null;
  /** A Qwen code, which is the app code. */
  target: string;
  /** `context.speech`: the update asks for audio only when the leg speaks. */
  speech: boolean;
  voice: QwenVoiceChoice;
  /** Push-to-talk: no server turn detection; a release commits. */
  manual: boolean;
  /** The participant leg, speaker labels on: each turn carries its speaker as `person`. */
  person: boolean;
  /** Locally labels incoming EN/JA/ZH source transcript text where unambiguous. */
  detectIncomingLanguage: boolean;
  /** Optional face-to-face replay source; populated only by the face-to-face runtime. */
  turnAudio?: QwenTurnAudioBuffer;
  /** Suppresses a same-language Chinese translation in incoming text-only captions. */
  skipSameLanguageText: boolean;
  /** Preferred translations, source term → its translation (`translation.corpus.phrases`); empty sends none. */
  phrases: Readonly<Record<string, string>>;
  /** The pause that ends a turn, in ms; null leaves the server's own (2500), as push-to-talk always does. */
  silenceMs: number | null;
  /** WebSocket only. It reaches `info.transport`, which analytics reports. */
  transport: 'websocket';
}

export function buildQwen(context: SessionContext, s: QwenSettings, shared: SharedSettings): QwenConfig | ProviderRefusal {
  const { target } = context.direction;
  // A guard: the languages offer the 60 only (never `AUTO` as a target), so the runner never builds another.
  if (!QWEN_LANGUAGES.some((o) => o.value === target)) return { refused: `Qwen LiveTranslate does not translate into ${target}.` };
  if (s.connection === BAILIAN_WORKSPACE_CONNECTION && !normalizeBailianWorkspaceId(s.workspaceId)) {
    return { refused: 'Enter a valid Bailian workspace ID before starting Qwen LiveTranslate.' };
  }
  // A stale pair can still name a text-only target on a leg that speaks: the server would refuse the update.
  if (context.speech && !QWEN_SPOKEN.some((o) => o.value === target)) return { refused: `Qwen LiveTranslate writes ${target} but does not speak it: turn speech off for this leg.` };
  const participant = shared.reversed(context.direction);
  const chosen = participant ? qwenParticipantVoice(s) : qwenSpeakerVoice(s);
  const workspace = s.connection === BAILIAN_WORKSPACE_CONNECTION;
  const endpoint = workspace ? null : s.connection === BAILIAN_ENDPOINT_ID ? BAILIAN_ENDPOINT_ID : shared.models[0]?.id;
  const incomingTextOnlyZh = participant && !context.speech && target === 'zh';
  const manual = context.turns === 'manual';
  // The pause field is not in 3.8's documented update: it goes on the wire only when it changes something.
  const pause = Number.isFinite(s.pauseMs) ? Math.min(QWEN_PAUSE.max, Math.max(QWEN_PAUSE.min, Math.round(s.pauseMs))) : QWEN_PAUSE.default;
  return {
    model: QWEN_MODEL,
    activity: 'meeting',
    connection: s.connection,
    workspaceId: workspace ? normalizeBailianWorkspaceId(s.workspaceId) : null,
    endpoint: isEndpointId(endpoint) ? endpoint : null,
    target,
    speech: context.speech,
    voice: chosen.startsWith(QWEN_FIXED_VOICE_PREFIX) || chosen.startsWith('qwen-translate-vc-') ? { kind: 'fixed', id: chosen, ownerHash: s.voiceOwnerHash }
      : chosen === SPEAKER_CLONE ? { kind: 'clone', frequency: 'always' }
      : chosen === SPEAKER_CLONE_ONCE ? { kind: 'clone', frequency: 'once' }
        : { kind: 'preset', name: chosen },
    manual,
    person: participant && s.speakerLabels,
    detectIncomingLanguage: participant && (context.direction.source === AUTO || incomingTextOnlyZh),
    skipSameLanguageText: incomingTextOnlyZh,
    // The word list's translations (spec §9): the provider's own old hotwords are no longer read.
    phrases: Object.fromEntries(wordsFor('qwen_livetranslate', shared.words?.entries ?? [], '').translations ?? []),
    silenceMs: manual || pause === QWEN_PAUSE.default ? null : pause,
    transport: 'websocket',
  };
}

export function describeQwen(c: QwenConfig): { translationModel: string } {
  return { translationModel: c.model };
}
