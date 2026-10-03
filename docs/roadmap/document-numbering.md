# Document numbering

Follow-ups to letting the user choose the first document numbers (KAN-292, PR
#953), in the order we expect to take them. Each came out of the independent
review of that PR, which fixed the data-safety findings and left these.

## 1. Bound the first numbers in the API

**Today.** `hasAllInitialNumbers` (`Backend/src/utils/documentNumberingInitial.js`)
accepts any whole number of 1 or more by `Number.isInteger`. `9007199254740993`
parses to 2^53 and passes; from there `claimDocumentNumber`'s `$add 1` cannot
move past it, so every invoice would get the same number. `1e21` passes and
renders as `INV-1e+21`. The form checks `Number.isSafeInteger`, so this is only
reachable by calling the API directly, but before KAN-292 a `nextNumber` sent to
the API was ignored on every path, so it is new surface.

**Wanted.** `Number.isSafeInteger` plus a sane maximum (9 or 10 digits) and its
own error message, in `hasAllInitialNumbers` and the validator.

## 2. Quote and purchase-order numbers still race (KAN-291)

The quote and purchase-order generators read the counter, increment it and
`save()`. A quote or purchase order being generated during the very first
Finance Settings save can still overwrite the number the user chose. Invoices,
statements and statements of account claim atomically and are not affected.
KAN-291 is the fix; this ticket depends on it for the last gap.

## 3. Correcting a mistyped first number

The choice is one-time, so a typo has no way back except a manual change to the
database, which the repo rules forbid. Wanted: a confirm step before the first
save that repeats the numbers back ("Your next invoice will be INV-1001"), and
an owner or support-admin path to correct a number that has not yet been used.

## 4. Smaller items from the same review

- The preview under each field is built from the raw typed text, so `007`
  previews `INV-007` (stored as 7) and `1e3` previews `INV-1e3`. Show the
  preview only for the parsed value, and name the problem when a value is too
  large instead of "1 or more".
- Before the profile has loaded, or when the load fails, the form's initial state
  is "not set", so it shows editable fields and the "cannot be changed" text.
  Saving is still blocked (the company name is empty), so this is cosmetic.
- Run the Playwright tests in `Frontend/e2e/business-configuration.spec.ts`
  (this ticket's first-numbers test and the KAN-290 read-only test). Neither has
  been run.
