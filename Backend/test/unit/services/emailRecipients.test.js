// Backend/test/unit/services/emailRecipients.test.js
//
// KAN-272: this module turns a participant's ISO+ profile into a real
// mailbox. Before this ticket it also took a `recipientType` argument sourced
// from a per-workspace "Recipient" setting (billing_contact |
// client_participant), which meant a workspace could have a Billing Email on
// file and still have every invoice mailed to the participant because the
// setting said "Client/Participant". `recipientType` is gone: the mailbox is
// now derived purely from whether the profile has a Billing Email — Case
// A/AA/B, the same rule invoiceRecipientHelpers.js applies to PDF content, so
// mailbox selection and PDF content can never disagree.
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
    });

    // No Billing Email and no named Billing Contact — an ordinary,
    // self-managed participant, resolved by Case B.
    expect(result).toEqual({ address: 'jane@example.com', source: 'profile_email_billing_fallback' });
  });

  it('matches the profile by Preferred Name', async () => {
    await seedProfile({
      'Preferred Name': 'Davo',
      Email: 'david@example.com',
    });

    const result = await resolveRecipient({ workspaceId: WS, participant: 'Davo' });
    expect(result.address).toBe('david@example.com');
  });

  it('matches the profile by First Name + Last Name', async () => {
    await seedProfile({
      'First Name': 'Nina',
      'Last Name': 'Patel',
      Email: 'nina.patel@example.com',
    });

    const result = await resolveRecipient({ workspaceId: WS, participant: 'Nina Patel' });
    expect(result.address).toBe('nina.patel@example.com');
  });

  describe('Case A/AA: a Billing Email is on file', () => {
    it('sends to the Billing Email, not the participant Email', async () => {
      await seedProfile({
        'Full Name/Preferred Name': 'Jane Smith',
        Email: 'jane@example.com',
        'Billing Contact': 'Nominee Nora',
        'Billing Email': 'nora@plan-manager.example.com',
      });

      const result = await resolveRecipient({ workspaceId: WS, participant: 'Jane Smith' });

      expect(result).toEqual({
        address: 'nora@plan-manager.example.com',
        source: 'profile_billing_email',
      });
    });

    // KAN-272 live evidence (workspace 55369, "Masoud Test"): a non-empty
    // Billing Email was present and available yet ignored, purely because a
    // per-workspace "Recipient" setting said Client/Participant. That setting
    // no longer exists and no longer has anything to pass here — Billing
    // Email presence alone decides, for every call.
    it('sends to the Billing Email regardless of any recipientType argument a caller might still pass', async () => {
      await seedProfile({
        'Full Name/Preferred Name': 'Masoud Test',
        Email: 'masoud+participant@isoconsultingservices.com.au',
        'Billing Contact': 'Billing Team',
        'Billing Email': 'masoud+billing@isoconsultingservices.com.au',
      });

      const result = await resolveRecipient({
        workspaceId: WS,
        participant: 'Masoud Test',
        // A stale caller might still pass this; it must have no effect.
        recipientType: 'client_participant',
      });

      expect(result.address).toBe('masoud+billing@isoconsultingservices.com.au');
    });

    // Case AA: Billing Email present but no Billing Contact named is still
    // Case A/AA territory (the mailbox is the Billing Email either way) —
    // this module only resolves the address, not the printed name, so there
    // is nothing else to characterize here beyond "the Billing Email wins".
    it('sends to the Billing Email even when no Billing Contact is named', async () => {
      await seedProfile({
        'Full Name/Preferred Name': 'Jane Smith',
        Email: 'jane@example.com',
        'Billing Email': 'billing@example.com',
      });

      const result = await resolveRecipient({ workspaceId: WS, participant: 'Jane Smith' });
      expect(result.address).toBe('billing@example.com');
    });
  });

  describe('Case B: no Billing Email on file', () => {
    it('falls back to the participant Email when nobody else is nominated', async () => {
      await seedProfile({
        'Full Name/Preferred Name': 'Self Managed Sam',
        Email: 'sam@example.com',
      });

      const result = await resolveRecipient({ workspaceId: WS, participant: 'Self Managed Sam' });

      expect(result).toEqual({
        address: 'sam@example.com',
        source: 'profile_email_billing_fallback',
      });
    });

    // KAN-272 changed this: the old `billing_contact` dropdown value refused
    // to fall back here (`billing_contact_has_no_address`), because a manual
    // choice of "Billing Contact" meant sending to the participant was
    // choosing a different person than configured. That manual choice is
    // gone — Case B always falls back to the participant's own Email now,
    // even when a Billing Contact is named without an address of their own.
    it('falls back to the participant Email even when a Billing Contact is named but has no address', async () => {
      await seedProfile({
        'Full Name/Preferred Name': 'Jane Smith',
        Email: 'jane@example.com',
        'Billing Contact': 'Nominee Nora',
      });

      const result = await resolveRecipient({ workspaceId: WS, participant: 'Jane Smith' });

      // A distinct source from the "nobody nominated" fallback above: this
      // profile's billing setup looks incomplete (someone is named) rather
      // than simply self-managed, which is worth a run seeing even though the
      // mailbox resolved is the same.
      expect(result).toEqual({
        address: 'jane@example.com',
        source: 'profile_email_billing_contact_unaddressed',
      });
    });

    it('treats a whitespace-only Billing Email as no Billing Email', async () => {
      await seedProfile({
        'Full Name/Preferred Name': 'Jane Smith',
        Email: 'jane@example.com',
        'Billing Email': '   ',
      });

      const result = await resolveRecipient({ workspaceId: WS, participant: 'Jane Smith' });
      expect(result.address).toBe('jane@example.com');
    });
  });

  it('returns a reason when no profile exists for the participant', async () => {
    const result = await resolveRecipient({ workspaceId: WS, participant: 'Nobody At All' });
    expect(result).toEqual({ address: null, reason: 'profile_not_found' });
  });

  it('returns a reason when the profile carries no address', async () => {
    await seedProfile({ 'Full Name/Preferred Name': 'Emailless Eve' });

    const result = await resolveRecipient({ workspaceId: WS, participant: 'Emailless Eve' });
    expect(result).toEqual({ address: null, reason: 'no_address_on_profile' });
  });

  it('treats a malformed stored address as no address rather than sending to it', async () => {
    await seedProfile({
      'Full Name/Preferred Name': 'Typo Tim',
      Email: 'tim@@example',
    });

    const result = await resolveRecipient({ workspaceId: WS, participant: 'Typo Tim' });
    expect(result).toEqual({ address: null, reason: 'malformed_address' });
  });

  it('returns a reason for an unattributable group with no participant name', async () => {
    const result = await resolveRecipient({ workspaceId: WS, participant: null });
    expect(result).toEqual({ address: null, reason: 'no_participant_name' });
  });

  it('never matches a same-named participant in another workspace', async () => {
    await seedProfile(
      { 'Full Name/Preferred Name': 'Jane Smith', Email: 'other-tenant@example.com' },
      { workspaceId: 'ws-other' },
    );

    const result = await resolveRecipient({ workspaceId: WS, participant: 'Jane Smith' });
    expect(result).toEqual({ address: null, reason: 'profile_not_found' });
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
    });

    expect(result.address).toBe('jane@example.com');
  });

  it('does not throw when the participant name is not a plain string', async () => {
    const result = await resolveRecipient({ workspaceId: WS, participant: { $ne: null } });
    expect(result).toEqual({ address: null, reason: 'no_participant_name' });
  });
});
