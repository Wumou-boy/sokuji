import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '../../locales';
import { AccountsCategory } from './AccountsCategory';
import { useProviderStore } from '../../stores/providerStore';

vi.mock('../../providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/registry')>();
  return { ...actual, presentProviders: () => actual.RELEASED };
});
vi.mock('../providers/useAuthContext', () => ({ useAuthContext: () => ({ signedIn: false, getToken: async () => null }) }));
vi.mock('../../lib/analytics', () => ({ useAnalytics: () => ({ trackEvent: vi.fn() }) }));

const qwen = () => screen.getByRole('group', { name: 'Qwen LiveTranslate' });
const compatible = () => screen.getByRole('group', { name: 'OpenAI-Compatible Service' });

beforeEach(() => {
  useProviderStore.setState({
    readiness: {},
    entries: {
      qwen_livetranslate: { settings: { connection: 'bailian', region: 'cn' }, credentials: { apiKey: 'test-qwen' }, pair: { source: 'ja', target: 'en' } },
      openai_compatible: { settings: {}, credentials: { baseUrl: 'https://models.example.internal/v1', apiKey: '' } },
      openai: { settings: {}, credentials: { apiKey: 'test-previously-saved' } },
    } as never,
  });
});
afterEach(cleanup);

describe('company accounts and keys', () => {
  it('shows only the approved setup rows and preserves previously saved credentials', () => {
    render(<AccountsCategory locked={false} />);
    expect(screen.getAllByRole('group')).toEqual([qwen(), screen.getByRole('group', { name: 'OpenAI' }), compatible()]);
    expect(useProviderStore.getState().entries.openai?.credentials.apiKey).toBe('test-previously-saved');
  });

  it.each([
    [{ state: 'ready', models: [] }, 'Key saved'],
    [{ state: 'not-ready', code: 'auth', reason: 'HTTP 401' }, 'Key not accepted'],
    [{ state: 'unknown' }, 'Key not verified'],
  ])('reflects the saved Qwen key readiness %#', (readiness, label) => {
    useProviderStore.setState({ readiness: { qwen_livetranslate: readiness } } as never);
    render(<AccountsCategory locked={false} />);
    expect(qwen()).toHaveTextContent(label);
  });

  it('opens the company endpoint by its settings link with optional key and model discovery', () => {
    render(<AccountsCategory locked={false} openedBy="provider:openai_compatible" />);
    expect(within(compatible()).getByLabelText('Address')).toHaveValue('https://models.example.internal/v1');
    expect(within(compatible()).getByLabelText('API key (optional)')).toHaveValue('');
    expect(within(compatible()).getByRole('button', { name: 'Find models' })).toBeEnabled();
    expect(within(compatible()).getByText(/model name under Languages and line-up/)).toBeInTheDocument();
    expect(within(compatible()).getByText('Availability depends on the endpoint URL.')).toBeInTheDocument();
  });

  it('labels the detected QwenCloud domestic endpoint and the Bailian Beijing endpoint', () => {
    useProviderStore.setState({ models: { qwen_livetranslate: [{ id: 'cn' }] } } as never);
    const view = render(<AccountsCategory locked={false} openedBy="provider:qwen_livetranslate" />);
    expect(within(qwen()).getByText('Available in mainland China')).toBeInTheDocument();
    useProviderStore.setState({ models: { qwen_livetranslate: [] } } as never);
    view.rerender(<AccountsCategory locked={false} openedBy="provider:qwen_livetranslate" />);
    // The saved connection itself explicitly selects Bailian Beijing.
    expect(within(qwen()).getByText('Available in mainland China')).toBeInTheDocument();
  });

  it('lets a user reveal both rows during an active session while locking their credential fields', () => {
    const view = render(<AccountsCategory locked />);
    fireEvent.click(within(qwen()).getByRole('button', { name: 'View' }));
    expect(within(qwen()).getByLabelText('API key')).toBeDisabled();
    fireEvent.click(within(compatible()).getByRole('button', { name: 'View' }));
    expect(within(compatible()).getByLabelText('Address')).toBeDisabled();
    expect(within(compatible()).getByRole('button', { name: 'Find models' })).toBeDisabled();

    view.rerender(<AccountsCategory locked={false} />);
    expect(within(compatible()).getByLabelText('Address')).toBeEnabled();
    fireEvent.click(within(qwen()).getByRole('button', { name: 'View' }));
    expect(within(qwen()).getByLabelText('API key')).toHaveValue('test-qwen');
  });
});
