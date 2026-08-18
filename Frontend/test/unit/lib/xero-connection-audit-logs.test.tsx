import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    get: vi.fn(),
  },
}));

import axios from '@/app/utils/axiosConfig';
import { XeroConnectionAuditLogs } from '@/lib/xero-connection-audit-logs';

describe('XeroConnectionAuditLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_BACKEND_URL = 'http://localhost:3001';
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps logs behind a button until the user opens the popup', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        items: [
          {
            _id: '1',
            createdAt: '2026-08-18T10:00:00.000Z',
            action: 'Connected Xero',
            detail: 'Latest event',
            userEmail: 'owner@example.com',
            success: true,
          },
        ],
        total: 1,
        page: 1,
        totalPages: 1,
      },
    });

    render(<XeroConnectionAuditLogs workspaceId="ws-1" />);

    expect(screen.getByRole('button', { name: /view xero logs/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected Xero')).not.toBeInTheDocument();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('shows newest events first and paginates inside the popup', async () => {
    (axios.get as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, config?: { params?: { page?: number } }) => {
        const page = Number(config?.params?.page || 1);
        if (page === 1) {
          return Promise.resolve({
            data: {
              items: [
                {
                  _id: 'newer',
                  createdAt: '2026-08-18T12:00:00.000Z',
                  action: 'Connected Xero',
                  detail: 'Newest',
                  success: true,
                },
              ],
              total: 21,
              page: 1,
              totalPages: 2,
            },
          });
        }
        return Promise.resolve({
          data: {
            items: [
              {
                _id: 'older',
                createdAt: '2026-08-01T00:00:00.000Z',
                action: 'Disconnected Xero',
                detail: 'Oldest on this page',
                success: true,
              },
            ],
            total: 21,
            page: 2,
            totalPages: 2,
          },
        });
      }
    );

    render(<XeroConnectionAuditLogs workspaceId="ws-1" />);
    await userEvent.click(screen.getByRole('button', { name: /view xero logs/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /xero logs/i })).toBeInTheDocument();
    expect(await within(dialog).findByText('Connected Xero')).toBeInTheDocument();
    expect(within(dialog).getByText('Newest')).toBeInTheDocument();
    expect(within(dialog).queryByText('Disconnected Xero')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:3001/api/audit/',
        expect.objectContaining({
          params: expect.objectContaining({
            workspaceId: 'ws-1',
            category: 'Xero',
            sortBy: 'createdAt',
            sortOrder: 'desc',
            page: 1,
            limit: 20,
          }),
        })
      );
    });

    await userEvent.click(within(dialog).getByLabelText('Go to next page'));

    expect(await within(dialog).findByText('Disconnected Xero')).toBeInTheDocument();
    expect(within(dialog).queryByText('Connected Xero')).not.toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:3001/api/audit/',
      expect.objectContaining({
        params: expect.objectContaining({
          sortOrder: 'desc',
          page: 2,
        }),
      })
    );
  });
});
