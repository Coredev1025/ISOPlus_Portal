import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../msw/server';
import { ContextProvider } from '@/app/context';
import { PageShell, PageHeader, StatCard } from '@/components/ui/page-shell';

/**
 * PageShell is the project's own layout wrapper (not a vendored primitive), so
 * the behaviour worth pinning is its conditional structure: whether the header
 * mounts, whether the back button exists at all, and what each optional slot
 * renders.
 */

// One router object for the whole file. Next's real useRouter is stable, and
// Header's session-check effect lists `router` in its deps — a mock returning a
// fresh object per render would re-fire that effect on every render.
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/workspace/ws-1',
  useSearchParams: () => new URLSearchParams(),
}));

// NEXT_PUBLIC_BACKEND_URL is unset under vitest, so the app requests
// `undefined/api/...`. A leading * matches whatever origin it ends up with.

beforeEach(() => {
  localStorage.clear();
  // PageShell mounts Header by default, which verifies the session on mount.
  server.use(
    http.get(`*/api/auth/verify`, () =>
      HttpResponse.json({ user: null }, { status: 401 }),
    ),
  );
});

function renderShell(ui: React.ReactNode) {
  return render(<ContextProvider>{ui}</ContextProvider>);
}

describe('PageShell', () => {
  it('renders its children', () => {
    renderShell(
      <PageShell showHeader={false}>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.getByText('Board contents')).toBeInTheDocument();
  });

  it('mounts the header by default', () => {
    renderShell(
      <PageShell>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.getByRole('link', { name: 'Open ISO+ app' })).toBeInTheDocument();
  });

  it('omits the header when showHeader is false', () => {
    renderShell(
      <PageShell showHeader={false}>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.queryByRole('link', { name: 'Open ISO+ app' })).not.toBeInTheDocument();
  });

  it('renders no back button when neither label nor handler is given', () => {
    renderShell(
      <PageShell showHeader={false}>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders no back button when only the label is given', () => {
    renderShell(
      <PageShell showHeader={false} backLabel="Back to Board">
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.queryByRole('button', { name: /Back to Board/ })).not.toBeInTheDocument();
  });

  it('renders no back button when only the handler is given', () => {
    renderShell(
      <PageShell showHeader={false} onBack={() => {}}>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the back button when both label and handler are given', () => {
    renderShell(
      <PageShell showHeader={false} backLabel="Back to Board" onBack={() => {}}>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.getByRole('button', { name: /Back to Board/ })).toBeInTheDocument();
  });

  it('calls the back handler when the button is pressed', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderShell(
      <PageShell showHeader={false} backLabel="Back to Board" onBack={onBack}>
        <p>Board contents</p>
      </PageShell>,
    );

    await user.click(screen.getByRole('button', { name: /Back to Board/ }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('hides the back button when printing', () => {
    renderShell(
      <PageShell showHeader={false} backLabel="Back to Board" onBack={() => {}}>
        <p>Board contents</p>
      </PageShell>,
    );

    expect(screen.getByRole('button', { name: /Back to Board/ }).className.split(/\s+/))
      .toContain('print:hidden');
  });

  it('appends a caller class to the outer wrapper', () => {
    const { container } = renderShell(
      <PageShell showHeader={false} className="custom-page">
        <p>Board contents</p>
      </PageShell>,
    );

    const outer = container.querySelector('.min-h-screen') as HTMLElement;
    expect(outer.className.split(/\s+/)).toContain('custom-page');
  });

  it('renders without a className without emitting the string "undefined"', () => {
    const { container } = renderShell(
      <PageShell showHeader={false}>
        <p>Board contents</p>
      </PageShell>,
    );

    const outer = container.querySelector('.min-h-screen') as HTMLElement;
    expect(outer.className).not.toContain('undefined');
  });
});

describe('PageHeader', () => {
  it('renders the title as the page heading', () => {
    render(<PageHeader title="Invoice Generator" />);

    expect(screen.getByRole('heading', { name: 'Invoice Generator' })).toBeInTheDocument();
  });

  it('omits the description when none is given', () => {
    const { container } = render(<PageHeader title="Invoice Generator" />);

    expect(container.querySelector('p')).toBeNull();
  });

  it('renders the description when given', () => {
    render(<PageHeader title="Invoice Generator" description="Generate NDIS invoices" />);

    expect(screen.getByText('Generate NDIS invoices')).toBeInTheDocument();
  });

  it('omits the actions container when no actions are given', () => {
    render(<PageHeader title="Invoice Generator" />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the actions when given', () => {
    render(
      <PageHeader title="Invoice Generator" actions={<button type="button">Export</button>} />,
    );

    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});

describe('StatCard', () => {
  it('renders its label and value', () => {
    render(<StatCard label="Eligible records" value={42} />);

    expect(screen.getByText('Eligible records')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders a node value, not just a number', () => {
    render(<StatCard label="Total" value={<span>$202.68</span>} />);

    expect(screen.getByText('$202.68')).toBeInTheDocument();
  });

  it('omits the icon container when no icon is given', () => {
    const { container } = render(<StatCard label="Total" value="0" />);

    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  it('renders the icon when given', () => {
    render(<StatCard label="Total" value="0" icon={<span data-icon>icon</span>} />);

    expect(screen.getByText('icon')).toBeInTheDocument();
  });

  it('applies a caller class to the value only', () => {
    render(<StatCard label="Total" value="0" valueClassName="text-destructive" />);

    expect(screen.getByText('0').className.split(/\s+/)).toContain('text-destructive');
    expect(screen.getByText('Total').className.split(/\s+/)).not.toContain('text-destructive');
  });

  it('renders without a valueClassName without emitting the string "undefined"', () => {
    render(<StatCard label="Total" value="0" />);

    expect(screen.getByText('0').className).not.toContain('undefined');
  });
});
