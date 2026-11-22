import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { resolve } from 'node:path';
import { compile } from 'sass';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../components/Tooltip/Tooltip', () => ({ default: () => null }));

import { TranslateSettingsView } from './TranslateSettings';
import { TRANSLATE_DEFAULTS } from './settings';

describe("OpenAI Translate's settings view", () => {
  it("draws the old info banner first, byte for byte its markup (`ProviderSpecificSettings.tsx:2173-2183`)", () => {
    const { container } = render(<TranslateSettingsView settings={TRANSLATE_DEFAULTS} update={vi.fn()} />);
    const banner = container.firstElementChild!;
    expect(banner.className).toBe('settings-section translate-info-banner');
    const inner = banner.firstElementChild!;
    expect(inner.className).toBe('info-banner');
    expect(inner.querySelector('svg')).not.toBeNull();
    expect(inner.querySelector('span')?.textContent).toBe('settings.translateInfoBanner');
  });

  it('updates noise reduction and automatic caption labels through their own controls', () => {
    const update = vi.fn();
    const { container } = render(<TranslateSettingsView settings={TRANSLATE_DEFAULTS} update={update} />);
    const select = screen.getByLabelText('settings.noiseReduction') as HTMLSelectElement;
    expect(select.value).toBe('None');
    expect([...select.options].map((o) => o.value)).toEqual(['None', 'Near field', 'Far field']);
    fireEvent.change(select, { target: { value: 'Near field' } });
    expect(update).toHaveBeenCalledWith({ noiseReduction: 'Near field' });
    expect(container.querySelectorAll('select')).toHaveLength(1);
    const detection = screen.getByRole('switch', { name: 'settings.translateDetectParticipantLanguage' });
    expect(detection).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(detection);
    expect(update).toHaveBeenCalledWith({ detectParticipantLanguage: false });
    expect(container.textContent).not.toMatch(/transport|webrtc|model/i);
  });

  it('locks the noise reduction while disabled', () => {
    render(<TranslateSettingsView settings={TRANSLATE_DEFAULTS} update={vi.fn()} disabled />);
    expect(screen.getByLabelText('settings.noiseReduction')).toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps the banner styled: its rules are in the compiled Settings.scss', () => {
    const { css } = compile(resolve(__dirname, '../../components/Settings/Settings.scss'));
    expect(css).toMatch(/\.settings-section\.translate-info-banner \.info-banner \{[^}]*display: flex;/);
  });
});
