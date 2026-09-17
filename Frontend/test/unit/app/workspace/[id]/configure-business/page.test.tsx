import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../../../msw/server';
import { ContextProvider, useAppContext } from '@/app/context';
import {
  installBrowserStubs,
  makeRouter,
  stubChromeRequests,
  seedContextStorage,
  SUPPORT_ADMIN,
} from '../../../page-test-utils';
import ConfigureBusinessPage from '@/app/workspace/[id]/configure-business/page';
import { dismissAllToasts } from '@/lib/toast-utils';
import * as toastUtils from '@/lib/toast-utils';

/**
 * The business profile form loads `/api/business/profile`, pulls each stored
 * logo down through the authenticated image route (never a presigned URL), and
 * saves everything back as one multipart PUT.
 *
 * Bank details and document numbering UI live under Finance Settings; this page
 * still loads and re-sends those sequences on save so a Basic Info save does
 * not clear Financial Settings. Number-sequence dialog coverage belongs with
 * the finance-settings panel tests.
 *
 * It has no client-side validation at all: every field is submitted as typed
 * and the only errors shown are the ones the server sends back.
 */

installBrowserStubs();

const router = makeRouter();
const PATHNAME = '/workspace/ws-1/configure-business';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => PATHNAME,
  useSearchParams: () => new URLSearchParams(),
}));

const PROFILE = {
  name: 'Hillsgrade Care',
  phone: '02 5550 1234',
  email: 'accounts@hillsgrade.example',
  companyRegistrationId: 'NDIS-4050001234',
  address: {
    street: '12 Ridge Road',
    country: 'Australia',
    suburb: 'Katoomba',
    state: 'New South Wales',
    postcode: '2780',
  },
  abn: '51824753556',
  acn: '004085616',
  bankDetails: {
    accountName: 'Hillsgrade Care Pty Ltd',
    bankName: 'Westpac',
    bsb: '032002',
    accountNumber: '123456',
    paymentReference: 'HG-REF',
    accountsReceivableTerms: '14 days',
    accountsPayableTerms: '30 days',
  },
  headOfficeTimezone: 'Australia/Brisbane',
  documentNumbering: {
    invoice: { prefix: 'HG-INV-', nextNumber: 2400 },
    purchaseOrder: { prefix: 'HG-PO-', nextNumber: 300 },
    quote: { prefix: 'HG-QT-', nextNumber: 12 },
  },
  defaultLogo: 'ws-1/logos/default.png',
  squareLogo: '',
  wideLogo: '',
};

/** Every field the form owns, exactly as it should reach the backend. */
const EXPECTED_FIELDS = {
  name: 'Hillsgrade Care',
  phone: '02 5550 1234',
  email: 'accounts@hillsgrade.example',
  companyRegistrationId: 'NDIS-4050001234',
  street: '12 Ridge Road',
  country: 'Australia',
  suburb: 'Katoomba',
  state: 'New South Wales',
  postcode: '2780',
  abn: '51824753556',
  acn: '004085616',
  workspaceId: 'ws-1',
  bankAccountName: 'Hillsgrade Care Pty Ltd',
  bankName: 'Westpac',
  bsb: '032002',
  accountNumber: '123456',
  paymentReference: 'HG-REF',
  accountsReceivableTerms: '14 days',
  accountsPayableTerms: '30 days',
  headOfficeTimezone: 'Australia/Brisbane',
};

let profileRequests: string[] = [];
let logoRequests: string[] = [];
let savedForms: Record<string, unknown>[] = [];

