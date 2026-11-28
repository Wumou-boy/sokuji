// "General" as mock v19 draws it (the owner approved it, 2026-11-15): two groups of plain rows — the name and a line
// about it on the left, a real control on the right — and the support address and the discussion board last.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../../services/ServiceFactory', () => ({
  ServiceFactory: { getSettingsService: () => ({ getSetting: async (_k: string, d: unknown) => d, setSetting: async () => ({ success: true }) }) },
}));
const tour = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../Tour/useStartBasicsTour', () => ({ useStartBasicsTour: () => tour.start }));
const help = vi.hoisted(() => ({ change: vi.fn(), open: vi.fn() }));
vi.mock('../Settings/sections/helpActions', () => ({
  useInterfaceLanguageChange: () => help.change,
  openExternalUrl: help.open,
}));


import { GeneralCategory } from './GeneralCategory';
import { useLayoutStore } from '../../stores/layoutStore';
import useSettingsStore from '../../stores/settingsStore';

beforeEach(() => {
  for (const f of [tour.start, help.change, help.open]) f.mockClear();
  useLayoutStore.setState({ setupWizardOpen: false });
  useSettingsStore.setState({ theme: 'system', diagnosticLogs: false, localSpeakerRecognition: false } as never);
});
afterEach(() => cleanup());

const row = (name: string) => screen.getByText(name, { selector: '.general-row__name' }).closest('.general-row') as HTMLElement;

describe('general', () => {
  it('has two groups: the basics, then maintenance and help', () => {
    render(<GeneralCategory locked={false} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Basics', 'Maintenance and help']);
  });

  it('picks the interface language from a select on its row', () => {
    render(<GeneralCategory locked={false} />);
    fireEvent.change(within(row('Interface Language')).getByRole('combobox'), { target: { value: 'ja' } });
    expect(help.change).toHaveBeenCalledWith('ja');
  });

  it('picks the appearance from three side-by-side choices', () => {
    render(<GeneralCategory locked={false} />);
    const choices = within(row('Appearance')).getAllByRole('button');
    expect(choices.map((b) => b.textContent)).toEqual(['System', 'Dark', 'Light']);
    expect(choices[0]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(choices[1]);
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('offers the shared local speaker preference in Basics and locks it during a session', () => {
    render(<GeneralCategory locked={false} />);
    const recognitionRow = row('Local speaker recognition');
    expect(within(recognitionRow).getByText(/online meetings or Face to Face/)).toBeInTheDocument();
    const toggle = within(recognitionRow).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().localSpeakerRecognition).toBe(true);

    cleanup();
    render(<GeneralCategory locked />);
    expect(within(row('Local speaker recognition')).getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
  });

  it('turns the diagnostic logs on with a switch, saying what they are under the name', () => {
    render(<GeneralCategory locked={false} />);
    expect(within(row('Diagnostic logs')).getByText(/attach it to a bug report/)).toBeInTheDocument();
    fireEvent.click(within(row('Diagnostic logs')).getByRole('switch'));
    expect(useSettingsStore.getState().diagnosticLogs).toBe(true);
  });

  it('runs the setup wizard again, but not during a session', () => {
    const first = render(<GeneralCategory locked={false} />);
    fireEvent.click(within(row('Setup wizard')).getByRole('button'));
    expect(useLayoutStore.getState().setupWizardOpen).toBe(true);
    first.unmount();
    render(<GeneralCategory locked />);
    expect(within(row('Setup wizard')).getByRole('button')).toBeDisabled();
  });

  it('starts the guide again', () => {
    render(<GeneralCategory locked={false} />);
    fireEvent.click(within(row('Guide')).getByRole('button'));
    expect(tour.start).toHaveBeenCalled();
  });

  it('ends with the support address and the discussion board, as two quiet links', () => {
    render(<GeneralCategory locked={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'support@kizuna.ai' }));
    expect(help.open).toHaveBeenCalledWith('mailto:support@kizuna.ai');
    fireEvent.click(screen.getByRole('button', { name: 'Discussions' }));
    expect(help.open).toHaveBeenCalledWith('https://github.com/kizuna-ai-lab/sokuji/discussions');
  });
});
