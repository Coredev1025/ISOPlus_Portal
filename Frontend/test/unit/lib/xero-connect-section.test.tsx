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

function stubLocationHref() {
  const location = { href: 'http://localhost/' };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: location,
  });
  return location;
}

describe('XeroConnectSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('redirects the browser to Xero instead of opening a popup', async () => {
    const location = stubLocationHref();
    const openSpy = vi.spyOn(window, 'open');
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://login.xero.com/identity/connect/authorize?state=abc' },
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
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:3001/api/xero/redirect',
        expect.objectContaining({ params: { workspaceId: 'ws-1' } })
      );
    });
    expect(location.href).toBe(
      'https://login.xero.com/identity/connect/authorize?state=abc'
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
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

  it('offers Reconnect Xero without disconnecting when organisation is missing', async () => {
    const location = stubLocationHref();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://login.xero.com/identity/connect/authorize?state=abc' },
    });

    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected
        needsReconnect
        onConnectedChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /reconnect xero/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^connect xero$/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /reconnect xero/i }));

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:3001/api/xero/redirect',
        expect.objectContaining({ params: { workspaceId: 'ws-1' } })
      );
    });
    expect(axios.post).not.toHaveBeenCalled();
    expect(location.href).toBe(
      'https://login.xero.com/identity/connect/authorize?state=abc'
    );
  });

  it('shows Connect only when Xero is not integrated', () => {
    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /connect xero/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconnect xero/i })).not.toBeInTheDocument();
  });

  it('does not navigate to an untrusted consent URL', async () => {
    const location = stubLocationHref();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { url: 'https://evil.example/phish' },
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
        expect.objectContaining({ description: 'Invalid Xero redirect URL.' })
      );
    });
    expect(location.href).toBe('http://localhost/');
  });

  it('toasts a network failure instead of navigating', async () => {
    const location = stubLocationHref();
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      message: 'Network Error',
      response: { data: { message: 'Authentication required' } },
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
        expect.objectContaining({ description: 'Authentication required' })
      );
    });
    expect(location.href).toBe('http://localhost/');
  });

  it('does not toast when the connect request is cancelled', async () => {
    const location = stubLocationHref();
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      name: 'CanceledError',
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
      expect(axios.get).toHaveBeenCalled();
    });
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(location.href).toBe('http://localhost/');
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

  it('places extra actions immediately after Test Connection', () => {
    render(
      <XeroConnectSection
        workspaceId="ws-1"
        isConnected={false}
        onConnectedChange={vi.fn()}
        extraActions={<button type="button">View Xero logs</button>}
      />
    );

    const testConnection = screen.getByRole('button', { name: /test connection/i });
    const extra = screen.getByRole('button', { name: /view xero logs/i });
    expect(testConnection.parentElement).toBe(extra.parentElement);
    expect(
      testConnection.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});