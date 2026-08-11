import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QrGeneratorSourcePanel } from '@/lib/qr-generator-source-panel';

/**
 * The source panel decides what the QR code will encode. Its real behaviour is
 * conditional: the custom-URL branch swaps in a URL field and drops the sharing
 * note, the logo checkbox is gated on the business actually having a logo, and
 * the Generate button is gated on a resolvable target URL. Each of those gates
 * is pinned here — getting one wrong either blocks a valid QR code or lets an
 * empty one through.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const CUSTOM = '__qr_custom_url__';

const ITEMS = [
  { id: 'f-1', name: 'Intake Form', url: 'https://iso.example.com/f/1', type: 'form' as const },
  { id: 'd-1', name: 'Care Plan', url: 'https://iso.example.com/d/1', type: 'document' as const },
];

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    items: ITEMS,
    business: { squareLogo: 'square.png' },
    selectedId: '',
    customUrl: '',
    customUrlSelectionId: CUSTOM,
    comboOpen: false,
    setComboOpen: vi.fn(),
    setSelectedId: vi.fn(),
    setCustomUrl: vi.fn(),
    drawLogo: false,
    setDrawLogo: vi.fn(),
    generating: false,
    generateQRCode: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(<QrGeneratorSourcePanel {...(props as never)} />);
  return props;
}

describe('QrGeneratorSourcePanel heading and note', () => {
  it('explains what the panel is for', () => {
    renderPanel();

    expect(
      screen.getByRole('heading', {
        name: 'Choose a form, document, or custom link to generate a QR code',
      }),
    ).toBeInTheDocument();
  });

  it('warns that sharing must be enabled while a form or document is the target', () => {
    renderPanel({ selectedId: 'f-1' });

    expect(screen.getByText(/sharing feature is enabled/)).toBeInTheDocument();
  });

  it('drops that warning once the custom URL option is chosen', () => {
    renderPanel({ selectedId: CUSTOM });

    expect(screen.queryByText(/sharing feature is enabled/)).not.toBeInTheDocument();
  });
});

describe('QrGeneratorSourcePanel source picker', () => {
  it('offers a combobox for the source', () => {
    renderPanel();

    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('reports its collapsed state', () => {
    renderPanel({ comboOpen: false });

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists every form and document once opened', async () => {
    renderPanel({ comboOpen: true });

    expect(await screen.findByRole('option', { name: /Intake Form/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Care Plan/ })).toBeInTheDocument();
  });

  it('offers the custom URL option alongside them', async () => {
    renderPanel({ comboOpen: true });

    expect(await screen.findByRole('option', { name: /Custom URL/ })).toBeInTheDocument();
  });

  it('reports the item that was chosen and clears any custom URL', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ comboOpen: true });

    await user.click(await screen.findByRole('option', { name: /Intake Form/ }));

    expect(props.setSelectedId).toHaveBeenCalledWith('f-1');
    expect(props.setCustomUrl).toHaveBeenCalledWith('');
    expect(props.setComboOpen).toHaveBeenCalledWith(false);
  });

  it('switches to the custom URL mode when that option is chosen', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ comboOpen: true });

    await user.click(await screen.findByRole('option', { name: /Custom URL/ }));

    expect(props.setSelectedId).toHaveBeenCalledWith(CUSTOM);
  });

  it('filters the list as the user searches', async () => {
    const user = userEvent.setup();
    renderPanel({ comboOpen: true });

    await user.type(await screen.findByPlaceholderText(/Search by name/), 'care');

    expect(screen.getByRole('option', { name: /Care Plan/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Intake Form/ })).not.toBeInTheDocument();
  });

  it('keeps the Custom URL row available even when no item matches', async () => {
    // filterFormDocumentRows always keeps the custom row, so the empty state
    // never appears — the user can always fall back to pasting a link.
    const user = userEvent.setup();
    renderPanel({ comboOpen: true });

    await user.type(await screen.findByPlaceholderText(/Search by name/), 'zzzz');

    expect(screen.getByRole('option', { name: /Custom URL/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Intake Form/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Care Plan/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No form or document matches your search.'))
      .not.toBeInTheDocument();
  });
});

describe('QrGeneratorSourcePanel clear selection', () => {
  it('is absent while nothing is selected', () => {
    renderPanel({ selectedId: '' });

    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
  });

  it('appears once something is selected', () => {
    renderPanel({ selectedId: 'f-1' });

    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
  });

  it('clears both the selection and the custom URL', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ selectedId: CUSTOM, customUrl: 'https://a.example.com' });

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(props.setSelectedId).toHaveBeenCalledWith('');
    expect(props.setCustomUrl).toHaveBeenCalledWith('');
  });
});

describe('QrGeneratorSourcePanel custom URL field', () => {
  it('is hidden until the custom option is chosen', () => {
    renderPanel({ selectedId: 'f-1' });

    expect(screen.queryByLabelText('Link to encode in QR code')).not.toBeInTheDocument();
  });

  it('appears with its instructions once chosen', () => {
    renderPanel({ selectedId: CUSTOM });

    expect(screen.getByLabelText('Link to encode in QR code')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Copy the Link' })).toBeInTheDocument();
  });

  it('shows the current custom URL', () => {
    renderPanel({ selectedId: CUSTOM, customUrl: 'https://a.example.com' });

    expect(screen.getByLabelText('Link to encode in QR code'))
      .toHaveValue('https://a.example.com');
  });

  it('reports what the user types', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ selectedId: CUSTOM });

    await user.type(screen.getByLabelText('Link to encode in QR code'), 'h');

    expect(props.setCustomUrl).toHaveBeenCalledWith('h');
  });
});

describe('QrGeneratorSourcePanel logo option', () => {
  it('is enabled when the business has a logo', () => {
    renderPanel({ business: { squareLogo: 'square.png' } });

    expect(screen.getByRole('checkbox', { name: /business logo/ })).toBeEnabled();
  });

  it('is disabled with an explanation when the business has none', () => {
    renderPanel({ business: {} });

    expect(screen.getByRole('checkbox', { name: /business logo/ })).toBeDisabled();
    expect(screen.getByText(/No business logo available/)).toBeInTheDocument();
  });

  it('is disabled when there is no business at all', () => {
    renderPanel({ business: undefined });

    expect(screen.getByRole('checkbox', { name: /business logo/ })).toBeDisabled();
  });

  it('hides the explanation when a logo exists', () => {
    renderPanel({ business: { wideLogo: 'wide.png' } });

    expect(screen.queryByText(/No business logo available/)).not.toBeInTheDocument();
  });

  it('reports the new value when ticked', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByRole('checkbox', { name: /business logo/ }));

    expect(props.setDrawLogo).toHaveBeenCalledWith(true);
  });

  it('reflects the current value', () => {
    renderPanel({ drawLogo: true });

    expect(screen.getByRole('checkbox', { name: /business logo/ })).toBeChecked();
  });
});

describe('QrGeneratorSourcePanel generate button', () => {
  it('is disabled while nothing is selected', () => {
    renderPanel({ selectedId: '' });

    expect(screen.getByRole('button', { name: /Generate QR Code/ })).toBeDisabled();
  });

  it('is disabled on the custom option until a URL is typed', () => {
    renderPanel({ selectedId: CUSTOM, customUrl: '' });

    expect(screen.getByRole('button', { name: /Generate QR Code/ })).toBeDisabled();
  });

  it('is enabled once a custom URL is present', () => {
    renderPanel({ selectedId: CUSTOM, customUrl: 'https://a.example.com' });

    expect(screen.getByRole('button', { name: /Generate QR Code/ })).toBeEnabled();
  });

  it('is enabled once a form is selected', () => {
    renderPanel({ selectedId: 'f-1' });

    expect(screen.getByRole('button', { name: /Generate QR Code/ })).toBeEnabled();
  });

  it('generates when pressed', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ selectedId: 'f-1' });

    await user.click(screen.getByRole('button', { name: /Generate QR Code/ }));

    expect(props.generateQRCode).toHaveBeenCalledTimes(1);
  });

  it('shows progress and locks out while generating', () => {
    renderPanel({ selectedId: 'f-1', generating: true });

    expect(screen.getByRole('button', { name: /Generating QR Code/ })).toBeDisabled();
  });
});
