import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Textarea } from '@/components/ui/textarea';

describe('Textarea', () => {
  it('renders a textbox that accepts multi-line typing', async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Additional notes" />);

    const textarea = screen.getByRole('textbox', { name: 'Additional notes' });
    await user.type(textarea, 'line one{enter}line two');

    expect(textarea).toHaveValue('line one\nline two');
  });

  it('forwards a ref to the textarea element', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} />);

    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('shows its placeholder', () => {
    render(<Textarea placeholder="Describe the service" />);

    expect(screen.getByPlaceholderText('Describe the service')).toBeInTheDocument();
  });

  it('does not accept typing while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Textarea aria-label="Locked" disabled onChange={onChange} />);

    const textarea = screen.getByRole('textbox', { name: 'Locked' });
    await user.type(textarea, 'nope');

    expect(textarea).toBeDisabled();
    expect(textarea).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('honours the rows attribute', () => {
    render(<Textarea aria-label="Notes" rows={8} />);

    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveAttribute('rows', '8');
  });

  it('keeps a caller class', () => {
    render(<Textarea aria-label="Tall" className="min-h-[300px]" />);

    expect(screen.getByRole('textbox', { name: 'Tall' }).className)
      .toContain('min-h-[300px]');
  });
});
