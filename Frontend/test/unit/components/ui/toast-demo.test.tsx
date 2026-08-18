import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * ToastDemo is a showcase surface, so its contract is: each button raises the
 * toast it advertises, with the wording it advertises.
 *
 * The toasts do NOT go through hooks/use-toast — lib/toast-utils.ts wraps
 * `toastify-js`. So the real boundary is the config object handed to Toastify,
 * and that is what these tests read, mirroring test/unit/toast-utils.test.ts.
 */

const showToast = vi.fn();
const hideToast = vi.fn();
const Toastify = vi.fn(() => {
  const toastElement = document.createElement('div');
  document.body.appendChild(toastElement);
  return { showToast, hideToast, toastElement };
});

vi.mock('toastify-js', () => ({ default: Toastify }));

/**
 * Every string Toastify has been asked to display so far. toast-utils builds a
 * DOM node rather than passing `text`, so the wording lives in node.textContent.
 */
function shownText() {
  return Toastify.mock.calls.map((call) => {
    const config = call[0] as { text?: string; node?: HTMLElement };
    return config?.text ?? config?.node?.textContent ?? '';
  });
}

/** The isoplus-toast-<type> class toast-utils tags each toast with. */
function shownTypes() {
  return Toastify.mock.calls
    .map((call) => String((call[0] as { className?: string })?.className ?? ''))
    .map((className) => className.replace(/^.*isoplus-toast-/, ''));
}

beforeEach(() => {
  vi.useRealTimers();
  Toastify.mockClear();
  showToast.mockClear();
  hideToast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('.toastify').forEach((node) => node.remove());
});

describe('ToastDemo rendering', () => {
  it('renders its heading', async () => {
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);

    expect(screen.getByRole('heading', { name: 'Toast Notifications Demo' }))
      .toBeInTheDocument();
  });

  it('renders a second heading for the data-operation group', async () => {
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);

    expect(screen.getByRole('heading', { name: 'Data Operation Toasts' }))
      .toBeInTheDocument();
  });

  it.each([
    'Success Toast',
    'Error Toast',
    'Info Toast',
    'Warning Toast',
    'Loading Toast',
    'Dismiss All',
    'Fetch Success',
    'Fetch Error',
    'Save Success',
    'Save Error',
  ])('offers a %s button', async (name) => {
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);

    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('raises no toast until a button is pressed', async () => {
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);

    expect(Toastify).not.toHaveBeenCalled();
  });
});

describe('ToastDemo actions', () => {
  async function renderDemo() {
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);
    return userEvent.setup();
  }

  it('raises a success toast with its advertised wording', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Success Toast' }));

    expect(shownText().join('\n')).toContain('Operation completed successfully!');
    expect(shownTypes()).toContain('success');
    expect(showToast).toHaveBeenCalled();
  });

  it('raises an error toast carrying its description', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Error Toast' }));

    const text = shownText().join('\n');
    expect(text).toContain('Something went wrong!');
    expect(text).toContain('Please check your input and try again.');
    expect(shownTypes()).toContain('error');
  });

  it('raises an info toast with its description', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Info Toast' }));

    const text = shownText().join('\n');
    expect(text).toContain('Information');
    expect(text).toContain('This is an informational message.');
    expect(shownTypes()).toContain('info');
  });

  it('raises a warning toast with its description', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Warning Toast' }));

    const text = shownText().join('\n');
    expect(text).toContain('Warning');
    expect(text).toContain('Please review your settings before proceeding.');
    expect(shownTypes()).toContain('warning');
  });

  it('names the resource in the fetch-success toast', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Fetch Success' }));

    expect(shownText().join('\n')).toContain('User data');
  });

  it('carries the reason in the fetch-error toast', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Fetch Error' }));

    expect(shownText().join('\n')).toContain('Network connection failed');
  });

  it('names the resource in the save-success toast', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Save Success' }));

    expect(shownText().join('\n')).toContain('User profile');
  });

  it('carries the validation reason in the save-error toast', async () => {
    const user = await renderDemo();

    await user.click(screen.getByRole('button', { name: 'Save Error' }));

    expect(shownText().join('\n')).toContain('Validation failed: Email is required');
  });

  it('hides the open toasts when Dismiss All is pressed', async () => {
    // Loading toasts skip the 2s duplicate window, so this click always
    // creates a node even when earlier tests already showed a success toast.
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Loading Toast' }));
    const toastElement = Toastify.mock.results.at(-1)?.value.toastElement as HTMLElement;
    expect(toastElement.parentNode).toBe(document.body);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss All' }));

    expect(toastElement.parentNode).toBeNull();
  });

  it('raises the loading toast immediately, and the success toast only after 3s', async () => {
    // fireEvent rather than userEvent here: userEvent awaits its own internal
    // timers, which never resolve once vi.useFakeTimers() is installed.
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Loading Toast' }));
    const loadingElement = Toastify.mock.results.at(-1)?.value.toastElement as HTMLElement;

    expect(shownText().join('\n')).toContain('Processing your request...');
    expect(shownText().join('\n')).not.toContain('Request completed!');
    expect(loadingElement.parentNode).toBe(document.body);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(shownText().join('\n')).toContain('Request completed!');
    expect(loadingElement.parentNode).toBeNull();
  });

  it('does not raise the follow-up success toast early', async () => {
    const { ToastDemo } = await import('@/components/ui/toast-demo');
    render(<ToastDemo />);
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'Loading Toast' }));
    await act(async () => {
      vi.advanceTimersByTime(2999);
    });

    expect(shownText().join('\n')).not.toContain('Request completed!');
  });
});
