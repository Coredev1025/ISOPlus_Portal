import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Header } from '@/components/ui/header';
import { ContextProvider } from '@/app/context';

const push = vi.fn();

// One router object for the whole file. Next's real useRouter returns a stable
// reference, and Header's session-check effect lists `router` in its deps — a
// mock that built a fresh object per render would re-run that effect on every
// render and make the verify call count meaningless.
const router = {
  push,
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

const verifySession = vi.fn();
vi.mock('@/app/utils/cookies', () => ({
  verifySession: (...args: unknown[]) => verifySession(...args),
  isTokenValid: (...args: unknown[]) => verifySession(...args),
}));

const axiosPost = vi.fn();
const axiosGet = vi.fn();
vi.mock('@/app/utils/axiosConfig', () => ({
  default: {
    post: (...args: unknown[]) => axiosPost(...args),
    get: (...args: unknown[]) => axiosGet(...args),
  },
}));

const ADA = {
  id: 'u-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  avatar: '',
  role: 'support_admin',
};

function sessionFor(user: Record<string, unknown>) {
  return { status: 200, data: { user } };
}

function renderHeader() {
  return render(
    <ContextProvider>
      <Header />
    </ContextProvider>,
  );
}

beforeEach(() => {
  push.mockReset();
  verifySession.mockReset().mockResolvedValue(sessionFor(ADA));
  axiosPost.mockReset().mockResolvedValue({ data: {} });
  axiosGet.mockReset().mockResolvedValue({ data: {} });
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Header', () => {
  it('links the product name back to the dashboard', async () => {
    renderHeader();

    const link = await screen.findByRole('link', { name: 'ISO+™ Portal' });
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('opens the ISO+ app in a new tab, with the noopener guard', async () => {
    renderHeader();

    const link = await screen.findByRole('link', { name: 'Open ISO+ app' });
    expect(link).toHaveAttribute('href', 'https://app.isoplus.online/home');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('verifies the session on mount and adopts the returned user', async () => {
    renderHeader();

    await waitFor(() => expect(verifySession).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('AL')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('shows a two-letter monogram built from the first and last name', async () => {
    verifySession.mockResolvedValue(
      sessionFor({ ...ADA, name: 'Grace Brewster Hopper' }),
    );
    renderHeader();

    expect(await screen.findByText('GB')).toBeInTheDocument();
  });

  it('shows a single initial for a one-word name', async () => {
    verifySession.mockResolvedValue(sessionFor({ ...ADA, name: 'cher' }));
    renderHeader();

    expect(await screen.findByText('C')).toBeInTheDocument();
  });

  it('falls back to "?" when the user has no name', async () => {
    verifySession.mockResolvedValue(sessionFor({ ...ADA, name: '   ' }));
    renderHeader();

    expect(await screen.findByText('?')).toBeInTheDocument();
  });

  it('shows the avatar image instead of initials when the user has one', async () => {
    verifySession.mockResolvedValue(
      sessionFor({ ...ADA, avatar: 'https://cdn.example.com/ada.png' }),
    );
    const { container } = renderHeader();

    await waitFor(() =>
      expect(
        container.querySelector('img[src="https://cdn.example.com/ada.png"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText('AL')).not.toBeInTheDocument();
  });

  it('reveals the name and email on hovering the avatar', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.hover(await screen.findByText('AL'));

    expect(await screen.findAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(screen.getAllByText('ada@example.com')).not.toHaveLength(0);
  });

  it('falls back to "Signed in" in the tooltip when there is no name', async () => {
    verifySession.mockResolvedValue(sessionFor({ ...ADA, name: '', email: '' }));
    const user = userEvent.setup();
    renderHeader();

    await user.hover(await screen.findByText('?'));

    expect(await screen.findAllByText('Signed in')).not.toHaveLength(0);
  });

  it('sends an unauthenticated visitor back to the login page', async () => {
    verifySession.mockResolvedValue({ status: 401, data: {} });
    renderHeader();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    expect(await screen.findByText('?')).toBeInTheDocument();
  });

  it('treats a 200 with no user in the payload as unauthenticated', async () => {
    verifySession.mockResolvedValue({ status: 200, data: {} });
    renderHeader();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('swallows a cancelled verification without redirecting or logging', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cancelled = Object.assign(new Error('canceled'), {
      name: 'CanceledError',
    });
    verifySession.mockRejectedValue(cancelled);
    renderHeader();

    await waitFor(() => expect(verifySession).toHaveBeenCalled());
    await Promise.resolve();

    expect(push).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs a genuine verification failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    verifySession.mockRejectedValue(new Error('network down'));
    renderHeader();

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        'Token verification failed:',
        expect.any(Error),
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('clears the cached session, calls the API and returns to login on sign out', async () => {
    axiosPost.mockResolvedValue({ status: 200, data: { message: 'Logout successful' } });
    const user = userEvent.setup();
    renderHeader();
    await screen.findByText('AL');
    window.localStorage.setItem('user', JSON.stringify(ADA));
    window.localStorage.setItem('workspace', '[{"id":1}]');
    window.localStorage.setItem('board', '{"id":"b-1"}');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/logout'),
        {},
      );
    });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/');
    });
    expect(window.localStorage.getItem('user')).toBeNull();
    expect(window.localStorage.getItem('workspace')).toBeNull();
    expect(window.localStorage.getItem('board')).toBeNull();
    expect(await screen.findByText('?')).toBeInTheDocument();
  });

  it('still signs the user out locally when the logout request fails', async () => {
    axiosPost.mockRejectedValue(new Error('backend unreachable'));
    const user = userEvent.setup();
    renderHeader();
    await screen.findByText('AL');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/');
    });
  });

  it('offers the theme toggle in the header actions', async () => {
    renderHeader();

    expect(
      await screen.findByRole('button', { name: 'Toggle theme' }),
    ).toBeInTheDocument();
  });

  it('sticks to the top of the viewport', async () => {
    const { container } = renderHeader();
    await screen.findByText('AL');

    const tokens = container.querySelector('header')!.className.split(/\s+/);
    expect(tokens).toContain('sticky');
  });
});
