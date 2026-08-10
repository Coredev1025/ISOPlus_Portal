import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

function renderRadioGroup(props: Record<string, unknown> = {}) {
  return render(
    <RadioGroup {...props}>
      <Label htmlFor="ndis">NDIS</Label>
      <RadioGroupItem value="ndis" id="ndis" />
      <Label htmlFor="agecare">Aged Care</Label>
      <RadioGroupItem value="agecare" id="agecare" />
      <Label htmlFor="archived">Archived</Label>
      <RadioGroupItem value="archived" id="archived" disabled />
    </RadioGroup>,
  );
}

describe('RadioGroup', () => {
  it('renders one radio per option, none selected by default', () => {
    renderRadioGroup();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    for (const radio of radios) {
      expect(radio).not.toBeChecked();
    }
  });

  it('selects an option on click and reports its value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderRadioGroup({ onValueChange });

    await user.click(screen.getByRole('radio', { name: 'NDIS' }));

    expect(screen.getByRole('radio', { name: 'NDIS' })).toBeChecked();
    expect(onValueChange).toHaveBeenCalledWith('ndis');
  });

  it('deselects the previous option when another is chosen', async () => {
    const user = userEvent.setup();
    renderRadioGroup();

    await user.click(screen.getByRole('radio', { name: 'NDIS' }));
    await user.click(screen.getByRole('radio', { name: 'Aged Care' }));

    expect(screen.getByRole('radio', { name: 'Aged Care' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'NDIS' })).not.toBeChecked();
  });

  it('pre-selects the defaultValue', () => {
    renderRadioGroup({ defaultValue: 'agecare' });

    expect(screen.getByRole('radio', { name: 'Aged Care' })).toBeChecked();
  });

  it('honours a controlled value', () => {
    renderRadioGroup({ value: 'ndis', onValueChange: () => {} });

    expect(screen.getByRole('radio', { name: 'NDIS' })).toBeChecked();
  });

  it('does not select a disabled option', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderRadioGroup({ onValueChange });

    await user.click(screen.getByRole('radio', { name: 'Archived' }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('is reachable by keyboard and selects on space', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderRadioGroup({ onValueChange });

    await user.tab();
    const first = screen.getByRole('radio', { name: 'NDIS' });
    expect(first).toHaveFocus();

    await user.keyboard(' ');

    expect(first).toBeChecked();
    expect(onValueChange).toHaveBeenCalledWith('ndis');
  });

  it('skips the disabled option when tabbing into the group', async () => {
    const user = userEvent.setup();
    renderRadioGroup();

    await user.tab();

    expect(screen.getByRole('radio', { name: 'Archived' })).not.toHaveFocus();
  });

  it('groups the options in a radiogroup', () => {
    renderRadioGroup();

    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });

  it('shows an indicator only on the selected option', async () => {
    const user = userEvent.setup();
    const { container } = renderRadioGroup();

    expect(container.querySelectorAll('svg')).toHaveLength(0);

    await user.click(screen.getByRole('radio', { name: 'NDIS' }));

    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});
