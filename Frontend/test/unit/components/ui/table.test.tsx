import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/components/ui/table';

function renderInvoiceTable() {
  return render(
    <Table>
      <TableCaption>Eligible service records</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Participant</TableHead>
          <TableHead>Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Dana Reid</TableCell>
          <TableCell>135.12</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Sam Okafor</TableCell>
          <TableCell>67.56</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell>202.68</TableCell>
        </TableRow>
      </TableFooter>
    </Table>,
  );
}

describe('Table semantics', () => {
  it('renders a real table with an accessible name from its caption', () => {
    renderInvoiceTable();

    expect(screen.getByRole('table', { name: 'Eligible service records' }))
      .toBeInTheDocument();
  });

  it('renders column headers as th elements', () => {
    renderInvoiceTable();

    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Participant', 'Amount']);
  });

  it('renders one row per record plus the header and footer rows', () => {
    renderInvoiceTable();

    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('puts the data rows in the body and the total in the footer', () => {
    const { container } = renderInvoiceTable();

    const body = container.querySelector('tbody') as HTMLElement;
    const footer = container.querySelector('tfoot') as HTMLElement;

    expect(within(body).getAllByRole('row')).toHaveLength(2);
    expect(within(footer).getByText('202.68')).toBeInTheDocument();
  });

  it('renders cells as td elements', () => {
    renderInvoiceTable();

    expect(screen.getByText('Dana Reid').tagName).toBe('TD');
  });

  it('renders an empty body without rows', () => {
    const { container } = render(
      <Table>
        <TableBody />
      </Table>,
    );

    expect(container.querySelectorAll('tr')).toHaveLength(0);
  });
});

describe('Table styling', () => {
  it('wraps the table in a horizontally scrollable container', () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const wrapper = container.querySelector('div');
    expect(wrapper?.className.split(/\s+/)).toContain('overflow-auto');
  });

  it.each([
    ['TableRow', TableRow],
    ['TableHead', TableHead],
    ['TableCell', TableCell],
  ] as const)('%s keeps a caller class', (_name, Component) => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <Component className="custom-cell" data-testid="target" />
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByTestId('target').className.split(/\s+/)).toContain('custom-cell');
  });
});
