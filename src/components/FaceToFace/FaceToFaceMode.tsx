import { useEffect, useRef, type CSSProperties } from 'react';
import { User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FollowDock } from '../Conversation/FollowDock';
import { useFollowLatest } from '../Conversation/useFollowLatest';
import { languageLabel } from '../../lib/language/label';
import { normalizeFaceToFaceLanguage } from '../../lib/faceToFace/route';
import { personShade } from '../../lib/view/people';
import { useConversationDisplayFontSize } from '../../stores/conversationDisplayStore';
import type { FaceToFaceLanguage } from '../../stores/faceToFaceStore';
import { useFaceToFaceStore } from '../../stores/faceToFaceStore';
import { useSessionTokenStore } from '../../lib/usage/sessionTokens';
import { SessionTokenMeter } from '../MainPanel/SessionTokenMeter';
import { startFaceToFaceRuntime, stopFaceToFaceRuntime } from '../../lib/faceToFace/runtime';
import '../MainPanel/ConversationRow.scss';
import './FaceToFaceMode.scss';

interface Props { onExit(): void }
const LANGUAGE_OPTIONS: FaceToFaceLanguage[] = ['zh', 'ja', 'en'];
const LANGUAGE_SLOTS = ['first', 'second'] as const;

export default function FaceToFaceMode({ onExit }: Props) {
  const { t, i18n } = useTranslation();
  const phase = useFaceToFaceStore((s) => s.phase);
  const error = useFaceToFaceStore((s) => s.error);
  const languages = useFaceToFaceStore((s) => s.languages);
  const captions = useFaceToFaceStore((s) => s.captions);
  const sessionTokens = useSessionTokenStore((s) => s['face-to-face']);
  const setLanguage = useFaceToFaceStore((s) => s.setLanguage);
  const fontSize = useConversationDisplayFontSize();
  const captionList = useRef<HTMLElement>(null);
  const { docked, resume } = useFollowLatest(captionList, captions, captions.length === 0);
  const busy = phase === 'starting' || phase === 'live' || phase === 'stopping';
  useEffect(() => () => { void stopFaceToFaceRuntime(); }, []);

  const startOrStop = () => {
    if (busy) {
      void stopFaceToFaceRuntime();
      return;
    }
    void startFaceToFaceRuntime().catch(() => {});
  };

  return (
    <main className="face-to-face-mode">
      <header className="face-to-face-mode__header">
        <h1>{t('faceToFace.title', 'Face to Face')}</h1>
        <button type="button" className="face-to-face-mode__exit" onClick={onExit}>{t('faceToFace.backToMeeting', 'Online meeting')}</button>
      </header>

      <div className="face-to-face-mode__toolbar">
        <section className="face-to-face-mode__setup" aria-label={t('faceToFace.languageChoices', 'Subtitle languages')}>
          {LANGUAGE_SLOTS.map((slot, index) => (
            <label className="face-to-face-mode__language" key={slot}>
              <span>{index === 0 ? t('faceToFace.firstLanguage', 'First language') : t('faceToFace.secondLanguage', 'Second language')}</span>
              <select value={languages[slot]} disabled={busy} onChange={(event) => setLanguage(slot, event.target.value as FaceToFaceLanguage)}>
                {LANGUAGE_OPTIONS.map((value) => <option key={value} value={value}>{languageLabel(value, i18n.language)}</option>)}
              </select>
            </label>
          ))}
        </section>
        <button type="button" className="face-to-face-mode__start" disabled={phase === 'stopping'} onClick={startOrStop}>
          {phase === 'stopping' ? t('faceToFace.stopping', 'Stopping…') : phase === 'starting' || phase === 'live' ? t('faceToFace.stop', 'Stop listening') : phase === 'error' ? t('faceToFace.retry', 'Retry') : t('faceToFace.start', 'Start listening')}
        </button>
        <SessionTokenMeter session={sessionTokens} />
      </div>

      {phase !== 'idle' && (
        <div className={`face-to-face-mode__status face-to-face-mode__status--${phase}`} role="status" aria-live="polite">
          {phase === 'starting' && t('faceToFace.starting', 'Connecting and opening the microphone…')}
          {phase === 'live' && t('faceToFace.transcribing', 'Listening…')}
          {phase === 'stopping' && t('faceToFace.stopping', 'Stopping and releasing the microphone…')}
          {phase === 'error' && (error ?? t('faceToFace.failed', 'Could not start Face to Face.'))}
        </div>
      )}

      <section ref={captionList} className="face-to-face-mode__captions conversation-list" aria-label={t('faceToFace.captions', 'Conversation subtitles')} tabIndex={0} style={{ '--conversation-font-size': `${fontSize}px` } as CSSProperties}>
        {captions.length === 0 ? (
          <p className="face-to-face-mode__empty">{phase === 'live' ? t('faceToFace.waitingLive', 'Listening for speech…') : t('faceToFace.waiting', 'Start listening. Your subtitles will appear here.')}</p>
        ) : captions.map((row, index) => {
          const sourceCode = normalizeFaceToFaceLanguage(row.sourceLanguage);
          const originalInPair = sourceCode === languages.first || sourceCode === languages.second;
          const needsOriginal = row.source && !originalInPair && !row.subtitles[languages.first] && !row.subtitles[languages.second];
          const speaker = row.speakerNumber ? t('faceToFace.speakerNumber', 'Speaker {{number}}', { number: row.speakerNumber }) : t('faceToFace.speaker', 'Speaker');
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
              {needsOriginal && (
                <div className="row-body face-to-face-mode__line">
                  <span className="lang-badge src" title={sourceCode ? languageLabel(sourceCode, i18n.language) : undefined}>{sourceCode?.toUpperCase() ?? t('viewer.original', 'Original')}</span>
                  <p className="row-text src" lang={sourceCode ?? undefined}>{row.source}</p>
                </div>
              )}
              {LANGUAGE_SLOTS.map((slot) => {
                const language = languages[slot];
                const isOriginal = sourceCode === language;
                const text = row.subtitles[language] ?? (isOriginal ? row.source : undefined);
                const tone = isOriginal ? 'src' : 'tr';
                return (
                  <div className="row-body face-to-face-mode__line" key={slot}>
                    <span className={`lang-badge ${tone} source-${leg}`} title={languageLabel(language, i18n.language)}>{language.toUpperCase()}</span>
                    {text
                      ? <p className={`row-text ${tone}`} lang={language}>{text}</p>
                      : <p className="row-text face-to-face-mode__pending">{row.translationError && row.final ? t('faceToFace.translationUnavailable', 'Translation unavailable') : t('faceToFace.translationPending', 'Translating…')}</p>}
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
