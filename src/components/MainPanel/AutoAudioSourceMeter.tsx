import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './AutoAudioSourceMeter.scss';

export type AutoAudioSourceStatus =
  | { state: 'ready' }
  | { state: 'waiting' }
  | { state: 'capturing'; appName: string; readPeak: () => number };

interface Props {
  source: AutoAudioSourceStatus;
}

/** Compact indication of Auto's selected meeting app and its live PCM level. */
export function AutoAudioSourceMeter({ source }: Props) {
  const { t } = useTranslation();
  const [db, setDb] = useState(-Infinity);
  const readPeak = source.state === 'capturing' ? source.readPeak : null;

  useEffect(() => {
    if (!readPeak) {
      setDb(-Infinity);
      return;
    }
    const update = () => {
      const peak = readPeak();
      setDb(Number.isFinite(peak) && peak > 0 ? Math.round(20 * Math.log10(Math.min(1, peak))) : -Infinity);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [readPeak]);

  if (source.state === 'ready') {
    return <span className="auto-audio-source-meter auto-audio-source-meter--ready">{t('mainPanel.autoAudioReady', 'Auto audio')}</span>;
  }
  if (source.state === 'waiting') {
    return <span className="auto-audio-source-meter auto-audio-source-meter--waiting">{t('mainPanel.autoAudioWaiting', 'Auto · waiting')}</span>;
  }

  const dbText = `${Number.isFinite(db) ? db : '−∞'} dBFS`;
  const fill = Math.max(0, (db + 60) / 60) * 100;
  const label = t('mainPanel.autoAudioCapturing', 'Auto audio from {{app}} · {{db}}', { app: source.appName, db: dbText });
  return (
    <span className="auto-audio-source-meter auto-audio-source-meter--capturing" role="group" aria-label={label} title={label}>
      <span className="auto-audio-source-meter__app" title={source.appName}>{source.appName}</span>
      <span className="auto-audio-source-meter__bar" aria-hidden="true">
        <span className="auto-audio-source-meter__fill" style={{ width: `${fill}%` }} />
      </span>
      <span className="auto-audio-source-meter__db" aria-hidden="true">{dbText}</span>
    </span>
  );
}
