import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';

function renderAccordion(props: Record<string, unknown> = {}) {
  return render(
    <Accordion type="single" collapsible {...props}>
      <AccordionItem value="services">
        <AccordionTrigger>Services</AccordionTrigger>
        <AccordionContent>12 services delivered</AccordionContent>
      </AccordionItem>
      <AccordionItem value="budgets">
        <AccordionTrigger>Budgets</AccordionTrigger>
        <AccordionContent>Budget breakdown</AccordionContent>
      </AccordionItem>
    </Accordion>,
  );
}

describe('Accordion', () => {
  it('starts with every section collapsed', () => {
    renderAccordion();

    expect(screen.queryByText('12 services delivered')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Services' }))
      .toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a section when its trigger is clicked', async () => {
    const user = userEvent.setup();
    renderAccordion();

    await user.click(screen.getByRole('button', { name: 'Services' }));

    expect(screen.getByText('12 services delivered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Services' }))
      .toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses an open section again when collapsible', async () => {
    const user = userEvent.setup();
    renderAccordion();

    const trigger = screen.getByRole('button', { name: 'Services' });
    await user.click(trigger);
    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the previous section when another opens, in single mode', async () => {
    const user = userEvent.setup();
    renderAccordion();

    await user.click(screen.getByRole('button', { name: 'Services' }));
    await user.click(screen.getByRole('button', { name: 'Budgets' }));

    expect(screen.getByText('Budget breakdown')).toBeInTheDocument();
    expect(screen.queryByText('12 services delivered')).not.toBeInTheDocument();
  });

  it('keeps both sections open in multiple mode', async () => {
    const user = userEvent.setup();
    render(
      <Accordion type="multiple">
        <AccordionItem value="services">
          <AccordionTrigger>Services</AccordionTrigger>
          <AccordionContent>12 services delivered</AccordionContent>
        </AccordionItem>
        <AccordionItem value="budgets">
          <AccordionTrigger>Budgets</AccordionTrigger>
          <AccordionContent>Budget breakdown</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    await user.click(screen.getByRole('button', { name: 'Services' }));
    await user.click(screen.getByRole('button', { name: 'Budgets' }));

    expect(screen.getByText('12 services delivered')).toBeInTheDocument();
    expect(screen.getByText('Budget breakdown')).toBeInTheDocument();
  });

  it('reports the newly opened value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderAccordion({ onValueChange });

    await user.click(screen.getByRole('button', { name: 'Budgets' }));

    expect(onValueChange).toHaveBeenCalledWith('budgets');
  });

  it('opens the section named by defaultValue', () => {
    renderAccordion({ defaultValue: 'budgets' });

    expect(screen.getByText('Budget breakdown')).toBeInTheDocument();
  });

  it('does not open a disabled item', async () => {
    const user = userEvent.setup();
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="archived" disabled>
          <AccordionTrigger>Archived</AccordionTrigger>
          <AccordionContent>Archived records</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

    await user.click(screen.getByRole('button', { name: 'Archived' }));

    expect(screen.queryByText('Archived records')).not.toBeInTheDocument();
  });
});
