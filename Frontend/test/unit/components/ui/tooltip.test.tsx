import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';

function renderTooltip(open?: boolean) {
  return render(
    <TooltipProvider delayDuration={0}>
      <Tooltip {...(open === undefined ? {} : { open })}>
        <TooltipTrigger>Sync now</TooltipTrigger>
        <TooltipContent>Fetches the latest board data</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe('Tooltip', () => {
  it('renders the trigger but not the content initially', () => {
    renderTooltip();

    expect(screen.getByText('Sync now')).toBeInTheDocument();
    expect(screen.queryByText('Fetches the latest board data')).not.toBeInTheDocument();
  });

  it('reveals the content on focus', async () => {
    const user = userEvent.setup();
    renderTooltip();

    await user.tab();

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Fetches the latest board data',
    );
  });

  it('hides the content again when focus leaves', async () => {
    const user = userEvent.setup();
    renderTooltip();

    await user.tab();
    await screen.findByRole('tooltip');
    await user.tab();

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows the content when opened programmatically', () => {
    renderTooltip(true);

    expect(screen.getByRole('tooltip')).toHaveTextContent('Fetches the latest board data');
  });

  it('keeps the content hidden when explicitly closed', async () => {
    const user = userEvent.setup();
    renderTooltip(false);

    await user.tab();

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('keeps a caller class on the content', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip open>
          <TooltipTrigger>Sync now</TooltipTrigger>
          <TooltipContent className="max-w-xs">Details</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    // Radix renders the styled content node plus a visually-hidden copy for the
    // tooltip role, so both match the text. Pick the styled one.
    const styled = screen
      .getAllByText('Details')
      .find((node) => node.className.includes('bg-popover'));

    expect(styled).toBeDefined();
    expect(styled!.className.split(/\s+/)).toContain('max-w-xs');
    expect(styled!.className.split(/\s+/)).toContain('rounded-md');
  });
});
