import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

describe('XeroConnectSection OAuth message listener', () => {
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
});
