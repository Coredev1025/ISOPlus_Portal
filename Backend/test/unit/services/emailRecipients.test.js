// Backend/test/unit/services/emailRecipients.test.js
//
// AutomationSettings stores the recipient as a *type*, never an address. This
// is the module that turns the type plus a participant display name into a
// real mailbox, by reading the participant-profile Item in the Intake Register.
//
// The tests that matter most here are the negative ones: an automation that
// mails the wrong person is worse than one that mails nobody, so every path
// that cannot find an address must return a reason rather than a guess.

import { describe, it, expect } from 'vitest';

import Item from '../../../src/models/Item.js';
import { resolveRecipient } from '../../../src/services/email/recipients.js';

const WS = 'ws-recip';
const BOARD = 'board-intake';

let nextItemId = 0;

async function seedProfile(data, overrides = {}) {
  nextItemId += 1;
  return Item.create({
    workspaceId: WS,
    boardId: BOARD,
    folderId: 'f-profiles',
    itemId: `profile-${nextItemId}`,
    data,
    ...overrides,
  });
}

describe('resolveRecipient', () => {
  it('matches the profile by Full Name/Preferred Name and returns the participant Email', async () => {
    await seedProfile({
      'Full Name/Preferred Name': 'Jane Smith',
      Email: 'jane@example.com',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      boardId: BOARD,
      participant: 'Jane Smith',
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: 'jane@example.com', source: 'profile_email' });
  });

  it('matches the profile by Preferred Name', async () => {
    await seedProfile({
      'Preferred Name': 'Davo',
      Email: 'david@example.com',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Davo',
      recipientType: 'client_participant',
    });

    expect(result.address).toBe('david@example.com');
  });

  it('matches the profile by First Name + Last Name', async () => {
    await seedProfile({
      'First Name': 'Nina',
      'Last Name': 'Patel',
      Email: 'nina.patel@example.com',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Nina Patel',
      recipientType: 'client_participant',
    });

    expect(result.address).toBe('nina.patel@example.com');
  });

  it('billing_contact returns the Billing Email, not the participant Email', async () => {
    await seedProfile({
      'Full Name/Preferred Name': 'Jane Smith',
      Email: 'jane@example.com',
      'Billing Contact': 'Nominee Nora',
      'Billing Email': 'nora@plan-manager.example.com',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Jane Smith',
      recipientType: 'billing_contact',
    });

    expect(result).toEqual({
      address: 'nora@plan-manager.example.com',
      source: 'profile_billing_email',
    });
  });

  it('billing_contact falls back to the participant Email only when nobody else is nominated', async () => {
    await seedProfile({
      'Full Name/Preferred Name': 'Self Managed Sam',
      Email: 'sam@example.com',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Self Managed Sam',
      recipientType: 'billing_contact',
    });

    expect(result).toEqual({
      address: 'sam@example.com',
      source: 'profile_email_billing_fallback',
    });
  });

  it('billing_contact refuses to fall back when a third party is the named billing contact', async () => {
    // The dangerous case: someone else is on the hook for billing, but nobody
    // filled in their address. Falling through to the participant here sends
    // the invoice to a person the configuration deliberately did not choose.
    await seedProfile({
      'Full Name/Preferred Name': 'Jane Smith',
      Email: 'jane@example.com',
      'Billing Contact': 'Nominee Nora',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Jane Smith',
      recipientType: 'billing_contact',
    });

    expect(result.address).toBeNull();
    expect(result.reason).toBe('billing_contact_has_no_address');
  });

  it('returns a reason when no profile exists for the participant', async () => {
    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Nobody At All',
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: null, reason: 'profile_not_found' });
  });

  it('returns a reason when the profile carries no address', async () => {
    await seedProfile({ 'Full Name/Preferred Name': 'Emailless Eve' });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Emailless Eve',
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: null, reason: 'no_address_on_profile' });
  });

  it('treats a malformed stored address as no address rather than sending to it', async () => {
    await seedProfile({
      'Full Name/Preferred Name': 'Typo Tim',
      Email: 'tim@@example',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Typo Tim',
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: null, reason: 'malformed_address' });
  });

  it('returns a reason for an unattributable group with no participant name', async () => {
    const result = await resolveRecipient({
      workspaceId: WS,
      participant: null,
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: null, reason: 'no_participant_name' });
  });

  it('never matches a same-named participant in another workspace', async () => {
    await seedProfile(
      { 'Full Name/Preferred Name': 'Jane Smith', Email: 'other-tenant@example.com' },
      { workspaceId: 'ws-other' },
    );

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Jane Smith',
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: null, reason: 'profile_not_found' });
  });

  it('refuses an unknown recipient type instead of picking an address for it', async () => {
    await seedProfile({
      'Full Name/Preferred Name': 'Jane Smith',
      Email: 'jane@example.com',
    });

    const result = await resolveRecipient({
      workspaceId: WS,
      participant: 'Jane Smith',
      recipientType: 'accounts_payable',
    });

    expect(result).toEqual({ address: null, reason: 'unsupported_recipient_type' });
  });

  it('prefers a profile on the caller\'s board when the same name exists twice in the workspace', async () => {
    await seedProfile(
      { 'Full Name/Preferred Name': 'Jane Smith', Email: 'wrong-board@example.com' },
      { boardId: 'board-elsewhere' },
    );
    await seedProfile({ 'Full Name/Preferred Name': 'Jane Smith', Email: 'jane@example.com' });

    const result = await resolveRecipient({
      workspaceId: WS,
      boardId: BOARD,
      participant: 'Jane Smith',
      recipientType: 'client_participant',
    });

    expect(result.address).toBe('jane@example.com');
  });

  it('does not throw when the participant name is not a plain string', async () => {
    const result = await resolveRecipient({
      workspaceId: WS,
      participant: { $ne: null },
      recipientType: 'client_participant',
    });

    expect(result).toEqual({ address: null, reason: 'no_participant_name' });
  });
});
