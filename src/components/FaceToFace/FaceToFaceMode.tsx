import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FollowDock } from '../Conversation/FollowDock';
import { useFollowLatest } from '../Conversation/useFollowLatest';
import { languageLabel } from '../../lib/language/label';
import { faceToFaceLanguageOptions, faceToFaceProviderFor, faceToFaceSourceTarget, faceToFaceTargets, normalizeFaceToFaceLanguage, resolveFaceToFaceLanguages } from '../../lib/faceToFace/route';
import { personShade } from '../../lib/view/people';
import { useConversationDisplayFontSize } from '../../stores/conversationDisplayStore';
import { ensureFaceToFaceSettings, useFaceToFaceStore, type FaceToFaceLanguage } from '../../stores/faceToFaceStore';
import { useSessionTokenStore } from '../../lib/usage/sessionTokens';
import { useLineUpStore } from '../../stores/lineUpStore';
import useAudioStore from '../../stores/audioStore';
import { useNavigateToSettings } from '../../stores/settingsStore';
import { SessionTokenMeter } from '../MainPanel/SessionTokenMeter';
import { readFaceToFaceInputPeak, startFaceToFaceRuntime, stopFaceToFaceRuntime } from '../../lib/faceToFace/runtime';
import { isElectron } from '../../utils/environment';
import '../MainPanel/ConversationRow.scss';
import './FaceToFaceMode.scss';

const LANGUAGE_SLOTS = ['first', 'second'] as const;

