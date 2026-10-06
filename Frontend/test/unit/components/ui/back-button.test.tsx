import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackButton } from '@/components/ui/back-button';

describe('BackButton', () => {
  it('exposes its children as the button accessible name', () => {
    render(<BackButton onClick={() => {}}>Back to board</BackButton>);

    expect(
      screen.getByRole('button', { name: 'Back to board' })
    ).toBeInTheDocument();
  });

  it('calls onClick exactly once per click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<BackButton onClick={onClick}>Back to dashboard</BackButton>);

    await user.click(screen.getByRole('button', { name: 'Back to dashboard' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick before the user interacts', () => {
    const onClick = vi.fn();
    render(<BackButton onClick={onClick}>Back</BackButton>);

    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit a surrounding form (type="button")', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <BackButton onClick={onClick}>Back</BackButton>
      </form>
    );

    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps a caller-supplied className on the button', () => {
    render(
      <BackButton onClick={() => {}} className="my-caller-class">
        Back
      </BackButton>
    );

    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass(
      'my-caller-class'
    );
  });

  it('renders non-text children inside the button', () => {
    render(
      <BackButton onClick={() => {}}>
        <em>Return</em>
      </BackButton>
    );

    const button = screen.getByRole('button', { name: 'Return' });
    expect(button.querySelector('em')).not.toBeNull();
  });
});