function stubBusiness(options: {
  profile?: Record<string, unknown>;
  profileStatus?: number;
  saveStatus?: number;
  saveBody?: Record<string, unknown>;
} = {}) {
  server.use(
    http.get('*/api/business/profile', ({ request }) => {
      profileRequests.push(request.url);
      if (options.profileStatus && options.profileStatus !== 200) {
        return HttpResponse.json(
          { message: 'Business profile unavailable' },
          { status: options.profileStatus },
        );
      }
      return HttpResponse.json(options.profile ?? PROFILE);
    }),
    http.get('*/api/business/logo-image', ({ request }) => {
      logoRequests.push(request.url);
      return new HttpResponse(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      });
    }),
    http.put('*/api/business/profile', async ({ request }) => {
      const form = await request.formData();
      savedForms.push(Object.fromEntries(form.entries()));
      if (options.saveStatus && options.saveStatus !== 200) {
        return HttpResponse.json(
          options.saveBody ?? { message: 'Save rejected' },
          { status: options.saveStatus },
        );
      }
      return HttpResponse.json({
        defaultLogo: (options.profile ?? PROFILE).defaultLogo,
        squareLogo: '',
        wideLogo: '',
      });
    }),
  );
}

function WorkspaceIdProbe() {
  const { currentWorkspaceId } = useAppContext();
  return <div data-testid="ws-id">{currentWorkspaceId ?? 'null'}</div>;
}

function renderPage() {
  return render(
    <ContextProvider>
      <WorkspaceIdProbe />
      <ConfigureBusinessPage />
    </ContextProvider>,
  );
}

/** Switch to the tab holding bank details and document numbering — removed;
 * those controls now live under Finance Settings. Kept as a no-op guard so
 * accidental reintroduction of the tab fails loudly here. */
async function expectNoAdditionalSettingsTab() {
  expect(
    screen.queryByRole('tab', { name: 'Additional Settings' }),
  ).not.toBeInTheDocument();
}

/** userEvent.click is too slow on this 1000-line tree under a contended suite
 * (pointer hover + full rerender) and can leave the PUT in flight when the
 * next test starts — that leaked request is what made `savedForms` look like
 * a double submit. fireEvent hits the same onClick without the extra work. */
function clickSave() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Save Changes' }),
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.values(router).forEach((fn) => fn.mockClear());
  profileRequests = [];
  logoRequests = [];
  savedForms = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedContextStorage(SUPPORT_ADMIN, [
    { id: 'ws-1', name: 'Hillsgrade Care', user_role: 'owner' },
  ]);
  stubChromeRequests(SUPPORT_ADMIN);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});


// Removing the toastify nodes does not cancel the dismiss timer toastify-js
// schedules for each one. When that timer fires after jsdom has been torn down
// it throws `ReferenceError: document is not defined` as an unhandled error,
// failing the run even though every assertion passed. Dismissing through the
// app's own API clears the timers too.
afterEach(() => {
  dismissAllToasts();
});

