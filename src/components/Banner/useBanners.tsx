// src/components/Banner/useBanners.tsx
import { useState } from 'react';
import { useOutputFormFactor } from '../../lib/audio/formFactor';
import { RefreshCw, TriangleAlert, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useAudioSystemDismiss, useAudioSystemDismissed, useAudioSystemReason, useAudioSystemRepair, useAudioSystemRepairFailed,
  useAudioSystemRepairing, useAudioSystemRetry, useAudioSystemRetrying, useAudioSystemStatus,
} from '../../stores/audioSystemStore';
import { useRegionHint } from '../Region/useRegionHint';
import { Banner, type BannerProps } from './Banner';

/**
 * The app-level banners to draw, in order: audio system (attention), then the
 * region hint (brand, spec 2026-11-14 §B5).
 */
export function useBanners(): BannerProps[] {
  const { t } = useTranslation();
  const dismissLabel = t('common.dismiss', 'Dismiss');
  const banners: BannerProps[] = [];

  const audioStatus = useAudioSystemStatus();
  const reason = useAudioSystemReason();
  const audioDismissed = useAudioSystemDismissed();
  const retrying = useAudioSystemRetrying();
  const retry = useAudioSystemRetry();
  const repairing = useAudioSystemRepairing();
  const repairFailed = useAudioSystemRepairFailed();
  const repair = useAudioSystemRepair();
  const dismissAudio = useAudioSystemDismiss();
  if (audioStatus === 'unavailable' && !audioDismissed) {
    const pactlMissing = reason === 'pactl-missing';
    // macOS: the driver is installed but was never loaded; the fix is a re-sign behind macOS's administrator prompt, not another retry.
    const macDriver = reason === 'mac-driver-not-loaded';
    let body = t('audioSystem.unavailableBody');
    if (pactlMissing) body = t('audioSystem.pactlMissingBody');
    if (macDriver) body = repairFailed ? t('audioSystem.macRepairFailedBody') : t('audioSystem.macDriverNotLoadedBody');
    banners.push({
      id: 'audio-system',
      tone: 'attention',
      icon: <TriangleAlert size={14} aria-hidden="true" />,
      text: <><span>{body}</span>{pactlMissing && <code className="banner__code">{t('audioSystem.installCommand')}</code>}</>,
      action: macDriver
        ? { label: repairing ? t('audioSystem.repairing') : t('audioSystem.repair'), icon: <Wrench size={12} aria-hidden="true" className={repairing ? 'spinning' : ''} />, onClick: () => { void repair(t('audioSystem.macRepairPrompt')); }, busy: repairing }
        : { label: retrying ? t('audioSystem.retrying') : t('audioSystem.retry'), icon: <RefreshCw size={12} aria-hidden="true" className={retrying ? 'spinning' : ''} />, onClick: () => { void retry(); }, busy: retrying },
      onDismiss: dismissAudio,
      dismissLabel,
    });
  }

  const regionHint = useRegionHint();
  if (regionHint) banners.push(regionHint);
  return banners;
}

/** The banners at the top of the panel. */
export function Banners() {
  const banners = useBanners();
  return <>{banners.map((banner) => <Banner key={banner.id} {...banner} />)}</>;
}

export function MeetingHeadphonesNotice({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const output = useOutputFormFactor();
  const [dismissed, setDismissed] = useState(false);
  if (!visible || output.formFactor !== 'speakers' || dismissed) return null;
  return <Banner
    id="meeting-headphones"
    tone="attention"
    icon={<TriangleAlert size={14} aria-hidden="true" />}
    text={t('echoNotice.startupSpeakers', 'Your system output is set to speakers. In online meetings, your microphone may pick up the other person. Use headphones to avoid echo.')}
    onDismiss={() => setDismissed(true)}
    dismissLabel={t('common.dismiss', 'Dismiss')}
  />;
}
