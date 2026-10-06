import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  useFormField,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

const TOO_SHORT = 'Client name needs at least three characters';

const schema = z.object({
  clientName: z.string().min(3, TOO_SHORT),
});

type Values = z.infer<typeof schema>;

function InvoiceForm({
  onValid = () => {},
  messageChildren,
}: {
  onValid?: (values: Values) => void;
  messageChildren?: React.ReactNode;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { clientName: '' },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onValid)}>
        <FormField
          control={form.control}
          name="clientName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Client name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormDescription>The name printed on the invoice.</FormDescription>
              <FormMessage>{messageChildren}</FormMessage>
            </FormItem>
          )}
        />
        <button type="submit">Generate</button>
      </form>
    </Form>
  );
}

function describedByIds(control: HTMLElement) {
  return (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Form', () => {
  it('wires the label to the control it labels', () => {
    render(<InvoiceForm />);

    const control = screen.getByLabelText('Client name');
    expect(control).toBe(screen.getByRole('textbox'));
    expect(screen.getByText('Client name')).toHaveAttribute('for', control.id);
  });

  it('links the description to the control with aria-describedby', () => {
    render(<InvoiceForm />);

    const control = screen.getByRole('textbox');
    const description = screen.getByText('The name printed on the invoice.');

    expect(describedByIds(control)).toEqual([description.id]);
  });

  it('starts valid, with no message and no error styling', () => {
    render(<InvoiceForm />);

    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText(TOO_SHORT)).not.toBeInTheDocument();
    expect(screen.getByText('Client name').className.split(/\s+/)).not.toContain(
      'text-destructive',
    );
  });

  it('renders the validation message and marks the control invalid on a failed submit', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<InvoiceForm onValid={onValid} />);

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(TOO_SHORT)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(onValid).not.toHaveBeenCalled();
  });

  it('adds the message to aria-describedby once the field is in error', async () => {
    const user = userEvent.setup();
    render(<InvoiceForm />);

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const message = await screen.findByText(TOO_SHORT);

    const description = screen.getByText('The name printed on the invoice.');
    expect(describedByIds(screen.getByRole('textbox'))).toEqual([description.id, message.id]);
  });

  it('turns the label destructive while the field is in error', async () => {
    const user = userEvent.setup();
    render(<InvoiceForm />);

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText(TOO_SHORT);

    expect(screen.getByText('Client name').className.split(/\s+/)).toContain('text-destructive');
  });

  it('clears the error and submits the values once the field is valid', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<InvoiceForm onValid={onValid} />);

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText(TOO_SHORT);

    await user.type(screen.getByRole('textbox'), 'Hills Grade');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(onValid).toHaveBeenCalledTimes(1);
    expect(onValid.mock.calls[0][0]).toEqual({ clientName: 'Hills Grade' });
    expect(screen.queryByText(TOO_SHORT)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows FormMessage children while the field is valid', () => {
    render(<InvoiceForm messageChildren="Use the trading name" />);

    expect(screen.getByText('Use the trading name')).toBeInTheDocument();
  });

  it('replaces FormMessage children with the error message', async () => {
    const user = userEvent.setup();
    render(<InvoiceForm messageChildren="Use the trading name" />);

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(TOO_SHORT)).toBeInTheDocument();
    expect(screen.queryByText('Use the trading name')).not.toBeInTheDocument();
  });

  it('gives every FormItem its own id namespace', () => {
    function TwoFieldForm() {
      const form = useForm({ defaultValues: { clientName: '', reference: '' } });
      return (
        <Form {...form}>
          <FormField
            control={form.control}
            name="clientName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Client name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="reference"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Reference</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />
        </Form>
      );
    }
    render(<TwoFieldForm />);

    expect(screen.getByLabelText('Client name').id).not.toBe(
      screen.getByLabelText('Reference').id,
    );
  });
});

describe('useFormField', () => {
  it('throws when used with no surrounding Form provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Naked() {
      useFormField();
      return null;
    }

    // The guard in useFormField is dead code: it destructures the (null) form
    // context first, so this is a TypeError, not the 'should be used within
    // <FormField>' error the component intends to raise.
    expect(() => render(<Naked />)).toThrow(TypeError);
  });

  it('does not raise its own guard outside a FormField, so the label ends up wired to nothing', () => {
    function OrphanLabel() {
      const form = useForm({ defaultValues: { clientName: '' } });
      return (
        <Form {...form}>
          <FormItem>
            <FormLabel>Client name</FormLabel>
          </FormItem>
          <Input aria-label="Unrelated" />
        </Form>
      );
    }
    render(<OrphanLabel />);

    const label = screen.getByText('Client name');
    const target = label.getAttribute('for') as string;
    expect(target).toMatch(/-form-item$/);
    expect(document.getElementById(target)).toBeNull();
    expect(screen.queryByLabelText('Client name')).not.toBeInTheDocument();
  });
});