/** Polls inside this small child so each audio sample never rerenders the transcript. */
function FaceToFaceMicrophoneMeter({ live }: { live: boolean }) {
  const { t } = useTranslation();
  const [peak, setPeak] = useState(0);

  useEffect(() => {
    if (!live) {
      setPeak(0);
      return;
    }
    const update = () => {
      const value = readFaceToFaceInputPeak();
      setPeak(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [live]);

  const db = peak > 0 ? Math.round(20 * Math.log10(peak)) : -Infinity;
  const dbText = `${Number.isFinite(db) ? db : '−∞'} dBFS`;
  const fill = peak > 0 ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
  const label = t('voiceLibrary.microphoneLevel', 'Microphone input level');
  return (
    <div
      className="face-to-face-mode__mic-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(peak * 100)}
      aria-valuetext={dbText}
      title={`${label}: ${dbText}`}
    >
      <span className="face-to-face-mode__mic-meter-label" aria-hidden="true">{t('faceToFace.microphone', 'Microphone')}</span>
      <span className="face-to-face-mode__mic-meter-track" aria-hidden="true">
        <span className="face-to-face-mode__mic-meter-fill" style={{ width: `${fill}%` }} />
      </span>
      <span className="face-to-face-mode__mic-meter-db" aria-hidden="true">{dbText}</span>
    </div>
  );
}

export default function FaceToFaceMode() {
  const { t, i18n } = useTranslation();
  const phase = useFaceToFaceStore((s) => s.phase);
  const error = useFaceToFaceStore((s) => s.error);
  // Shared setting failures are displayed from their current values below.
  const settingsError = useFaceToFaceStore((s) => s.settingsError);
  const languages = useFaceToFaceStore((s) => s.languages);
  const runLanguages = useFaceToFaceStore((s) => s.runLanguages);
  const localSpeakerStatus = useFaceToFaceStore((s) => s.localSpeakerStatus);
  const historyStatus = useFaceToFaceStore((s) => s.historyStatus);
  const recordingFailed = useFaceToFaceStore((s) => s.recordingFailed);
  const setThirdLanguage = useFaceToFaceStore((s) => s.setThirdLanguage);
  const captions = useFaceToFaceStore((s) => s.captions);
  const sessionTokens = useSessionTokenStore((s) => s['face-to-face']);
  const setLanguage = useFaceToFaceStore((s) => s.setLanguage);
  const lineUp = useLineUpStore((s) => s.lineUp);
  const provider = faceToFaceProviderFor(lineUp?.translation);
  const translation = lineUp?.translation;
  const languageOptions = useMemo(() => faceToFaceLanguageOptions(translation), [translation]);
  const effectiveLanguages = useMemo(
    () => resolveFaceToFaceLanguages(translation, languages) ?? languages,
    [translation, languages],
  );
  const devicesReady = useAudioStore((s) => s.devicesLoaded);
  const micAvailable = useAudioStore((s) => !s.isMicMuted && s.audioInputDevices.some(
    device => device.deviceId === s.selectedInputDevice?.deviceId && !s.unusableInputIds.includes(device.deviceId),
  ));
  const navigateToSettings = useNavigateToSettings();
  const fontSize = useConversationDisplayFontSize();
  // A run keeps the exact targets it started with, even if line-up settings change later.
  const captionLanguages = runLanguages ?? effectiveLanguages;
  const editableLanguages = effectiveLanguages;
  const targets = useMemo(() => faceToFaceTargets(captionLanguages), [captionLanguages]);
  const captionList = useRef<HTMLElement>(null);
  const { docked, resume } = useFollowLatest(captionList, captions, captions.length === 0);
  const busy = phase === 'starting' || phase === 'live' || phase === 'stopping';
  useEffect(() => {
    void ensureFaceToFaceSettings();
    return () => { void stopFaceToFaceRuntime(); };
  }, []);

  const startOrStop = () => {
    if (busy) {
      void stopFaceToFaceRuntime({ normalEnd: true });
      return;
    }
    void startFaceToFaceRuntime().catch(() => {});
  };

  return (
    <main className="face-to-face-mode" aria-label={t('faceToFace.title', 'Face to Face')}>
      <div className="face-to-face-mode__toolbar">
        <section className="face-to-face-mode__setup" aria-label={t('faceToFace.languageChoices', 'Subtitle languages')}>
          {LANGUAGE_SLOTS.map((slot, index) => (
            <label className="face-to-face-mode__language" key={slot}>
              <span>{index === 0 ? t('faceToFace.firstLanguage', 'First language') : t('faceToFace.secondLanguage', 'Second language')}</span>
              <select value={editableLanguages[slot]} disabled={busy || languageOptions.length < 2} onChange={(event) => setLanguage(slot, event.target.value as FaceToFaceLanguage, editableLanguages)}>
                {languageOptions.map((value) => <option key={value} value={value}>{languageLabel(value, i18n.language)}</option>)}
              </select>
            </label>
          ))}
          <label className="face-to-face-mode__language">
            <span>{t('faceToFace.thirdLanguage', 'Third subtitle language')}</span>
            <select value={(busy ? captionLanguages : editableLanguages).third ?? ''} disabled={busy || languageOptions.length < 2} onChange={(event) => setThirdLanguage((event.target.value || null) as FaceToFaceLanguage | null, editableLanguages)}>
              <option value="">{t('common.off', 'Off')}</option>
              {languageOptions.filter((value) => value !== (busy ? captionLanguages : editableLanguages).first && value !== (busy ? captionLanguages : editableLanguages).second).map((value) => <option key={value} value={value}>{languageLabel(value, i18n.language)}</option>)}
            </select>
          </label>
          {localSpeakerStatus === 'loading' && <p className="face-to-face-mode__speaker-status" role="status">{t('faceToFace.speakerModelLoading', 'Loading local speaker recognition…')}</p>}
          {localSpeakerStatus === 'unavailable' && <p className="face-to-face-mode__speaker-status" role="status">{t('faceToFace.speakerRecognitionUnavailable', 'Local speaker recognition unavailable for this session.')}</p>}
        </section>
        <button type="button" className="face-to-face-mode__start" disabled={phase === 'stopping' || (!busy && (!provider || !devicesReady || !micAvailable))} onClick={startOrStop}>
          {phase === 'stopping' ? t('faceToFace.stopping', 'Stopping…') : phase === 'starting' || phase === 'live' ? t('faceToFace.stop', 'Stop listening') : phase === 'error' && !settingsError ? t('faceToFace.retry', 'Retry') : t('faceToFace.start', 'Start listening')}
        </button>
        <FaceToFaceMicrophoneMeter live={phase === 'live'} />
        <SessionTokenMeter session={sessionTokens} />
      </div>

      {lineUp && !provider && !busy && (
        <div className="face-to-face-mode__status" role="status">
          {t('faceToFace.sharedServiceUnsupported', 'Choose Qwen LiveTranslate or OpenAI Realtime Translate in Settings to use face-to-face subtitles.')}
          {' '}<button type="button" className="face-to-face-mode__settings-link" onClick={() => navigateToSettings('lineup')}>
            {t('faceToFace.openTranslationSettings', 'Translation settings')}
          </button>
        </div>
      )}
      {provider && devicesReady && !micAvailable && !busy && (
        <div className="face-to-face-mode__status" role="status">
          {t('faceToFace.sharedMicrophoneOff', 'Select an active microphone in Audio settings to start listening.')}
          {' '}<button type="button" className="face-to-face-mode__settings-link" onClick={() => navigateToSettings('microphone')}>
            {t('faceToFace.openMicrophoneSettings', 'Microphone settings')}
          </button>
        </div>
      )}
      {phase !== 'idle' && !(phase === 'error' && settingsError) && (
        <div className={`face-to-face-mode__status face-to-face-mode__status--${phase}`} role="status" aria-live="polite">
          {phase === 'starting' && t('faceToFace.starting', 'Connecting and opening the microphone…')}
          {phase === 'live' && t('faceToFace.transcribing', 'Listening…')}
          {phase === 'stopping' && t('faceToFace.stopping', 'Stopping and releasing the microphone…')}
          {phase === 'error' && (error ?? t('faceToFace.failed', 'Could not start Face to Face.'))}
        </div>
      )}

      {(historyStatus === 'partial' || historyStatus === 'disabled') && (
        <p className={`face-to-face-mode__history-status face-to-face-mode__history-status--${historyStatus}`} role="status">
          {historyStatus === 'partial' && t('faceToFace.historyPartial', 'Some captions could not be saved. The live subtitles are still available until this session ends.')}
          {historyStatus === 'disabled' && t('faceToFace.historyNotKept', 'No captions or recording to save.')}
        </p>
      )}
      {recordingFailed && <p className="face-to-face-mode__history-status face-to-face-mode__history-status--partial" role="status">
        {t('faceToFace.recordingFailed', 'The microphone recording could not be saved in full.')}
      </p>}

      <section ref={captionList} className="face-to-face-mode__captions conversation-list" aria-label={t('faceToFace.captions', 'Conversation subtitles')} tabIndex={0} style={{ '--conversation-font-size': `${fontSize}px` } as CSSProperties}>
        {captions.length === 0 ? (
          <p className="face-to-face-mode__empty">{phase === 'live' ? t('faceToFace.waitingLive', 'Listening for speech…')
            : isElectron() ? t('faceToFace.recordingNotice', 'When you start listening, the microphone recording and subtitles are saved in History on this computer.')
            : t('faceToFace.waiting', 'Start listening. Your subtitles will appear here.')}</p>
        ) : captions.map((row, index) => {
          const sourceCode = normalizeFaceToFaceLanguage(row.sourceLanguage);
          const sourceTarget = faceToFaceSourceTarget(row.sourceLanguage, targets);
          const showOriginal = row.source && !sourceTarget;
          const order = captionLanguages.third && sourceTarget
            ? [sourceTarget, ...targets.filter((target) => target !== sourceTarget)] : targets;
          const speaker = row.speakerNumber ? t('faceToFace.speakerNumber', 'Speaker {{number}}', { number: row.speakerNumber }) : t('faceToFace.speakerUnknown', 'Speaker not identified');
          const showSpeaker = index === 0 || captions[index - 1].speakerNumber !== row.speakerNumber;
          const leg = row.speakerNumber === 1 ? 'speaker' : 'participant';
          const shade = row.speakerNumber ? ` person-shade-${personShade(row.speakerNumber)}` : '';
          return (
            <article className={`face-to-face-mode__caption conversation-row source-${leg} expanded ${showSpeaker ? 'with-header' : 'grouped'}`} key={row.id} aria-label={showSpeaker ? undefined : speaker}>
              {showSpeaker && (
                <header className="row-header">
                  <span className={`row-avatar avatar-${leg}${shade}`} aria-hidden="true">
                    {row.speakerNumber ? <span className="row-avatar__number">{row.speakerNumber}</span> : <User size={12} />}
                  </span>
                  <span className="row-name"><span className="row-name-text">{speaker}</span></span>
                </header>
              )}
              {showOriginal && (
                <div className="row-body face-to-face-mode__line">
                  <span className="lang-badge src" title={sourceCode ? languageLabel(sourceCode, i18n.language) : undefined}>{sourceCode?.toUpperCase() ?? t('viewer.original', 'Original')}</span>
                  <p className="row-text src" lang={sourceCode ?? undefined}>{row.source}</p>
                </div>
              )}
              {order.map((language) => {
                const isOriginal = sourceTarget === language;
                const text = row.subtitles[language] ?? (isOriginal ? row.source : undefined);
                const tone = isOriginal ? 'src' : 'tr';
                return (
                  <div className="row-body face-to-face-mode__line" key={language}>
                    <span className={`lang-badge ${tone} source-${leg}`} title={languageLabel(language, i18n.language)}>{language.toUpperCase()}</span>
                    {text
                      ? <p className={`row-text ${tone}`} lang={language}>{text}</p>
                      : <p className="row-text face-to-face-mode__pending">{row.translationErrors?.[language] && row.final ? t('faceToFace.translationUnavailable', 'Translation unavailable') : t('faceToFace.translationPending', 'Translating…')}</p>}
                  </div>
                );
              })}
              {row.translationError && <p className="face-to-face-mode__row-error">{row.translationError}</p>}
            </article>
          );
        })}
      </section>
      {docked && <FollowDock onClick={resume} />}
    </main>
  );
}
