import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';

/** Exact class-token membership; substring checks would also match `hover:bg-primary/90`. */
const tokens = (className: string) => className.split(/\s+/).filter(Boolean);

/**
 * Button is a vendored shadcn primitive, so the parts worth testing are the
 * project's own: the cva variant table, the `cn`/tailwind-merge class merge
 * (which decides whether a caller can override a variant), the asChild slot,
 * and that ref forwarding and native button semantics survive.
 */

describe('Button rendering', () => {
  it('renders a real button element with its children', () => {
    render(<Button>Save invoice</Button>);

    expect(screen.getByRole('button', { name: 'Save invoice' })).toBeInTheDocument();
  });

  it('forwards a ref to the underlying button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe('Save');
  });

  it('passes native attributes through', () => {
    render(<Button type="submit" aria-label="Submit the form" name="save" />);

    const button = screen.getByRole('button', { name: 'Submit the form' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('name', 'save');
  });

  it('renders the child element instead of a button when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/workspace/1">Open workspace</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Open workspace' });
    expect(link).toHaveAttribute('href', '/workspace/1');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies its styling to the slotted child', () => {
    render(
      <Button asChild variant="destructive">
        <a href="/delete">Delete</a>
      </Button>,
    );

    expect(screen.getByRole('link', { name: 'Delete' }).className)
      .toContain('bg-destructive');
  });
});

describe('Button interaction', () => {
  it('invokes onClick when pressed', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Sync</Button>);

    await user.click(screen.getByRole('button', { name: 'Sync' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onClick while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Sync
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Sync' });
    expect(button).toBeDisabled();
    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it('is reachable by keyboard and fires on Enter', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Sync</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Sync' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('buttonVariants', () => {
  it('defaults to the primary variant at the default size', () => {
    const classes = buttonVariants();

    expect(classes).toContain('bg-primary');
    expect(classes).toContain('h-10');
  });

  it.each([
    ['destructive', 'bg-destructive'],
    ['outline', 'border-input'],
    ['secondary', 'bg-secondary'],
    ['link', 'underline-offset-4'],
  ] as const)('gives the %s variant its own styling', (variant, token) => {
    expect(buttonVariants({ variant })).toContain(token);
  });

  it('does not apply the primary background to the ghost variant', () => {
    expect(buttonVariants({ variant: 'ghost' })).not.toContain('bg-primary');
  });

  it.each([
    ['sm', 'h-9'],
    ['lg', 'h-11'],
    ['icon', 'w-10'],
  ] as const)('gives the %s size its own dimensions', (size, token) => {
    expect(buttonVariants({ size })).toContain(token);
  });

  it('appends the caller class without resolving conflicts, since cva does not merge', () => {
    // buttonVariants is raw cva output. Conflict resolution happens only in the
    // component, which wraps this in cn()/tailwind-merge.
    const classes = tokens(buttonVariants({ variant: 'default', className: 'bg-emerald-500' }));

    expect(classes).toContain('bg-emerald-500');
    expect(classes).toContain('bg-primary');
  });

  it('keeps a non-conflicting caller class alongside the variant', () => {
    const classes = tokens(buttonVariants({ className: 'w-full' }));

    expect(classes).toContain('w-full');
    expect(classes).toContain('bg-primary');
  });
});

describe('Button styling integration', () => {
  it('renders with the variant and size the caller asked for', () => {
    render(
      <Button variant="secondary" size="lg">
        Export
      </Button>,
    );

    const className = screen.getByRole('button', { name: 'Export' }).className;
    expect(className).toContain('bg-secondary');
    expect(className).toContain('h-11');
  });

  it('lets the caller override the variant background on the rendered element', () => {
    render(<Button className="bg-emerald-500">Export</Button>);

    const classes = tokens(screen.getByRole('button', { name: 'Export' }).className);
    expect(classes).toContain('bg-emerald-500');
    // tailwind-merge drops the conflicting base background…
    expect(classes).not.toContain('bg-primary');
    // …but leaves the hover variant, which does not conflict with it.
    expect(classes).toContain('hover:bg-primary/90');
  });
});
