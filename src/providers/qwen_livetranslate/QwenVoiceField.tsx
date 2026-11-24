import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isElectron } from '../../utils/environment';
import VoiceLibrarySection, { type VoiceEntry } from '../../components/Settings/sections/VoiceLibrarySection';
import type { ProviderAccount } from '../../lib/provider/types';
import { SPEAKER_CLONE, SPEAKER_CLONE_ONCE, QWEN_VOICES, qwenParticipantVoice, type QwenSettings } from './settings';
import { BAILIAN_ENDPOINT_ID, BAILIAN_WORKSPACE_CONNECTION } from './endpoints';
import { encodeQwenVoiceWav, QwenVoiceError, qwenVoiceClient } from './voiceEnrollment';
import { ensureQwenVoiceProfileStorage, forgetQwenVoiceProfile, loadQwenVoiceProfiles, qwenVoiceKeyFingerprint, rememberQwenVoiceProfile, type StoredQwenVoice } from './voiceProfileStorage';

interface Props {
  settings: QwenSettings;
  update(patch: Partial<QwenSettings>): void;
  account?: ProviderAccount;
  endpoint?: string;
  disabled?: boolean;
  participantSpeaks?: boolean;
  managed?: boolean;
}

const cloneLabel = (voice: StoredQwenVoice) => voice.name || 'My voice';

