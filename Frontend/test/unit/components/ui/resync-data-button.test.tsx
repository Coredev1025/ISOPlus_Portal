import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResyncDataButton } from '@/components/ui/resync-data-button';

const HELP_LABEL = 'Learn more about Resync Data';
const DEFAULT_TOOLTIP =
  'It downloads brand-new data from the server, including any edits and new records.';

function setup(overrides: Partial<React.ComponentProps<typeof ResyncDataButton>> = {}) {
  const onSync = vi.fn();
  const onHelp = vi.fn();
  const utils = render(
    <ResyncDataButton
      onSync={onSync}
      onHelp={onHelp}
      isSyncing={false}
      {...overrides}
    />
  );
  return { onSync, onHelp, ...utils };
}

describe('ResyncDataButton', () => {
  it('shows an enabled "Resync Data" button when idle', () => {
    setup();

    const button = screen.getByRole('button', { name: /Resync Data/ });
    expect(button).toBeEnabled();
    expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
  });

  it('calls onSync — and not onHelp — when the button body is clicked', async () => {
    const user = userEvent.setup();
    const { onSync, onHelp } = setup();

    await user.click(screen.getByText('Resync Data'));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onHelp).not.toHaveBeenCalled();
  });

  it('calls onHelp — and not onSync — when the help icon is clicked', async () => {
    const user = userEvent.setup();
    const { onSync, onHelp } = setup();

    await user.click(screen.getByLabelText(HELP_LABEL));

    expect(onHelp).toHaveBeenCalledTimes(1);
    expect(onSync).not.toHaveBeenCalled();
  });

  it('swaps the label to "Syncing..." and disables the button while syncing', async () => {
    const user = userEvent.setup();
    const { onSync } = setup({ isSyncing: true });

    const button = screen.getByRole('button', { name: /Syncing\.\.\./ });
    expect(button).toBeDisabled();
    expect(screen.queryByText('Resync Data')).not.toBeInTheDocument();

    await user.click(button, { pointerEventsCheck: 0 });
    expect(onSync).not.toHaveBeenCalled();
  });

  it('renders a spinner only while syncing', () => {
    const { container, unmount } = setup({ isSyncing: true });
    expect(container.querySelectorAll('.loader')).toHaveLength(1);
    unmount();

    const idle = setup({ isSyncing: false });
    expect(idle.container.querySelectorAll('.loader')).toHaveLength(0);
  });

  it('disables the idle button when disabled is set, without changing the label', async () => {
    const user = userEvent.setup();
    const { onSync } = setup({ disabled: true });

    const button = screen.getByRole('button', { name: /Resync Data/ });
    expect(button).toBeDisabled();

    await user.click(button, { pointerEventsCheck: 0 });
    expect(onSync).not.toHaveBeenCalled();
  });

  it('is enabled when disabled is omitted (defaults to false)', () => {
    setup();

    expect(screen.getByRole('button', { name: /Resync Data/ })).toBeEnabled();
  });

  it('shows the default tooltip text on hover', async () => {
    const user = userEvent.setup();
    setup();

    await user.hover(screen.getByRole('button', { name: /Resync Data/ }));

    expect(
      await screen.findAllByText(DEFAULT_TOOLTIP, undefined, { timeout: 3000 })
    ).not.toHaveLength(0);
  });

  it('shows a caller-supplied tooltip text instead of the default', async () => {
    const user = userEvent.setup();
    setup({ tooltipText: 'Pulls the latest rows from ISO+.' });

    await user.hover(screen.getByRole('button', { name: /Resync Data/ }));

    expect(
      await screen.findAllByText('Pulls the latest rows from ISO+.', undefined, {
        timeout: 3000,
      })
    ).not.toHaveLength(0);
    expect(screen.queryAllByText(DEFAULT_TOOLTIP)).toHaveLength(0);
  });

  it('keeps a caller-supplied className on the button', () => {
    setup({ className: 'my-caller-class' });

    expect(screen.getByRole('button', { name: /Resync Data/ })).toHaveClass(
      'my-caller-class'
    );
  });
});
