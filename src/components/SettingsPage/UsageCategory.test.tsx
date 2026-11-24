// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsageCategory } from './UsageCategory';
import { billingMonth, recordUsage, useUsageStore } from '../../lib/usage/ledger';
import { LIVE_TRANSLATE_MODEL } from '../../lib/usage/providerUsage';

afterEach(() => {
  cleanup();
  useUsageStore.setState({ rows: [], quotas: {} });
  localStorage.removeItem('aed.tokenUsage.v2');
});

it('saves a Bailian quota and shows the projected remainder after further usage', () => {
  const row = { activity: 'meeting' as const, provider: 'bailian-beijing', model: LIVE_TRANSLATE_MODEL, inputTokens: 100, outputTokens: 20, billableTokens: 120 };
  recordUsage(row);
  expect(useUsageStore.getState().rows[0].month).toBe(billingMonth());
  render(<UsageCategory locked={false} />);
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update quota' }));
  expect(screen.getByText(/Estimated remaining · 1,000 Token/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update quota' }));
  expect(screen.getByText(/Estimated remaining · 0 Token/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /import/i })).toBeNull();
});
