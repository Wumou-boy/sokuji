import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AutoAudioSourceMeter } from './AutoAudioSourceMeter';

describe('AutoAudioSourceMeter', () => {
  afterEach(() => vi.useRealTimers());

  it('shows ready and search states concisely', () => {
    const { rerender } = render(<AutoAudioSourceMeter source={{ state: 'ready' }} />);
    expect(screen.getByText('Auto audio')).toBeInTheDocument();
    rerender(<AutoAudioSourceMeter source={{ state: 'waiting' }} />);
    expect(screen.getByText('Auto · waiting')).toBeInTheDocument();
  });

  it('polls while capturing, clamps the peak, and renders app and dBFS', () => {
    vi.useFakeTimers();
    let peak = 0.5;
    const readPeak = vi.fn(() => peak);
    render(<AutoAudioSourceMeter source={{ state: 'capturing', appName: 'Meeting App', readPeak }} />);
    expect(screen.getByText('Meeting App')).toBeInTheDocument();
    expect(screen.getByText('-6 dBFS')).toBeInTheDocument();
    peak = 2;
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByText('0 dBFS')).toBeInTheDocument();
    peak = 0;
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByText('−∞ dBFS')).toBeInTheDocument();
    expect(readPeak).toHaveBeenCalledTimes(3);
  });
});