/** Qwen's own outgoing voice library: local capture/review and explicit, model-matched enrollment. */
export default function QwenVoiceField({ settings, update, account, endpoint, disabled = false, participantSpeaks = false, managed = false }: Props) {
  const { t } = useTranslation();
  const workspace = settings.connection === BAILIAN_WORKSPACE_CONNECTION;
  const bailian = !workspace && (settings.connection === BAILIAN_ENDPOINT_ID || (settings.connection === 'auto' && endpoint === BAILIAN_ENDPOINT_ID));
  const apiKey = account?.credentials.apiKey?.trim() ?? '';
  const client = useMemo(() => bailian && apiKey ? qwenVoiceClient(apiKey) : null, [bailian, apiKey]);
  const [clones, setClones] = useState<StoredQwenVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<Blob | null>(null);
  const [referenceUrl, setReferenceUrl] = useState('');
  const [pendingSeq, setPendingSeq] = useState(0);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const generation = useRef(0);
  const selected = useRef(settings.voice);
  const settingsRef = useRef(settings);
  const updateRef = useRef(update);
  useEffect(() => { selected.current = settings.voice; settingsRef.current = settings; updateRef.current = update; }, [settings, update]);

  const refresh = useCallback(async () => {
    const seq = ++generation.current;
    if (!client || !apiKey || managed) { setClones([]); setLoading(false); return; }
    setLoading(true);
    try {
      const result = await loadQwenVoiceProfiles(apiKey);
      const ownerHash = await qwenVoiceKeyFingerprint(apiKey);
      if (seq !== generation.current) return;
      setClones(result);
      setLoadError(false);
      if ((selected.current.startsWith('qwen3.8-livetranslate-flash-realtime-') || selected.current.startsWith('qwen-translate-vc-'))
        && (settingsRef.current.voiceOwnerHash !== ownerHash || !result.some((v) => v.id === selected.current))) {
        updateRef.current({ voice: QWEN_VOICES[0].value, voiceOwnerHash: '' });
      }
    } catch {
      if (seq === generation.current) setLoadError(true);
    } finally { if (seq === generation.current) setLoading(false); }
  }, [apiKey, client, managed]);

  useEffect(() => {
    setClones([]);
    setLoadError(false);
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const onRecord = useCallback(async (clip: Float32Array, sampleRate: number) => {
    const seconds = clip.length / sampleRate;
    if (seconds < 10 || seconds > 20) throw new QwenVoiceError('Record between 10 and 20 seconds, as Qwen recommends.', 'duration');
    const blob = encodeQwenVoiceWav(clip, sampleRate);
    if (blob.size >= 10_000_000) throw new QwenVoiceError('The recording must be smaller than 10 MB.', 'audio_too_large');
    setPending(blob);
    setReferenceUrl('');
    setPendingSeq((n) => n + 1);
  }, []);

  const closeReview = () => { if (!modalBusy) { setPending(null); setModalError(null); } };
  const confirm = async (name: string, publicReferenceUrl?: string) => {
    if (!client || !pending || modalBusy) return;
    setModalBusy(true);
    setModalError(null);
    try {
      await ensureQwenVoiceProfileStorage(apiKey);
      const id = await client.create(pending, name, publicReferenceUrl);
      await rememberQwenVoiceProfile(apiKey, { id, name: name.trim() || t('providers.qwen_livetranslate.voiceDefaultName', 'My voice') });
      await refresh();
      update({ voice: id, voiceOwnerHash: await qwenVoiceKeyFingerprint(apiKey) });
      setPending(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('providers.qwen_livetranslate.voiceCreateFailed', 'Could not create this voice. Check your Bailian connection and try again.');
      const requestId = error instanceof QwenVoiceError ? error.requestId : undefined;
      setModalError(requestId ? `${message} (request ID: ${requestId})` : message);
    } finally { setModalBusy(false); }
  };

  const onDelete = async (id: string) => {
    if (!client) return;
    await client.delete(id);
    await forgetQwenVoiceProfile(apiKey, id);
    setClones((current) => current.filter((v) => v.id !== id));
    if (selected.current === id) update({ voice: QWEN_VOICES[0].value, voiceOwnerHash: '' });
  };

  const chooseVoice = async (voice: string) => {
    if (clones.some((v) => v.id === voice)) {
      try { update({ voice, voiceOwnerHash: await qwenVoiceKeyFingerprint(apiKey) }); }
      catch { update({ voice: QWEN_VOICES[0].value, voiceOwnerHash: '' }); }
    } else update({ voice, voiceOwnerHash: '' });
  };

  const baseVoices: VoiceEntry[] = [
    { id: SPEAKER_CLONE, label: t('providers.qwen_livetranslate.voiceClone', "Clone the speaker's voice"), group: 'builtin', removable: false, section: t('providers.qwen_livetranslate.voiceGroupClone', 'Voice cloning') },
    { id: SPEAKER_CLONE_ONCE, label: t('providers.qwen_livetranslate.voiceCloneOnce', "Clone the first speaker's voice"), group: 'builtin', removable: false, section: t('providers.qwen_livetranslate.voiceGroupClone', 'Voice cloning') },
  ];
  const participantId = qwenParticipantVoice(settings);
  const participantVoices = [
    ...baseVoices,
    ...QWEN_VOICES.map((v) => ({ id: v.value, label: v.name, group: 'builtin' as const, removable: false })),
  ];
  const voices: VoiceEntry[] = [
    ...baseVoices,
    ...clones.map((v) => ({ id: v.id, label: cloneLabel(v), group: 'custom' as const, removable: true })),
    ...QWEN_VOICES.map((v) => ({ id: v.value, label: v.name, group: 'builtin' as const, removable: false })),
  ];
  const canManage = !!client && isElectron() && !managed;
  const manageNote = managed ? undefined : canManage
    ? t('providers.qwen_livetranslate.voiceUploadNotice', 'After you confirm, this 10–20 second recording is uploaded to Alibaba Model Studio temporary storage (private, expires in 48 hours) to create a Qwen 3.8 voice. Voice creation may be billed. The resulting profile is retained by Alibaba until you delete it.')
    : workspace
      ? t('providers.qwen_livetranslate.voiceBailianOnly', 'Fixed voice enrollment currently requires the Bailian shared Beijing connection and its API key. Company workspace enrollment is not documented for this route.')
      : bailian && !isElectron()
        ? t('providers.qwen_livetranslate.voiceDesktopOnly', 'Recording and enrollment are available in AED Translator on Windows.')
        : t('providers.qwen_livetranslate.voiceBailianOnly', 'Fixed voice recording and enrollment require a Bailian (Beijing) API key. Choose Bailian shared and save its API key. QwenCloud and managed connections do not expose this enrollment API.');

  return (
    <div className="settings-section voice-settings-section" id="voice-settings-section">
      <h2>{t('settings.voiceSettings', 'Voice Settings')}</h2>
      {loadError && canManage && <div role="status" className="voice-library-info">
        {t('providers.qwen_livetranslate.voiceListError', 'Could not load your Qwen voices. ')}
        <button type="button" className="inline-action-button" onClick={() => void refresh()}>{t('common.retry', 'Retry')}</button>
      </div>}
      <VoiceLibrarySection
        label={participantSpeaks ? t('settings.voiceTheyHear', 'Voice the other side hears') : undefined}
        voices={voices}
        selectedId={settings.voice}
        onSelect={(voice) => { void chooseVoice(voice); }}
        onDelete={onDelete}
        onRefresh={canManage ? () => void refresh() : undefined}
        refreshing={loading}
        onRecord={canManage ? onRecord : undefined}
        useMeetingMicrophone={canManage}
        recordingPrompt={canManage ? {
          title: t('providers.qwen_livetranslate.voiceReadAloudTitle', 'Read this aloud at your usual speaking pace'),
          text: t('providers.qwen_livetranslate.voiceReadAloudSample', 'Let’s review the project schedule. The first samples should arrive on Wednesday. Please check the quantities and specifications when they arrive, and send me a photo if anything looks wrong.'),
        } : undefined}
        capability={{ importModes: canManage ? ['record'] : [], maxClipSeconds: 20, minClipSeconds: 10, multipleImport: false }}
        manageNote={manageNote}
        createReview={pending ? {
          seq: pendingSeq,
          audioBlob: pending,
          error: modalError,
          busy: modalBusy,
          explicitClose: true,
          notice: t('providers.qwen_livetranslate.voiceConsent', 'After you confirm, AED Translator uses Alibaba temporary private storage by default. The optional HTTPS URL is sent to Alibaba as the reference source. Cloned voices remain in your account until deleted.'),
          referenceUrl: {
            value: referenceUrl,
            onChange: setReferenceUrl,
            label: t('providers.qwen_livetranslate.voiceReferenceUrlLabel', 'Optional public HTTPS audio URL (fallback)'),
            placeholder: t('providers.qwen_livetranslate.voiceReferenceUrlPlaceholder', 'https://your-public-host.example/voice.wav'),
          },
          onConfirm: (name, url) => { void confirm(name, url); },
          onClose: closeReview,
        } : null}
        isSessionActive={disabled}
      />
      {participantSpeaks && <VoiceLibrarySection
        label={t('settings.voiceIHear', 'Voice I hear')}
        voices={participantVoices}
        selectedId={settings.participantVoice}
        onSelect={(voice) => update({ participantVoice: voice })}
        onDelete={async () => {}}
        capability={{ importModes: [] }}
        isSessionActive={disabled}
        note={participantId !== settings.participantVoice
          ? t('settings.voiceIHearSame', 'Same as the voice the other side hears, so {{voice}} reads instead.', { voice: QWEN_VOICES.find((v) => v.value === participantId)?.name ?? participantId })
          : undefined}
      />}
    </div>
  );
}