describe('configure business page', () => {
  it('loads the business profile for the workspace id in the pathname', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    const url = new URL(profileRequests[0]);
    expect(url.pathname.endsWith('/api/business/profile')).toBe(true);
    // pathname is /workspace/ws-1/configure-business -> split('/')[2] === 'ws-1'
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
  });

  it('fills every text field from the stored profile', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });
    expect(screen.getByLabelText('Company Registration ID')).toHaveValue(
      'NDIS-4050001234',
    );
    expect(screen.getByLabelText('Phone Number')).toHaveValue('02 5550 1234');
    expect(screen.getByLabelText('Business Email')).toHaveValue(
      'accounts@hillsgrade.example',
    );
    expect(screen.getByLabelText('Street Address')).toHaveValue('12 Ridge Road');
    expect(screen.getByLabelText('Suburb')).toHaveValue('Katoomba');
    expect(screen.getByLabelText('Postcode')).toHaveValue('2780');
    expect(screen.getByLabelText(/Australian Business Number/)).toHaveValue(
      '51824753556',
    );
    expect(screen.getByLabelText(/Australian Company Number/)).toHaveValue(
      '004085616',
    );

    // Bank / document numbering UI moved to Finance Settings (Epic 1 / 3).
    await expectNoAdditionalSettingsTab();
    expect(screen.queryByLabelText('Bank Name')).not.toBeInTheDocument();
    expect(screen.queryByText(/Next invoice will be:/)).not.toBeInTheDocument();
  });

  it('pulls each stored logo through the authenticated image route and previews it', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => expect(logoRequests).toHaveLength(1));
    const url = new URL(logoRequests[0]);
    expect(url.pathname.endsWith('/api/business/logo-image')).toBe(true);
    expect(url.searchParams.get('workspaceId')).toBe('ws-1');
    // Only defaultLogo is set on the profile, so only it is fetched.
    expect(url.searchParams.get('logoKey')).toBe('defaultLogo');

    expect(
      await screen.findByAltText('Default Logo Preview'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove Default Logo' }),
    ).toBeInTheDocument();
  });

  it('fetches no logo image and shows no preview when the business has no logos', async () => {
    stubBusiness({
      profile: { ...PROFILE, defaultLogo: '', squareLogo: '', wideLogo: '' },
    });
    renderPage();

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });
    expect(logoRequests).toHaveLength(0);
    expect(screen.queryByAltText('Default Logo Preview')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove Default Logo' }),
    ).not.toBeInTheDocument();
  });

  it('leaves the form empty and logs when the profile cannot be loaded', async () => {
    const toastSpy = vi.spyOn(toastUtils, 'showFetchErrorToast');
    stubBusiness({ profileStatus: 500 });
    renderPage();

    await waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        'Failed to fetch business profile:',
        expect.anything(),
      );
    });
    expect(toastSpy).toHaveBeenCalledWith(
      'business profile',
      'Business profile unavailable',
    );
    expect(screen.getByLabelText('Company Name')).toHaveValue('');
    expect(screen.getByLabelText('Business Email')).toHaveValue('');
    // The untouched default the component ships with.
    expect(logoRequests).toHaveLength(0);
  });

  it('does not toast when the business profile is missing (404)', async () => {
    const toastSpy = vi.spyOn(toastUtils, 'showFetchErrorToast');
    stubBusiness({ profileStatus: 404 });
    renderPage();

    await waitFor(() => expect(profileRequests).toHaveLength(1));
    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('');
    });
    expect(toastSpy).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(
      'Failed to fetch business profile:',
      expect.anything(),
    );
    expect(logoRequests).toHaveLength(0);
  });

  it('shows all three logo upload sections side-by-side (no tabs)', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    // All three labels visible at once — not hidden behind tabs.
    expect(screen.getByRole('heading', { name: 'Default Logo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Square Logo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Wide Logo' })).toBeInTheDocument();

    const logoGrid = screen.getByTestId('company-logos-grid');
    expect(logoGrid.className).toMatch(/\bgrid\b/);
    expect(logoGrid.className).toMatch(/\bmd:grid-cols-3\b/);
    expect(logoGrid.className).toMatch(/\bitems-stretch\b/);

    // File picker button + "No file chosen" must stay on one line in each column.
    const fileInputs = logoGrid.querySelectorAll('input[type="file"]');
    expect(fileInputs).toHaveLength(3);
    fileInputs.forEach((input) => {
      expect(input.className).toMatch(/\bblock\b/);
      expect(input.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(input.className).toMatch(/\bw-full\b/);
    });

    // Equal-height columns so Choose File rows share one horizontal baseline.
    const columns = Array.from(logoGrid.children);
    expect(columns).toHaveLength(3);
    columns.forEach((column) => {
      expect(column.className).toMatch(/\bh-full\b/);
      expect(column.className).toMatch(/\bflex-col\b/);
    });
  });

  it('uses the full-width finance-settings page chrome and Save Changes label', async () => {
    stubBusiness();
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Business Settings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Manage your business details, address, and branding.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save Changes' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save Business Configuration' }),
    ).not.toBeInTheDocument();
  });

  it('saves every field as one multipart body carrying the workspace id and the numbering', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });
    clickSave();

    await waitFor(() => expect(savedForms).toHaveLength(1));
    const { documentNumbering, ...fields } = savedForms[0];
    expect(fields).toEqual(EXPECTED_FIELDS);
    expect(JSON.parse(String(documentNumbering))).toEqual({
      invoice: { prefix: 'HG-INV-', nextNumber: 2400 },
      purchaseOrder: { prefix: 'HG-PO-', nextNumber: 300 },
      quote: { prefix: 'HG-QT-', nextNumber: 12 },
      // Loaded default when the profile had no statement series yet.
      statement: { prefix: 'STM-', nextNumber: 1 },
      statementOfAccount: { prefix: 'SOA-', nextNumber: 1 },
    });
    // Nothing was uploaded or removed, so no logo keys ride along.
    expect(Object.keys(savedForms[0])).not.toContain('defaultLogo');
    expect(Object.keys(savedForms[0])).not.toContain('defaultLogoRemoved');

    expect(
      await screen.findByText('Business profile saved successfully!'),
    ).toBeInTheDocument();
  });

  it('submits an obviously invalid email unchanged — the form validates nothing client-side', async () => {
    stubBusiness({
      saveStatus: 400,
      saveBody: { errors: ['email must be a valid email address'] },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });

    // One change event rather than 12 keystrokes: this form re-renders its
    // whole 1000-line tree per keystroke, which is slow enough under load to
    // trip the default test timeout. The handler under test is the same one.
    fireEvent.change(screen.getByLabelText('Business Email'), {
      target: { value: 'not-an-email' },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Business Email')).toHaveValue('not-an-email');
    });

    clickSave();

    // The request went out with the bad value; the server is the only gate.
    await waitFor(() => expect(savedForms).toHaveLength(1));
    expect(savedForms[0].email).toBe('not-an-email');

    // The server's errors are listed, and nothing the user typed is lost.
    expect(
      await screen.findByText('Please correct the following errors:'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('email must be a valid email address'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Business Email')).toHaveValue('not-an-email');
    expect(
      screen.queryByText('Business profile saved successfully!'),
    ).not.toBeInTheDocument();
  });

  it('shows the server message when a failed save carries no field errors', async () => {
    stubBusiness({
      saveStatus: 500,
      saveBody: { message: 'Storage is temporarily unavailable' },
    });
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });
    clickSave();

    // Scoped to the page: the same wording is also the description of a toast
    // that Toastify appends straight to document.body.
    await waitFor(() => {
      expect(
        within(container).getByText('Storage is temporarily unavailable'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Please correct the following errors:'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save Changes' }),
    ).toBeEnabled();
  });

  it('no longer hosts document-number controls (moved to Finance Settings)', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });
    await expectNoAdditionalSettingsTab();
    expect(screen.queryByLabelText('Next Number', { selector: '#invoice-next' })).not.toBeInTheDocument();
    expect(screen.queryByText('Warning: Reducing Number Sequence')).not.toBeInTheDocument();
  });

  it('marks a removed logo in the next save and drops its preview', async () => {
    stubBusiness();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await screen.findByAltText('Default Logo Preview');
    await user.click(screen.getByRole('button', { name: 'Remove Default Logo' }));

    expect(screen.queryByAltText('Default Logo Preview')).not.toBeInTheDocument();

    clickSave();

    await waitFor(() => expect(savedForms).toHaveLength(1));
    expect(savedForms[0].defaultLogoRemoved).toBe('true');
    expect(Object.keys(savedForms[0])).not.toContain('squareLogoRemoved');
    expect(Object.keys(savedForms[0])).not.toContain('wideLogoRemoved');
  });

  it('goes back to the workspace this profile belongs to', async () => {
    stubBusiness();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Back to Workspace/ }));
    expect(router.replace).toHaveBeenCalledWith('/workspace/ws-1');
  });

  it('never publishes the workspace id to context', async () => {
    stubBusiness();
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText('Company Name')).toHaveValue('Hillsgrade Care');
    });
    expect(screen.getByTestId('ws-id')).toHaveTextContent('null');
  });
});
