import { describe, it, expect, vi, beforeEach } from 'vitest';

const showMock = vi.fn();
const hideMock = vi.fn();

vi.mock('toastify-js', () => {
  const Toastify = vi.fn(() => ({ showToast: showMock, hideToast: hideMock }));
  return { default: Toastify };
});

describe('toast-utils', () => {
  beforeEach(() => {
    showMock.mockClear();
    hideMock.mockClear();
  });

  it('shows success and error toasts', async () => {
    const { showSuccessToast, showErrorToast } = await import('@/lib/toast-utils');
    showSuccessToast('Saved');
    showErrorToast('Failed');
    expect(showMock).toHaveBeenCalled();
  });
});
