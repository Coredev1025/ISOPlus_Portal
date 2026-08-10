import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Input } from '@/components/ui/input';

describe('Input', () => {
  it('renders a textbox that accepts typing', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Participant name" />);

    const input = screen.getByRole('textbox', { name: 'Participant name' });
    await user.type(input, 'Dana Reid');

    expect(input).toHaveValue('Dana Reid');
  });

  it('forwards a ref to the input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('applies the type it is given', () => {
    render(<Input type="password" aria-label="Password" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('renders without a type attribute when none is given', () => {
    render(<Input aria-label="Free text" />);

    expect(screen.getByRole('textbox', { name: 'Free text' }))
      .not.toHaveAttribute('type');
  });

  it('shows its placeholder', () => {
    render(<Input placeholder="Search invoices" />);

    expect(screen.getByPlaceholderText('Search invoices')).toBeInTheDocument();
  });

  it('does not accept typing while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input aria-label="Locked" disabled onChange={onChange} />);

    const input = screen.getByRole('textbox', { name: 'Locked' });
    await user.type(input, 'nope');

    expect(input).toBeDisabled();
    expect(input).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports each keystroke to onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input aria-label="Notes" onChange={onChange} />);

    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'abc');

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('honours a controlled value', () => {
    render(<Input aria-label="Fixed" value="read only" readOnly />);

    expect(screen.getByRole('textbox', { name: 'Fixed' })).toHaveValue('read only');
  });

  it('keeps a caller class', () => {
    render(<Input aria-label="Wide" className="w-64" />);

    expect(screen.getByRole('textbox', { name: 'Wide' }).className).toContain('w-64');
  });
});
