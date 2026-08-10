import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

describe('Label', () => {
  it('renders a label element with its text', () => {
    render(<Label>Participant name</Label>);

    expect(screen.getByText('Participant name').tagName).toBe('LABEL');
  });

  it('names the control it points at', () => {
    render(
      <>
        <Label htmlFor="participant">Participant name</Label>
        <Input id="participant" />
      </>,
    );

    expect(screen.getByRole('textbox', { name: 'Participant name' })).toBeInTheDocument();
  });

  it('focuses the control when clicked', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Label htmlFor="participant">Participant name</Label>
        <Input id="participant" />
      </>,
    );

    await user.click(screen.getByText('Participant name'));

    expect(screen.getByRole('textbox', { name: 'Participant name' })).toHaveFocus();
  });

  it('names a control it wraps, with no htmlFor', () => {
    render(
      <Label>
        Participant name
        <Input />
      </Label>,
    );

    expect(screen.getByRole('textbox', { name: 'Participant name' })).toBeInTheDocument();
  });

  it('forwards a ref', () => {
    const ref = createRef<HTMLLabelElement>();
    render(<Label ref={ref}>Name</Label>);

    expect(ref.current).toBeInstanceOf(HTMLLabelElement);
  });

  it('keeps a caller class', () => {
    render(<Label className="text-red-500">Name</Label>);

    expect(screen.getByText('Name').className.split(/\s+/)).toContain('text-red-500');
  });
});
