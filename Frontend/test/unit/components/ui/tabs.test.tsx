import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

function renderTabs(props: Record<string, unknown> = {}) {
  return render(
    <Tabs defaultValue="services" {...props}>
      <TabsList>
        <TabsTrigger value="services">Services</TabsTrigger>
        <TabsTrigger value="budgets">Budgets</TabsTrigger>
        <TabsTrigger value="archived" disabled>
          Archived
        </TabsTrigger>
      </TabsList>
      <TabsContent value="services">Service records</TabsContent>
      <TabsContent value="budgets">Budget breakdown</TabsContent>
      <TabsContent value="archived">Archived records</TabsContent>
    </Tabs>,
  );
}

describe('Tabs', () => {
  it('shows only the default tab panel', () => {
    renderTabs();

    expect(screen.getByText('Service records')).toBeInTheDocument();
    expect(screen.queryByText('Budget breakdown')).not.toBeInTheDocument();
  });

  it('marks the default trigger as selected', () => {
    renderTabs();

    expect(screen.getByRole('tab', { name: 'Services' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Budgets' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches panels when another tab is clicked', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('tab', { name: 'Budgets' }));

    expect(screen.getByText('Budget breakdown')).toBeInTheDocument();
    expect(screen.queryByText('Service records')).not.toBeInTheDocument();
  });

  it('reports the newly selected value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderTabs({ onValueChange });

    await user.click(screen.getByRole('tab', { name: 'Budgets' }));

    expect(onValueChange).toHaveBeenCalledWith('budgets');
  });

  it('does not select a disabled tab', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderTabs({ onValueChange });

    await user.click(screen.getByRole('tab', { name: 'Archived' }));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByText('Service records')).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('tab', { name: 'Services' }));
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Budgets' })).toHaveAttribute('aria-selected', 'true');
  });

  it('groups the triggers in a tablist', () => {
    renderTabs();

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('honours a controlled value', () => {
    render(
      <Tabs value="budgets" onValueChange={() => {}}>
        <TabsList>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
        </TabsList>
        <TabsContent value="services">Service records</TabsContent>
        <TabsContent value="budgets">Budget breakdown</TabsContent>
      </Tabs>,
    );

    expect(screen.getByText('Budget breakdown')).toBeInTheDocument();
  });
});
