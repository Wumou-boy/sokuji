// src/components/SettingsPage/GeneralCategory.tsx
//
// "General" as mock v19 draws it (the owner approved it, 2026-11-15): two groups of plain rows —
// the basics (interface language, appearance), then maintenance and help (diagnostic logs, updates, the setup
// wizard, the guide) — each with its name and a line about it on the left and a real control on the right; the
// support address and the discussion board last, as two quiet links. What each control does is today's help
// section's, through the same helpers.
import { useRef, useState, type ReactNode } from 'react';
import { SPEAKER_MODEL, ModelIntegrityError, verifiedSpeakerModel } from '../../lib/faceToFace/speakerModel';
import { useTranslation } from 'react-i18next';
import { useStartBasicsTour } from '../Tour/useStartBasicsTour';
import { useSetSetupWizardOpen } from '../../stores/layoutStore';
import { useDiagnosticLogs, useSetDiagnosticLogs, useLocalSpeakerRecognition, useSetLocalSpeakerRecognition, useThemeSetting, useSetThemeSetting } from '../../stores/settingsStore';
import { useAnalytics } from '../../lib/analytics';
import type { ThemeSetting } from '../../lib/theme/theme';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import { INTERFACE_LANGUAGES } from '../Settings/sections/interfaceLanguages';
import { openExternalUrl, useInterfaceLanguageChange } from '../Settings/sections/helpActions';
import type { CategoryBodyProps } from './SettingsPage';

// The mock's order: the system's, then dark, then light.
const APPEARANCES: ReadonlyArray<[ThemeSetting, string]> = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];

function Row({ name, line, children }: { name: string; line?: string; children: ReactNode }) {
  return (
    <div className="general-row">
      <div className="general-row__text">
        <span className="general-row__name">{name}</span>
        {line && <small className="general-row__line">{line}</small>}
      </div>
      <div className="general-row__control">{children}</div>
    </div>
  );
}

export function GeneralCategory({ locked }: CategoryBodyProps) {
  const { t, i18n } = useTranslation();
  const { trackEvent } = useAnalytics();
  const changeLanguage = useInterfaceLanguageChange('GeneralCategory');
  const theme = useThemeSetting();
  const setTheme = useSetThemeSetting();
  const logs = useDiagnosticLogs();
  const setLogs = useSetDiagnosticLogs();
  const localSpeakerRecognition = useLocalSpeakerRecognition();
  const setLocalSpeakerRecognition = useSetLocalSpeakerRecognition();
  const speakerFile = useRef<HTMLInputElement>(null);
  const [modelState, setModelState] = useState<'idle' | 'loading' | 'ready' | 'invalid' | 'error'>('idle');
  async function importSpeakerModel(file?: File) {
    if (!file) return;
    setModelState('loading');
    try {
      await verifiedSpeakerModel(file);
      const { storeFile } = await import('../../lib/local-inference/modelStorage');
      await storeFile(SPEAKER_MODEL.id, SPEAKER_MODEL.filename, file);
      setModelState('ready');
    } catch (err) {
      setModelState(err instanceof ModelIntegrityError ? 'invalid' : 'error');
    }
  }
  const speakerRecognitionName = t('settings.localSpeakerRecognition', 'Local speaker recognition');
  const setWizardOpen = useSetSetupWizardOpen();
  const startTour = useStartBasicsTour();
  const logsName = t('settings.diagnosticLogs', 'Diagnostic logs');

  return (
    <div className="general-category" id="help-section">
      <h3 className="settings-subhead">{t('settingsPage.general.basics', 'Basics')}</h3>
      <div className="general-list">
        <Row name={t('simpleConfig.interfaceLanguage', 'Interface Language')}>
          <select className="select-dropdown general-row__select" aria-label={t('simpleConfig.interfaceLanguage', 'Interface Language')}
            value={i18n?.language} disabled={locked} onChange={(e) => changeLanguage(e.target.value)}>
            {INTERFACE_LANGUAGES.map((lang) => <option key={lang.value} value={lang.value}>{lang.label}</option>)}
          </select>
        </Row>
        <Row name={t('settings.appearance', 'Appearance')}>
          <span className="settings-seg" role="group" aria-label={t('settings.appearance', 'Appearance')}>
            {APPEARANCES.map(([mode, fallback]) => (
              <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => {
                if (mode === theme) return;
                void setTheme(mode);
                trackEvent('theme_changed', { from: theme, to: mode });
              }}>
                {t(`settings.appearanceMode.${mode}`, fallback)}
              </button>
            ))}
          </span>
        </Row>
        <Row name={speakerRecognitionName} line={t('settings.localSpeakerRecognitionHint', 'Use local speaker recognition with Qwen automatic turns in online meetings and Face to Face.')}>
          <ToggleSwitch checked={localSpeakerRecognition} onChange={() => void setLocalSpeakerRecognition(!localSpeakerRecognition)} label="" ariaLabel={speakerRecognitionName} disabled={locked} />
        </Row>
        {localSpeakerRecognition && (
          <Row name={t('settings.speakerModelFile', 'Offline speaker model')} line={modelState === 'ready' ? t('settings.speakerModelReady', 'Verified and available on this computer.')
            : modelState === 'invalid' ? t('settings.speakerModelInvalid', 'This file does not match the supported CAM++ model.')
            : modelState === 'error' ? t('settings.speakerModelError', 'Could not read or save the model on this computer.') : SPEAKER_MODEL.filename}>
            <input hidden ref={speakerFile} type="file" accept=".onnx" onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              void importSpeakerModel(file);
            }} />
            <button type="button" className="model-row__btn" disabled={locked || modelState === 'loading'}
              onClick={() => speakerFile.current?.click()}>{t('settings.speakerModelImport', 'Import ONNX file')}</button>
          </Row>
        )}
      </div>

      <h3 className="settings-subhead">{t('settingsPage.general.maintenance', 'Maintenance and help')}</h3>
      <div className="general-list">
        <Row name={logsName} line={t('settings.diagnosticLogsTooltip', 'Record what the app does, so you can attach it to a bug report. Off by default. While on, a “Logs” button appears in the title bar, and the setting stays on after a restart.')}>
          <ToggleSwitch checked={logs} onChange={() => void setLogs(!logs)} label="" ariaLabel={logsName} />
        </Row>
        <Row name={t('settingsPage.general.wizard', 'Setup wizard')} line={t('settingsPage.general.wizardLine', 'Go through the wizard again; what you have saved comes pre-selected.')}>
          <button type="button" className="model-row__btn" disabled={locked} title={locked ? t('settings.sessionActiveNotice') : undefined}
            onClick={() => setWizardOpen(true)}>
            {t('settingsPage.general.rerun', 'Run again')}
          </button>
        </Row>
        <Row name={t('settingsPage.general.guide', 'Guide')} line={t('settingsPage.general.guideLine', 'Step-by-step tips on the main screen.')}>
          <button type="button" className="model-row__btn" onClick={startTour}>{t('settingsPage.general.restart', 'Start again')}</button>
        </Row>
      </div>

      <p className="general-links">
        <span>{t('settingsPage.general.needHelp', 'Need help:')}</span>
        <button type="button" className="models-page__link" onClick={() => openExternalUrl('mailto:support@kizuna.ai')}>support@kizuna.ai</button>
        <button type="button" className="models-page__link" onClick={() => openExternalUrl('https://github.com/kizuna-ai-lab/sokuji/discussions')}>
          {t('settings.helpDiscussions', 'Discussions')}
        </button>
      </p>
    </div>
  );
}
