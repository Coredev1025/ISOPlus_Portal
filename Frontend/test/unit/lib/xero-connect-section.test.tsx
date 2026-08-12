import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('@/lib/toast-utils', () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

import axios from '@/app/utils/axiosConfig';
import { XeroConnectSection } from '@/lib/xero-connect-section';
import { showErrorToast, showSuccessToast } from '@/lib/toast-utils';

describe('XeroConnectSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('removes the window message listener on unmount', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as Window);
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://xero.example/auth' },
    });

    const { unmount } = render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /connect xero/i }));

    await vi.waitFor(() => {
      expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });

    const handleMessage = addSpy.mock.calls.find(
      (call) => call[0] === 'message'
    )?.[1] as EventListener;

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('message', handleMessage);
  });

  it('completes OAuth when the popup posts a successful XERO_AUTH message', async () => {
    const onConnectedChange = vi.fn();
    const popup = { close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://xero.example/auth' },
    });
    (axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={onConnectedChange}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /connect xero/i }));

    await waitFor(() => expect(axios.get).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'XERO_AUTH',
          success: true,
          tokenSet: { access_token: 't' },
          organization: { organisationId: 'org-1' },
          tenants: [{ tenantId: 'tenant-1' }],
        },
      })
    );

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/api/business/xero/connect',
        expect.objectContaining({
          workspaceId: 'ws-1',
          tenantId: 'tenant-1',
        }),
        expect.any(Object)
      );
      expect(onConnectedChange).toHaveBeenCalledWith(true);
      expect(showSuccessToast).toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalled();
    });
  });

  it('disconnects and clears connection state', async () => {
    const onConnectedChange = vi.fn();
    const onConnectionCleared = vi.fn();
    (axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected
        onConnectedChange={onConnectedChange}
        onConnectionCleared={onConnectionCleared}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/api/business/xero/disconnect',
        { workspaceId: 'ws-1' }
      );
      expect(onConnectedChange).toHaveBeenCalledWith(false);
      expect(onConnectionCleared).toHaveBeenCalled();
    });
  });

  it('marks reconnect needed when test connection reports expired auth', async () => {
    const onNeedsReconnectChange = vi.fn();
    (axios.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'token expired' } },
    });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected
        onConnectedChange={vi.fn()}
        onNeedsReconnectChange={onNeedsReconnectChange}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(onNeedsReconnectChange).toHaveBeenCalledWith(true);
      expect(showErrorToast).toHaveBeenCalled();
    });
  });

  it('shows reconnect controls when needsReconnect is true', () => {
    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected
        needsReconnect
        onConnectedChange={vi.fn()}
      />
    );

    expect(screen.getByText(/no organisation is available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconnect xero/i })).toBeInTheDocument();
  });

  it('toasts when redirect URL is missing', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { error: 'no redirect' },
    });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /connect xero/i }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        'Failed to connect to Xero',
        expect.objectContaining({ description: 'no redirect' })
      );
    });
  });

  it('uses organisation id when tenants are absent and reports auth failure', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window);
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://xero.example/auth' },
    });
    (axios.post as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: 'connect failed' } },
    });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /connect xero/i }));
    await waitFor(() => expect(axios.get).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'XERO_AUTH',
          success: true,
          tokenSet: {},
          organization: { organisationId: 'org-9' },
        },
      })
    );

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:3001/api/business/xero/connect',
        expect.objectContaining({ tenantId: 'org-9' }),
        expect.any(Object)
      );
      expect(showErrorToast).toHaveBeenCalled();
    });
  });

  it('toasts unsuccessful OAuth popup messages and missing tenant', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ close: vi.fn() } as unknown as Window);
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://xero.example/auth' },
    });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /connect xero/i }));
    await waitFor(() => expect(axios.get).toHaveBeenCalled());

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'XERO_AUTH', success: false },
      })
    );

    await waitFor(() => expect(showErrorToast).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /connect xero/i }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'XERO_AUTH', success: true, tenants: [], organization: {} },
      })
    );

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        'Failed to connect to Xero',
        expect.objectContaining({
          description: expect.stringMatching(/no xero organisation/i),
        })
      );
    });
  });

  it('shows success for a healthy test connection and toasts disconnect failures', async () => {
    const onNeedsReconnectChange = vi.fn();
    (axios.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: { success: true } })
      .mockRejectedValueOnce(new Error('disconnect failed'));

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected
        onConnectedChange={vi.fn()}
        onNeedsReconnectChange={onNeedsReconnectChange}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        'Connection OK',
        expect.any(Object)
      );
      expect(onNeedsReconnectChange).toHaveBeenCalledWith(false);
    });

    await userEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        'Failed to disconnect from Xero',
        expect.any(Object)
      );
    });
  });
});