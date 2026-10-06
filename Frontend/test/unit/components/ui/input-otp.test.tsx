import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from '@/components/ui/input-otp';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  // input-otp polls document.elementFromPoint on a timer to track the caret.
  // jsdom does not implement it, and the throw lands outside any test as an
  // unhandled error that fails the run even though every assertion passes.
  document.elementFromPoint ??= () => null;
});

beforeEach(() => {
  // input-otp schedules caret sync timeouts that otherwise fire after the
  // jsdom environment is torn down → ReferenceError: window is not defined.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function renderOtp(props: Record<string, unknown> = {}, length = 4) {
  return render(
    <InputOTP maxLength={length} {...props}>
      <InputOTPGroup>
        {Array.from({ length }, (_, i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>,
  );
}

function createUser() {
  return userEvent.setup({
    advanceTimers: (ms) => {
      vi.advanceTimersByTime(ms);
    },
  });
}

/** The visible slots, in order, as their rendered characters. */
function slotChars(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.h-10.w-10')).map(
    (slot) => slot.textContent ?? '',
  );
}

describe('InputOTP', () => {
  it('renders one slot per position, all empty', () => {
    const { container } = renderOtp();

    expect(slotChars(container)).toEqual(['', '', '', '']);
  });

  it('exposes a single input for the whole code', () => {
    renderOtp();

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('fills the slots left to right as the user types', async () => {
    const user = createUser();
    const { container } = renderOtp();

    await user.type(screen.getByRole('textbox'), '12');

    expect(slotChars(container)).toEqual(['1', '2', '', '']);
  });

  it('reports the value on every keystroke', async () => {
    const user = createUser();
    const onChange = vi.fn();
    renderOtp({ onChange });

    await user.type(screen.getByRole('textbox'), '123');

    expect(onChange).toHaveBeenLastCalledWith('123');
  });

  it('stops accepting input at maxLength', async () => {
    const user = createUser();
    const { container } = renderOtp({}, 4);

    await user.type(screen.getByRole('textbox'), '123456');

    expect(slotChars(container)).toEqual(['1', '2', '3', '4']);
  });

  it('fires onComplete once the final slot is filled', async () => {
    const user = createUser();
    const onComplete = vi.fn();
    renderOtp({ onComplete });

    await user.type(screen.getByRole('textbox'), '123');
    expect(onComplete).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), '4');
    expect(onComplete).toHaveBeenCalledWith('1234');
  });

  it('clears the last slot on backspace', async () => {
    const user = createUser();
    const { container } = renderOtp();

    await user.type(screen.getByRole('textbox'), '12');
    await user.type(screen.getByRole('textbox'), '{Backspace}');

    expect(slotChars(container)).toEqual(['1', '', '', '']);
  });

  it('honours a controlled value', () => {
    const { container } = render(
      <InputOTP maxLength={4} value="99" onChange={() => {}}>
        <InputOTPGroup>
          {Array.from({ length: 4 }, (_, i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>,
    );

    expect(slotChars(container)).toEqual(['9', '9', '', '']);
  });

  it('accepts no input while disabled', async () => {
    const user = createUser();
    const onChange = vi.fn();
    const { container } = renderOtp({ disabled: true, onChange });

    await user.type(screen.getByRole('textbox'), '12');

    expect(slotChars(container)).toEqual(['', '', '', '']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a caller class on a slot', () => {
    render(
      <InputOTP maxLength={1}>
        <InputOTPGroup>
          <InputOTPSlot index={0} className="border-destructive" />
        </InputOTPGroup>
      </InputOTP>,
    );

    const slot = document.querySelector('.h-10.w-10') as HTMLElement;
    expect(slot.className.split(/\s+/)).toContain('border-destructive');
  });
});

describe('InputOTPSeparator', () => {
  it('renders a separator between groups', () => {
    render(
      <InputOTP maxLength={2}>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={1} />
        </InputOTPGroup>
      </InputOTP>,
    );

    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
});
