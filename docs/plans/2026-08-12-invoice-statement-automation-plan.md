# Invoice & Statement Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client configure invoice and statement automation on the Finance Settings tab, and have a scheduler tick claim that schedule and enqueue one job per board — generating and sending nothing.

**Architecture:** Settings live in a new `AutomationSettings` document per workspace. `ScheduledJob` (from PR #855) gains an optional picker-shaped `schedule` alongside its cron, because cron cannot express "every 2 weeks" or "every 3 months from a start date". A tick claims the job, a handler fans out to every board in the workspace, and each enqueued job carries a dedupe key derived from the claimed slot so a retry cannot double-bill.

**Tech Stack:** Node 20+ ESM, Express, Mongoose/MongoDB, BullMQ + Redis, Next.js 15 App Router, shadcn/ui, **Vitest** + `supertest` + `mongodb-memory-server`, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-12-invoice-statement-automation-design.md`](../superpowers/specs/2026-08-12-invoice-statement-automation-design.md)
**Ticket:** KAN-10
**Branch:** `feature/KAN-10_invoice_statement_automation`

## Global Constraints

- **Cognitive complexity < 15 per file** (SonarJS S3776, `.eslintrc.complexity.cjs`). Extract into `utils/*Helpers.js` rather than nesting. Enforced in CI.
- **Backend is ESM** (`"type": "module"`): `node:` prefixes on built-ins, `.js` extensions on relative imports.
- **Test files must end `.test.js`** — `vitest.config.js` collects `test/**/*.test.js` only. A `.test.mjs` is silently collected as zero tests.
- **Write the failing test first.** Run it, watch it fail for the expected reason, then implement. Never weaken an assertion to reach green.
- **No new runtime dependencies.** Everything here uses what is already installed.
- **No AI attribution** in commits or PR bodies — no `Co-Authored-By`, no "Generated with" line.
- **Commit format:** `feat:` / `fix:` / `refactor:` / `docs:` / `test:`.
- **Do not use `console.log`** — use `src/utils/logger.js` (`info`/`warn`/`error`), passing `req` as the last argument where available.
- **PHASE 2 MUST NOT START until PR #855 is merged to `develop` and this branch is rebased onto it.**
- **This branch must not merge before #855.** Phase 1 alone ships a UI that configures automation which provably cannot fire.

---

## Erratum against the spec

The spec says we call #855's `upsertSchedule` rather than writing `ScheduledJob` directly. That remains true, **but `upsertSchedule` must be extended first** — it is cron-internal throughout:

```js
if (!isValidSchedule(cron, effectiveTimezone)) throw ...
assertMinimumInterval({ kind, cron, timezone: effectiveTimezone, now });
nextRunAt: computeNextRun(cron, effectiveTimezone, now)
```

Task 8 covers this. The spec's component table understates it as "call", where the work is "extend, then call".

**Second, smaller erratum:** `assertMinimumInterval` computes the floor from a cron expression. A picker schedule cannot violate it — the coarsest picker cadence is `{n: 1, unit: 'day'}` = 1440 minutes, against floors of 60 (`AT_MOST_ONCE`) and 5 (`AT_LEAST_ONCE`). Task 8 therefore skips the floor check for picker schedules, with that reasoning in a comment rather than silently.

---

## File Structure

### Phase 1 — settings layer (no dependency on #855)

| File | Responsibility |
|---|---|
| `Backend/src/models/AutomationSettings.js` | one document per workspace, two blocks |
| `Backend/src/utils/automationSettingsHelpers.js` | pure: parse, validate, defaults, response shaping |
| `Backend/src/routes/workspace.js` *(modify)* | `GET`/`PUT /:workspaceId/automation-settings` |
| `Frontend/lib/automation-settings.ts` | types, fetch, save |
| `Frontend/lib/automation-run-on-options.ts` | pure: `Run On` options per unit |
| `Frontend/lib/automation-schedule-block.tsx` | the five schedule fields |
| `Frontend/lib/automation-email-block.tsx` | recipient + email fields |
| `Frontend/lib/invoice-statement-automation-panel.tsx` | composes both blocks, twice |
| `Frontend/lib/finance-settings-page.tsx` *(modify)* | swap `PlaceholderPanel` for the real panel |

### Phase 2 — scheduler wiring (after #855 merges)

| File | Responsibility |
|---|---|
| `Backend/src/models/ScheduledJob.js` *(modify)* | optional `cron`, new `schedule`, XOR validator |
| `Backend/src/services/scheduler/schedules.js` *(modify)* | `upsertSchedule` accepts `schedule` |
| `Backend/src/services/scheduler/advance.js` | route cron vs picker to the right arithmetic |
| `Backend/src/utils/automationPeriodKey.js` | pure: stable key from the claimed slot |
| `Backend/src/services/redisConnection.js` | `buildRedisConnection()` for the new modules only |
| `Backend/src/services/automation/queue.js` | `automationQueue` |
| `Backend/src/services/automation/fanOut.js` | workspaceId → job specs |
| `Backend/src/services/scheduler/handlers.js` *(modify)* | register both kinds |
| `Backend/src/workers/automationWorker.js` | stub: drains, logs, sends nothing |
| `Backend/vitest.config.js` *(modify)* | coverage include |

### Locked names

Referenced across tasks; do not rename:

```
parseAutomationSettingsBody(body)        -> { error } | { value }
buildAutomationSettingsPayload(settings, jobs) -> object
DEFAULT_AUTOMATION_BLOCK                 -> object
automationPeriodKey({ slot, timezone })  -> string   e.g. "20260812-0900"
advanceSchedule(job, now)                -> Date
buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone }) -> array
AUTOMATION_QUEUE_NAME = 'automation'
KIND_INVOICE   = 'invoice_automation'
KIND_STATEMENT = 'statement_automation'
runOnOptionsForUnit(unit)                -> array   (Frontend)
```

---

# PHASE 1 — settings layer

## Task 1: `AutomationSettings` model

**Files:**
- Create: `Backend/src/models/AutomationSettings.js`
- Test: `Backend/test/unit/models/automationSettings.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: default export `AutomationSettings` (Mongoose model). Document shape: `{ workspaceId: String (unique), invoice: Block, statement: Block }` where `Block = { enabled: Boolean, every: { n: Number, unit: String }, runOn: Mixed, runAt: String, startDate: Date, sendMethod: String, recipient: String, sendCopyTo: String, replyTo: String, emailFrom: String, emailSubject: String, emailMessage: String, senderIdentityId: String|null }`

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/models/automationSettings.test.js
import { describe, it, expect } from 'vitest';
import AutomationSettings from '../../../src/models/AutomationSettings.js';

describe('AutomationSettings', () => {
  it('defaults both blocks to disabled with a daily cadence', () => {
    const doc = new AutomationSettings({ workspaceId: 'ws-1' });
    expect(doc.invoice.enabled).toBe(false);
    expect(doc.statement.enabled).toBe(false);
    expect(doc.invoice.every.n).toBe(1);
    expect(doc.invoice.every.unit).toBe('month');
    expect(doc.invoice.senderIdentityId).toBeNull();
  });

  it('rejects a unit outside the five allowed values', async () => {
    const doc = new AutomationSettings({
      workspaceId: 'ws-1',
      invoice: { every: { n: 1, unit: 'fortnight' } },
    });
    await expect(doc.validate()).rejects.toThrow(/unit/);
  });

  it('requires workspaceId', async () => {
    const doc = new AutomationSettings({});
    await expect(doc.validate()).rejects.toThrow(/workspaceId/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd Backend && npx vitest run test/unit/models/automationSettings.test.js`
Expected: FAIL — `Cannot find module '../../../src/models/AutomationSettings.js'`

- [ ] **Step 3: Implement the model**

```js
// Backend/src/models/AutomationSettings.js
import mongoose from 'mongoose';

export const AUTOMATION_UNITS = ['day', 'week', 'month', 'quarter', 'year'];
export const SEND_METHODS = ['isoplus', 'accounting'];
export const RECIPIENTS = ['billing_contact', 'client_participant'];

// runOn is Mixed because its type changes with the unit: a weekday name for
// week, a day number for month, and {month, day} for quarter/year. The
// unit-appropriate shape is enforced on the write path in
// automationSettingsHelpers, not here — a schema type cannot express it.
const blockSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, required: true, default: false },
    every: {
      n: { type: Number, required: true, default: 1, min: 1 },
      unit: { type: String, required: true, default: 'month', enum: AUTOMATION_UNITS },
    },
    runOn: { type: mongoose.Schema.Types.Mixed, default: 1 },
    runAt: { type: String, required: true, default: '09:00' },
    startDate: { type: Date, default: null },
    sendMethod: { type: String, required: true, default: 'isoplus', enum: SEND_METHODS },
    recipient: { type: String, required: true, default: 'billing_contact', enum: RECIPIENTS },
    sendCopyTo: { type: String, default: '' },
    replyTo: { type: String, default: '' },
    emailFrom: { type: String, default: '' },
    emailSubject: { type: String, default: '' },
    emailMessage: { type: String, default: '' },
    // Nullable now, per doc 2's phased sender plan, so phase 2 needs no migration.
    senderIdentityId: { type: String, default: null },
  },
  { _id: false },
);

const automationSettingsSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true, unique: true },
    invoice: { type: blockSchema, default: () => ({}) },
    statement: { type: blockSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export default mongoose.model('AutomationSettings', automationSettingsSchema);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd Backend && npx vitest run test/unit/models/automationSettings.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add Backend/src/models/AutomationSettings.js Backend/test/unit/models/automationSettings.test.js
git commit -m "feat: AutomationSettings model for invoice and statement blocks"
```

---

## Task 2: Settings helpers — parse, validate, shape

**Files:**
- Create: `Backend/src/utils/automationSettingsHelpers.js`
- Test: `Backend/test/unit/utils/automationSettingsHelpers.test.js`

**Interfaces:**
- Consumes: `AUTOMATION_UNITS`, `SEND_METHODS`, `RECIPIENTS` from `models/AutomationSettings.js`
- Produces:
  - `DEFAULT_AUTOMATION_BLOCK` — object
  - `parseAutomationSettingsBody(body)` → `{ error: string }` or `{ value: { invoice, statement } }`
  - `buildAutomationSettingsPayload(settings, jobs)` → `{ invoice, statement }` with `nextRun` merged in. `jobs` is `{ invoice_automation?: {nextRunAt}, statement_automation?: {nextRunAt} }`

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/utils/automationSettingsHelpers.test.js
import { describe, it, expect } from 'vitest';
import {
  parseAutomationSettingsBody,
  buildAutomationSettingsPayload,
  DEFAULT_AUTOMATION_BLOCK,
} from '../../../src/utils/automationSettingsHelpers.js';

const validBlock = {
  enabled: true,
  every: { n: 2, unit: 'week' },
  runOn: 'monday',
  runAt: '09:00',
  startDate: '2026-03-01',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
  sendCopyTo: 'a@b.com',
  replyTo: 'c@d.com',
};

describe('parseAutomationSettingsBody', () => {
  it('accepts a valid weekly block', () => {
    const result = parseAutomationSettingsBody({ invoice: validBlock });
    expect(result.error).toBeUndefined();
    expect(result.value.invoice.every.unit).toBe('week');
  });

  it('rejects an unknown unit', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'fortnight' } },
    });
    expect(result.error).toMatch(/unit/);
  });

  it('rejects a weekday runOn when the unit is month', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'month' }, runOn: 'monday' },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('rejects a month runOn above 28', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'month' }, runOn: 31 },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('rejects a malformed runAt', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, runAt: '9am' },
    });
    expect(result.error).toMatch(/runAt/);
  });

  it('rejects a malformed sendCopyTo', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, sendCopyTo: 'not-an-email' },
    });
    expect(result.error).toMatch(/sendCopyTo/);
  });

  it('applies defaults for a missing block', () => {
    const result = parseAutomationSettingsBody({ invoice: validBlock });
    expect(result.value.statement).toEqual(DEFAULT_AUTOMATION_BLOCK);
  });

  it('does not validate schedule fields of a disabled block', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, enabled: false, runAt: 'nonsense' },
    });
    expect(result.error).toBeUndefined();
  });
});

describe('buildAutomationSettingsPayload', () => {
  it('merges nextRunAt from the linked job as read-only nextRun', () => {
    const when = new Date('2026-08-12T09:00:00+10:00');
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: true }, statement: { enabled: false } },
      { invoice_automation: { nextRunAt: when } },
    );
    expect(payload.invoice.nextRun).toEqual(when);
    expect(payload.statement.nextRun).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd Backend && npx vitest run test/unit/utils/automationSettingsHelpers.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helpers**

Keep each function small; the complexity gate is 15 per file.

```js
// Backend/src/utils/automationSettingsHelpers.js
import {
  AUTOMATION_UNITS,
  SEND_METHODS,
  RECIPIENTS,
} from '../models/AutomationSettings.js';

export const DEFAULT_AUTOMATION_BLOCK = {
  enabled: false,
  every: { n: 1, unit: 'month' },
  runOn: 1,
  runAt: '09:00',
  startDate: null,
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
  sendCopyTo: '',
  replyTo: '',
  emailFrom: '',
  emailSubject: '',
  emailMessage: '',
  senderIdentityId: null,
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const RUN_AT = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Deliberately loose: a full RFC 5322 check rejects addresses that work. The
// authoritative check is SES rejecting it at send time.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRunOn(unit, runOn) {
  if (unit === 'day') return null;
  if (unit === 'week') {
    return WEEKDAYS.includes(String(runOn).toLowerCase())
      ? null
      : `runOn must be a weekday name when unit is "week"`;
  }
  if (unit === 'month') {
    // 1-28 only: a schedule on the 29th-31st silently skips short months,
    // which for invoicing means a client is simply not billed that month.
    return Number.isInteger(runOn) && runOn >= 1 && runOn <= 28
      ? null
      : `runOn must be an integer between 1 and 28 when unit is "month"`;
  }
  const ok = runOn && Number.isInteger(runOn.month) && Number.isInteger(runOn.day);
  return ok ? null : `runOn must be {month, day} when unit is "${unit}"`;
}

function validateEmails(block) {
  for (const field of ['sendCopyTo', 'replyTo', 'emailFrom']) {
    const value = block[field];
    if (value && !EMAIL.test(value)) return `${field} must be a valid email address`;
  }
  return null;
}

function validateBlock(name, block) {
  // A disabled block is not validated: a client who turns automation off
  // should not be blocked by a field they are no longer using.
  if (!block.enabled) return null;

  const { unit, n } = block.every ?? {};
  if (!AUTOMATION_UNITS.includes(unit)) {
    return `${name}: every.unit must be one of ${AUTOMATION_UNITS.join(', ')}`;
  }
  if (!Number.isInteger(n) || n < 1) return `${name}: every.n must be a positive integer`;
  if (!RUN_AT.test(String(block.runAt ?? ''))) return `${name}: runAt must be HH:MM`;
  if (!SEND_METHODS.includes(block.sendMethod)) return `${name}: invalid sendMethod`;
  if (!RECIPIENTS.includes(block.recipient)) return `${name}: invalid recipient`;

  const runOnError = validateRunOn(unit, block.runOn);
  if (runOnError) return `${name}: ${runOnError}`;

  const emailError = validateEmails(block);
  return emailError ? `${name}: ${emailError}` : null;
}

function mergeBlock(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_AUTOMATION_BLOCK };
  return {
    ...DEFAULT_AUTOMATION_BLOCK,
    ...input,
    every: { ...DEFAULT_AUTOMATION_BLOCK.every, ...(input.every ?? {}) },
  };
}

export function parseAutomationSettingsBody(body) {
  const invoice = mergeBlock(body?.invoice);
  const statement = mergeBlock(body?.statement);

  const error = validateBlock('invoice', invoice) ?? validateBlock('statement', statement);
  if (error) return { error };

  return { value: { invoice, statement } };
}

/**
 * `nextRun` is never stored on AutomationSettings — ScheduledJob.nextRunAt is
 * the single source of truth, because it is the value the tick claims on.
 * This merges it in for display only.
 */
export function buildAutomationSettingsPayload(settings, jobs = {}) {
  const shape = (block, kind) => ({
    ...DEFAULT_AUTOMATION_BLOCK,
    ...(block ?? {}),
    nextRun: jobs[kind]?.nextRunAt ?? null,
  });

  return {
    invoice: shape(settings?.invoice, 'invoice_automation'),
    statement: shape(settings?.statement, 'statement_automation'),
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd Backend && npx vitest run test/unit/utils/automationSettingsHelpers.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add Backend/src/utils/automationSettingsHelpers.js Backend/test/unit/utils/automationSettingsHelpers.test.js
git commit -m "feat: validate and shape automation settings on the write path"
```

---

## Task 3: `GET` / `PUT` routes

**Files:**
- Modify: `Backend/src/routes/workspace.js` (append after the `feature-toggles` handlers, currently ending ~line 360)
- Test: `Backend/test/integration/workspace.automation-settings.route.test.js`

**Interfaces:**
- Consumes: `parseAutomationSettingsBody`, `buildAutomationSettingsPayload` (Task 2); `AutomationSettings` (Task 1); existing `parseWorkspaceIdParam`, `authenticateToken`, `sanitizeLogValue`, `info`, `error` already imported in this file
- Produces: `GET /api/workspaces/:workspaceId/automation-settings` → 200 `{invoice, statement}`; `PUT` same path → 200 with the saved payload, 400 `{message}` on validation failure

**Authorization decision (from the spec's open question):** these routes use `authenticateToken` **only** — not `requireOwnerOrSupportAdmin`. Automation settings are the client's own billing configuration. The owner/support gate stays on `/feature-toggles`, which controls whether the tab exists at all.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/integration/workspace.automation-settings.route.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import { loginAsSupportAdmin } from '../helpers/auth.js';

const WS = 'ws-automation-1';

describe('GET/PUT /api/workspaces/:workspaceId/automation-settings', () => {
  let app;
  let agent;

  beforeEach(async () => {
    await AutomationSettings.deleteMany({});
    app = createApp();
    agent = await loginAsSupportAdmin(app);
  });

  it('returns defaults when no document exists', async () => {
    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);
    expect(res.body.invoice.enabled).toBe(false);
    expect(res.body.invoice.nextRun).toBeNull();
  });

  it('persists a valid block', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 15,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice.runOn).toBe(15);

    const stored = await AutomationSettings.findOne({ workspaceId: WS });
    expect(stored.invoice.enabled).toBe(true);
  });

  it('rejects a bad email with 400 and names the field', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 1,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
        sendCopyTo: 'nope',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sendCopyTo/);
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd Backend && npx vitest run test/integration/workspace.automation-settings.route.test.js`
Expected: FAIL — 404 on both routes

- [ ] **Step 3: Add the imports**

At the top of `Backend/src/routes/workspace.js`, alongside the existing imports:

```js
import AutomationSettings from '../models/AutomationSettings.js';
import {
  parseAutomationSettingsBody,
  buildAutomationSettingsPayload,
} from '../utils/automationSettingsHelpers.js';
```

- [ ] **Step 4: Add the two handlers**

Append after the `feature-toggles` PUT handler:

```js
router.get('/:workspaceId/automation-settings', authenticateToken, async (req, res) => {
  try {
    const workspaceId = parseWorkspaceIdParam(req.params.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const settings = await AutomationSettings.findOne({ workspaceId: { $eq: workspaceId } }).lean();
    return res.status(200).json(buildAutomationSettingsPayload(settings, {}));
  } catch (err) {
    error(
      'Workspace-Service',
      'Failed to fetch automation settings',
      sanitizeLogValue({ workspaceId: req.params.workspaceId, error: err.message }),
      req ?? null
    );
    return res.status(500).json({ message: 'Failed to fetch automation settings' });
  }
});

router.put('/:workspaceId/automation-settings', authenticateToken, async (req, res) => {
  try {
    const workspaceId = parseWorkspaceIdParam(req.params.workspaceId);
    if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });

    const parsed = parseAutomationSettingsBody(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const settings = await AutomationSettings.findOneAndUpdate(
      { workspaceId: { $eq: workspaceId } },
      { $set: { workspaceId, ...parsed.value } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    info(
      'Workspace-Service',
      'Automation settings updated',
      sanitizeLogValue({ workspaceId }),
      req ?? null
    );
    return res.status(200).json(buildAutomationSettingsPayload(settings, {}));
  } catch (err) {
    error(
      'Workspace-Service',
      'Failed to update automation settings',
      sanitizeLogValue({ workspaceId: req.params.workspaceId, error: err.message }),
      req ?? null
    );
    return res.status(500).json({ message: 'Failed to update automation settings' });
  }
});
```

The empty `{}` second argument to `buildAutomationSettingsPayload` is deliberate — schedules do not exist until Phase 2, so `nextRun` is legitimately null. Task 13 replaces it.

- [ ] **Step 5: Run it and watch it pass**

Run: `cd Backend && npx vitest run test/integration/workspace.automation-settings.route.test.js`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add Backend/src/routes/workspace.js Backend/test/integration/workspace.automation-settings.route.test.js
git commit -m "feat: read and write automation settings per workspace"
```

---

## Task 4: `Run On` options (Frontend, pure)

**Files:**
- Create: `Frontend/lib/automation-run-on-options.ts`
- Test: `Frontend/test/unit/lib/automation-run-on-options.test.ts`

**Interfaces:**
- Produces: `AutomationUnit` type; `runOnOptionsForUnit(unit)` → `{ kind: 'weekday'|'day-of-month'|'month-day'; options: Array<{value, label}> }`; `defaultRunOnForUnit(unit)`

- [ ] **Step 1: Write the failing test**

```ts
// Frontend/test/unit/lib/automation-run-on-options.test.ts
import { describe, it, expect } from "vitest";
import {
  runOnOptionsForUnit,
  defaultRunOnForUnit,
} from "@/lib/automation-run-on-options";

describe("runOnOptionsForUnit", () => {
  it("gives no options for day", () => {
    expect(runOnOptionsForUnit("day").options).toHaveLength(0);
  });

  it("gives seven weekdays for week, starting Monday", () => {
    const { kind, options } = runOnOptionsForUnit("week");
    expect(kind).toBe("weekday");
    expect(options).toHaveLength(7);
    expect(options[0].value).toBe("monday");
  });

  it("caps month at 28 so short months are never skipped", () => {
    const { kind, options } = runOnOptionsForUnit("month");
    expect(kind).toBe("day-of-month");
    expect(options).toHaveLength(28);
    expect(options[27].value).toBe(28);
  });

  it("uses month+day for quarter and year", () => {
    expect(runOnOptionsForUnit("quarter").kind).toBe("month-day");
    expect(runOnOptionsForUnit("year").kind).toBe("month-day");
  });
});

describe("defaultRunOnForUnit", () => {
  it("returns a unit-appropriate default", () => {
    expect(defaultRunOnForUnit("week")).toBe("monday");
    expect(defaultRunOnForUnit("month")).toBe(1);
    expect(defaultRunOnForUnit("quarter")).toEqual({ month: 1, day: 1 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd Frontend && npx vitest run test/unit/lib/automation-run-on-options.test.ts`
Expected: FAIL — cannot resolve `@/lib/automation-run-on-options`

- [ ] **Step 3: Implement**

```ts
// Frontend/lib/automation-run-on-options.ts
export type AutomationUnit = "day" | "week" | "month" | "quarter" | "year";

export type RunOnKind = "none" | "weekday" | "day-of-month" | "month-day";

export type RunOnOption = { value: string | number; label: string };

const WEEKDAYS: RunOnOption[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

// 1-28 only. The 29th-31st silently skip months too short for them — every
// February for 29/30 — which for invoicing means a client is not billed.
const DAYS_OF_MONTH: RunOnOption[] = Array.from({ length: 28 }, (_, i) => ({
  value: i + 1,
  label: String(i + 1),
}));

const MONTHS: RunOnOption[] = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
].map((label, i) => ({ value: i + 1, label }));

export function runOnOptionsForUnit(unit: AutomationUnit): {
  kind: RunOnKind;
  options: RunOnOption[];
  months?: RunOnOption[];
} {
  if (unit === "day") return { kind: "none", options: [] };
  if (unit === "week") return { kind: "weekday", options: WEEKDAYS };
  if (unit === "month") return { kind: "day-of-month", options: DAYS_OF_MONTH };
  return { kind: "month-day", options: DAYS_OF_MONTH, months: MONTHS };
}

export function defaultRunOnForUnit(unit: AutomationUnit) {
  if (unit === "day") return null;
  if (unit === "week") return "monday";
  if (unit === "month") return 1;
  return { month: 1, day: 1 };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd Frontend && npx vitest run test/unit/lib/automation-run-on-options.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add Frontend/lib/automation-run-on-options.ts Frontend/test/unit/lib/automation-run-on-options.test.ts
git commit -m "feat: Run On options that change with the selected unit"
```

---

## Task 5: Settings client and types (Frontend)

**Files:**
- Create: `Frontend/lib/automation-settings.ts`
- Test: `Frontend/test/unit/lib/automation-settings.test.ts`

**Interfaces:**
- Consumes: `AutomationUnit` (Task 4); the shared axios instance at `@/app/utils/axiosConfig`
- Produces: `AutomationBlock` and `AutomationSettings` types; `fetchAutomationSettings(workspaceId)` → `Promise<AutomationSettings>`; `saveAutomationSettings(workspaceId, settings)` → `Promise<AutomationSettings>`; `DEFAULT_BLOCK`

- [ ] **Step 1: Write the failing test**

```ts
// Frontend/test/unit/lib/automation-settings.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "@/app/utils/axiosConfig";
import {
  fetchAutomationSettings,
  saveAutomationSettings,
  DEFAULT_BLOCK,
} from "@/lib/automation-settings";

vi.mock("@/app/utils/axiosConfig", () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

describe("automation-settings client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches from the workspace-scoped path", async () => {
    (axios.get as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });
    const result = await fetchAutomationSettings("ws-1");
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1/automation-settings"),
    );
    expect(result.invoice.enabled).toBe(false);
  });

  it("puts the whole settings object", async () => {
    (axios.put as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });
    const payload = { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK };
    await saveAutomationSettings("ws-1", payload);
    expect(axios.put).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1/automation-settings"),
      payload,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd Frontend && npx vitest run test/unit/lib/automation-settings.test.ts`
Expected: FAIL — cannot resolve `@/lib/automation-settings`

- [ ] **Step 3: Implement**

```ts
// Frontend/lib/automation-settings.ts
import axios from "@/app/utils/axiosConfig";
import type { AutomationUnit } from "@/lib/automation-run-on-options";

export type AutomationBlock = {
  enabled: boolean;
  every: { n: number; unit: AutomationUnit };
  runOn: string | number | { month: number; day: number } | null;
  runAt: string;
  startDate: string | null;
  sendMethod: "isoplus" | "accounting";
  recipient: "billing_contact" | "client_participant";
  sendCopyTo: string;
  replyTo: string;
  emailFrom: string;
  emailSubject: string;
  emailMessage: string;
  senderIdentityId: string | null;
  /** Read-only. Computed from ScheduledJob.nextRunAt; never sent on save. */
  nextRun?: string | null;
};

export type AutomationSettings = {
  invoice: AutomationBlock;
  statement: AutomationBlock;
};

export const DEFAULT_BLOCK: AutomationBlock = {
  enabled: false,
  every: { n: 1, unit: "month" },
  runOn: 1,
  runAt: "09:00",
  startDate: null,
  sendMethod: "isoplus",
  recipient: "billing_contact",
  sendCopyTo: "",
  replyTo: "",
  emailFrom: "",
  emailSubject: "",
  emailMessage: "",
  senderIdentityId: null,
  nextRun: null,
};

const path = (workspaceId: string) =>
  `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/${workspaceId}/automation-settings`;

export async function fetchAutomationSettings(
  workspaceId: string,
): Promise<AutomationSettings> {
  const response = await axios.get(path(workspaceId));
  return response.data;
}

export async function saveAutomationSettings(
  workspaceId: string,
  settings: AutomationSettings,
): Promise<AutomationSettings> {
  const response = await axios.put(path(workspaceId), settings);
  return response.data;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd Frontend && npx vitest run test/unit/lib/automation-settings.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add Frontend/lib/automation-settings.ts Frontend/test/unit/lib/automation-settings.test.ts
git commit -m "feat: automation settings client and types"
```

---

## Task 6: The panel, replacing Arnold's placeholder

**Files:**
- Create: `Frontend/lib/automation-schedule-block.tsx`
- Create: `Frontend/lib/automation-email-block.tsx`
- Create: `Frontend/lib/invoice-statement-automation-panel.tsx`
- Modify: `Frontend/lib/finance-settings-page.tsx` (the `TabsContent value="automation"` block, ~lines 85–92)
- Test: `Frontend/test/unit/lib/invoice-statement-automation-panel.test.tsx`

**Interfaces:**
- Consumes: `runOnOptionsForUnit`, `defaultRunOnForUnit` (Task 4); `fetchAutomationSettings`, `saveAutomationSettings`, `DEFAULT_BLOCK`, types (Task 5)
- Produces: `<InvoiceStatementAutomationPanel workspaceId={string} />`

**The schedule and email blocks are built once and rendered twice** — invoice and statement have identical field shapes (5.1/5.2 vs 5.3/5.4). Building them twice is the obvious way this goes wrong.

- [ ] **Step 1: Characterize the existing gating first**

Before touching anything, run Arnold's gating test against unmodified code so "swapping the panel did not change the gating" is evidence, not assertion.

Run: `cd Frontend && npx vitest run test/unit/finance-settings-tab.test.ts test/unit/lib/finance-settings-page.test.tsx`
Expected: PASS. Record the counts; they must be identical after Step 6.

- [ ] **Step 2: Write the failing test**

```tsx
// Frontend/test/unit/lib/invoice-statement-automation-panel.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { InvoiceStatementAutomationPanel } from "@/lib/invoice-statement-automation-panel";
import { DEFAULT_BLOCK } from "@/lib/automation-settings";

vi.mock("@/lib/automation-settings", async () => {
  const actual = await vi.importActual<any>("@/lib/automation-settings");
  return {
    ...actual,
    fetchAutomationSettings: vi.fn(),
    saveAutomationSettings: vi.fn(),
  };
});

import {
  fetchAutomationSettings,
  saveAutomationSettings,
} from "@/lib/automation-settings";

describe("InvoiceStatementAutomationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetchAutomationSettings as any).mockResolvedValue({
      invoice: { ...DEFAULT_BLOCK },
      statement: { ...DEFAULT_BLOCK },
    });
  });

  it("renders both automation blocks", async () => {
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Invoice Automation/i)).toBeInTheDocument();
      expect(screen.getByText(/Statement Automation/i)).toBeInTheDocument();
    });
  });

  it("shows Next Run as read-only", async () => {
    (fetchAutomationSettings as any).mockResolvedValue({
      invoice: { ...DEFAULT_BLOCK, enabled: true, nextRun: "2026-09-01T09:00:00+10:00" },
      statement: { ...DEFAULT_BLOCK },
    });
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
    await waitFor(() => {
      const nextRun = screen.getByLabelText(/next run/i);
      expect(nextRun).toHaveAttribute("readonly");
    });
  });

  it("saves both blocks together", async () => {
    (saveAutomationSettings as any).mockResolvedValue({
      invoice: { ...DEFAULT_BLOCK },
      statement: { ...DEFAULT_BLOCK },
    });
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
    await waitFor(() => screen.getByText(/Invoice Automation/i));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(saveAutomationSettings).toHaveBeenCalledWith(
        "ws-1",
        expect.objectContaining({ invoice: expect.any(Object), statement: expect.any(Object) }),
      );
    });
  });

  it("restores defaults without saving", async () => {
    render(<InvoiceStatementAutomationPanel workspaceId="ws-1" />);
    await waitFor(() => screen.getByText(/Invoice Automation/i));
    fireEvent.click(screen.getByRole("button", { name: /restore defaults/i }));
    expect(saveAutomationSettings).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd Frontend && npx vitest run test/unit/lib/invoice-statement-automation-panel.test.tsx`
Expected: FAIL — cannot resolve `@/lib/invoice-statement-automation-panel`

- [ ] **Step 4: Build the two reusable blocks**

`Frontend/lib/automation-schedule-block.tsx` — props `{ label, value: AutomationBlock, onChange(next: AutomationBlock) }`. Renders: an enable `Switch`; `Generate Every` as a number input plus a unit `Select` over the five units; `Run On` driven by `runOnOptionsForUnit(value.every.unit)` — hidden when `kind === "none"`, a weekday `Select` for `weekday`, a day `Select` for `day-of-month`, and a month `Select` beside a day `Select` for `month-day`; `Run At` as `<input type="time">`; `Start Date` as `<input type="date">`; and `Next Run` as `<input readOnly>` labelled `Next Run`, formatted from `value.nextRun` or showing an em dash when null.

When the unit changes, set `runOn` to `defaultRunOnForUnit(nextUnit)` in the same update — carrying a weekday into a monthly schedule is the bug this prevents.

`Frontend/lib/automation-email-block.tsx` — props `{ value, onChange }`. Renders `Recipient` and `Send Method` selects, and text inputs for `Send a Copy To`, `Reply-to Email`, `Email From`, `Email Subject`, `Email Message`. Each email field shows an inline error below it when non-empty and failing `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.

Do **not** render the excluded fields: Invoice scope, Eligible billing items, Statement type, Statement period, Transaction types.

- [ ] **Step 5: Build the panel**

```tsx
// Frontend/lib/invoice-statement-automation-panel.tsx
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AutomationScheduleBlock } from "@/lib/automation-schedule-block";
import { AutomationEmailBlock } from "@/lib/automation-email-block";
import {
  fetchAutomationSettings,
  saveAutomationSettings,
  DEFAULT_BLOCK,
  type AutomationBlock,
  type AutomationSettings,
} from "@/lib/automation-settings";

const DEFAULTS: AutomationSettings = {
  invoice: { ...DEFAULT_BLOCK },
  statement: { ...DEFAULT_BLOCK },
};

export function InvoiceStatementAutomationPanel({
  workspaceId,
}: Readonly<{ workspaceId: string }>) {
  const [settings, setSettings] = useState<AutomationSettings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAutomationSettings(workspaceId)
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch(() => {
        if (!cancelled) setErrorMessage("Could not load automation settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const update = (key: keyof AutomationSettings) => (next: AutomationBlock) =>
    setSettings((current) => ({ ...current, [key]: next }));

  const onSave = async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      setSettings(await saveAutomationSettings(workspaceId, settings));
    } catch (err: any) {
      setErrorMessage(err?.response?.data?.message ?? "Could not save automation settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage}</p>
      ) : null}

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Invoice Automation</h2>
        <AutomationScheduleBlock
          label="Generate Invoices Every"
          value={settings.invoice}
          onChange={update("invoice")}
        />
        <AutomationEmailBlock value={settings.invoice} onChange={update("invoice")} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Statement Automation</h2>
        <AutomationScheduleBlock
          label="Generate Statements Every"
          value={settings.statement}
          onChange={update("statement")}
        />
        <AutomationEmailBlock value={settings.statement} onChange={update("statement")} />
      </section>

      <div className="flex gap-3">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
        <Button variant="outline" onClick={() => setSettings(DEFAULTS)} disabled={saving}>
          Restore Defaults
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Swap the placeholder**

In `Frontend/lib/finance-settings-page.tsx`, replace the `PlaceholderPanel` inside `TabsContent value="automation"` with `<InvoiceStatementAutomationPanel workspaceId={workspaceId} />`, and add the import. Leave the surrounding `{automationEnabled ? … : null}` gating untouched — that is Arnold's Epic 2 behaviour and Step 1 pinned it.

- [ ] **Step 7: Run the new tests and the characterization tests**

Run: `cd Frontend && npx vitest run test/unit/lib/invoice-statement-automation-panel.test.tsx test/unit/finance-settings-tab.test.ts test/unit/lib/finance-settings-page.test.tsx`
Expected: PASS. The two characterization files must report the **same counts as Step 1**. If `finance-settings-page.test.tsx` now fails because it asserted on placeholder copy, update that assertion — but confirm the gating assertions still pass untouched.

- [ ] **Step 8: Commit**

```bash
git add Frontend/lib/automation-schedule-block.tsx Frontend/lib/automation-email-block.tsx \
        Frontend/lib/invoice-statement-automation-panel.tsx Frontend/lib/finance-settings-page.tsx \
        Frontend/test/unit/lib/invoice-statement-automation-panel.test.tsx
git commit -m "feat: real Invoice & Statement Automation panel in place of the placeholder"
```

---

## Task 7: End-to-end test (Playwright)

**Files:**
- Create: `Frontend/e2e/invoice-statement-automation.spec.ts`

**Interfaces:**
- Consumes: the running local stack (`npm run dev:up`), a workspace with the feature flag enabled

A user-visible change needs an end-to-end test — a feature with perfect unit tests that nothing links to is not done.

- [ ] **Step 1: Write the failing test**

```ts
// Frontend/e2e/invoice-statement-automation.spec.ts
import { test, expect } from "@playwright/test";

const WORKSPACE = process.env.E2E_WORKSPACE_ID ?? "1";

test.describe("Invoice & Statement Automation tab", () => {
  test("configures a schedule and shows Next Run", async ({ page }) => {
    await page.goto(`/workspace/${WORKSPACE}/finance-settings?tab=automation`);

    await expect(page.getByRole("tab", { name: /Invoice & Statement Automation/i })).toBeVisible();
    await expect(page.getByText(/Invoice Automation/i)).toBeVisible();

    await page.getByLabel(/generate invoices every/i).fill("1");
    await page.getByRole("button", { name: /save changes/i }).click();

    await expect(page.getByLabel(/next run/i)).toHaveAttribute("readonly", "");
  });

  test("falls back to the financial tab when the flag is off", async ({ page }) => {
    const disabled = process.env.E2E_WORKSPACE_ID_NO_FLAG;
    test.skip(!disabled, "needs a workspace with the flag disabled");

    await page.goto(`/workspace/${disabled}/finance-settings?tab=automation`);
    await expect(
      page.getByRole("tab", { name: /Invoice & Statement Automation/i }),
    ).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd Frontend && npx playwright test e2e/invoice-statement-automation.spec.ts`
Expected: FAIL if the stack is not up, or if the panel is not wired. Bring the stack up with `npm run dev:up` from the repo root first.

- [ ] **Step 3: Fix whatever the e2e run exposes**

Likely candidates: label text not matching `getByLabel`, or the tab name differing from Arnold's copy. Fix the component, not the assertion — unless the assertion genuinely encoded the wrong expectation, in which case say which and why.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd Frontend && npx playwright test e2e/invoice-statement-automation.spec.ts`
Expected: PASS — 1 passed, 1 skipped (unless `E2E_WORKSPACE_ID_NO_FLAG` is set)

- [ ] **Step 5: Commit**

```bash
git add Frontend/e2e/invoice-statement-automation.spec.ts
git commit -m "test: end-to-end coverage for the automation tab"
```

---

## CHECKPOINT — Phase 1 complete

- [ ] Run the full backend suite: `cd Backend && npx vitest run` — expect all green.
- [ ] Run the full frontend suite: `cd Frontend && npx vitest run` — expect all green.
- [ ] **Do not open a PR for merge yet.** Phase 1 alone ships a UI that configures automation which cannot fire.
- [ ] **Wait for PR #855 to merge to `develop`.**
- [ ] Then rebase, following the repo recipe:

```bash
git fetch origin
git tag -f backup/pre-rebase-KAN-10-phase2 HEAD
git rebase origin/develop
# expect a conflict in Backend/vitest.config.js — union both sides
git diff backup/pre-rebase-KAN-10-phase2 HEAD    # only the vitest union should differ
cd Backend && npx vitest run
```

---

# PHASE 2 — scheduler wiring

**Do not start until #855 is merged and the rebase above is done.**

## Task 8: `ScheduledJob` learns the picker shape

**Files:**
- Modify: `Backend/src/models/ScheduledJob.js`
- Test: `Backend/test/unit/models/scheduledJob.test.js` (extend the existing file)

**Interfaces:**
- Produces: `ScheduledJob` accepting **exactly one** of `cron` (String) or `schedule` (`{ every: {n, unit}, runOn, runAt, startDate }`)

- [ ] **Step 1: Write the failing tests**

Append to the existing `Backend/test/unit/models/scheduledJob.test.js`:

```js
describe('ScheduledJob cron/schedule exclusivity', () => {
  const base = {
    kind: 'invoice_automation',
    targetId: 'ws-1',
    timezone: 'Australia/Sydney',
    nextRunAt: new Date('2026-09-01T09:00:00+10:00'),
  };
  const picker = {
    every: { n: 1, unit: 'month' },
    runOn: 15,
    runAt: '09:00',
    startDate: new Date('2026-08-01T00:00:00+10:00'),
  };

  it('accepts a cron-only job', async () => {
    const doc = new ScheduledJob({ ...base, cron: '0 9 * * *' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('accepts a schedule-only job', async () => {
    const doc = new ScheduledJob({ ...base, schedule: picker });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a job with both', async () => {
    const doc = new ScheduledJob({ ...base, cron: '0 9 * * *', schedule: picker });
    await expect(doc.validate()).rejects.toThrow(/exactly one/i);
  });

  it('rejects a job with neither', async () => {
    const doc = new ScheduledJob({ ...base });
    await expect(doc.validate()).rejects.toThrow(/exactly one/i);
  });

  it('validates timezone on a schedule-only job, where cron is null', async () => {
    const doc = new ScheduledJob({ ...base, timezone: 'Not/AZone', schedule: picker });
    await expect(doc.validate()).rejects.toThrow(/timezone/i);
  });

  it('rejects an unknown unit', async () => {
    const doc = new ScheduledJob({
      ...base,
      schedule: { ...picker, every: { n: 1, unit: 'fortnight' } },
    });
    await expect(doc.validate()).rejects.toThrow(/unit/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd Backend && npx vitest run test/unit/models/scheduledJob.test.js`
Expected: FAIL — cron-only passes, everything else fails because `cron` is still `required: true` and `schedule` does not exist.

- [ ] **Step 3: Modify the model**

The existing validators are coupled to `cron` being present; both need a branch.

```js
import { AUTOMATION_UNITS } from './AutomationSettings.js';

// Only meaningful for cron jobs. A picker schedule has no cron to validate,
// and returning true there lets the exactly-one check own that case.
function cronIsValid(value) {
  if (value === null || value === undefined) return true;
  return isValidSchedule(value, this.timezone);
}

// A picker schedule still needs a real IANA zone, but isValidSchedule needs a
// cron to parse. Probe with a trivially valid expression so the timezone is
// checked in isolation.
const PROBE_CRON = '* * * * *';
function timezoneIsValid(value) {
  return isValidSchedule(this.cron ?? PROBE_CRON, value);
}

function exactlyOneSchedule() {
  const hasCron = Boolean(this.cron);
  const hasPicker = Boolean(this.schedule?.every?.unit);
  return hasCron !== hasPicker;
}
```

Change `cron` to `{ type: String, default: null, validate: {...} }` — dropping `required: true`. Add the `schedule` subdocument:

```js
schedule: {
  type: new mongoose.Schema(
    {
      every: {
        n: { type: Number, required: true, min: 1 },
        unit: { type: String, required: true, enum: AUTOMATION_UNITS },
      },
      runOn: { type: mongoose.Schema.Types.Mixed, default: null },
      runAt: { type: String, required: true, default: '09:00' },
      startDate: { type: Date, default: null },
    },
    { _id: false },
  ),
  default: null,
},
```

And attach the document-level check:

```js
scheduledJobSchema.pre('validate', function assertExactlyOne(next) {
  if (!exactlyOneSchedule.call(this)) {
    next(new Error('ScheduledJob: exactly one of cron or schedule is required'));
    return;
  }
  next();
});
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd Backend && npx vitest run test/unit/models/scheduledJob.test.js`
Expected: PASS — the existing tests plus the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add Backend/src/models/ScheduledJob.js Backend/test/unit/models/scheduledJob.test.js
git commit -m "feat: ScheduledJob accepts a picker schedule as well as cron"
```

---

## Task 9: `upsertSchedule` accepts a picker schedule

**Files:**
- Modify: `Backend/src/services/scheduler/schedules.js`
- Create: `Backend/src/services/scheduler/advance.js`
- Test: `Backend/test/unit/services/scheduler.advance.test.js`
- Test: `Backend/test/unit/services/scheduler.schedules.test.js` (extend)

**Interfaces:**
- Consumes: `computeNextRun(cron, timezone, from)` from `scheduler/nextRun.js`; `computeNextRun(settings, from, timezone)` from `utils/automationScheduleHelpers.js` — **note the argument orders differ**; `advance.js` exists to absorb that
- Produces: `advanceSchedule(job, now)` → `Date`; `upsertSchedule({ kind, targetId, workspaceId, cron?, schedule?, timezone, now })`

- [ ] **Step 1: Write the failing test for `advance.js`**

```js
// Backend/test/unit/services/scheduler.advance.test.js
import { describe, it, expect } from 'vitest';
import { advanceSchedule } from '../../../src/services/scheduler/advance.js';

const TZ = 'Australia/Sydney';

describe('advanceSchedule', () => {
  it('uses cron arithmetic for a cron job', () => {
    const next = advanceSchedule(
      { cron: '0 9 * * *', timezone: TZ, schedule: null },
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-12T23:00:00.000Z'); // 09:00 Sydney next day
  });

  it('uses picker arithmetic for a schedule job', () => {
    const next = advanceSchedule(
      {
        cron: null,
        timezone: TZ,
        schedule: {
          every: { n: 2, unit: 'week' },
          runOn: 'monday',
          runAt: '09:00',
          startDate: new Date('2026-08-03T00:00:00+10:00'),
        },
      },
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(next.getTime()).toBeGreaterThan(new Date('2026-08-12T00:00:00Z').getTime());
  });

  it('throws when a job has neither', () => {
    expect(() => advanceSchedule({ cron: null, schedule: null, timezone: TZ }, new Date()))
      .toThrow(/exactly one/i);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.advance.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `advance.js`**

```js
// Backend/src/services/scheduler/advance.js
import { computeNextRun as cronNextRun } from './nextRun.js';
import { computeNextRun as pickerNextRun } from '../../utils/automationScheduleHelpers.js';

/**
 * The next firing instant for either schedule representation.
 *
 * Cron and picker schedules are both legitimate — cron cannot express "every
 * 2 weeks" or "every 3 months from a start date", which Epic 5 requires, and
 * the picker cannot express the irregular shapes cron handles. This is the
 * only place that knows both exist; callers pass a job and get a Date.
 *
 * Note the two computeNextRun functions take their arguments in different
 * orders. Absorbing that here is most of why this module exists.
 */
export function advanceSchedule(job, now) {
  const hasCron = Boolean(job?.cron);
  const hasPicker = Boolean(job?.schedule?.every?.unit);

  if (hasCron === hasPicker) {
    throw new Error('advanceSchedule: exactly one of cron or schedule is required');
  }

  return hasCron
    ? cronNextRun(job.cron, job.timezone, now)
    : pickerNextRun(job.schedule, now, job.timezone);
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.advance.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Extend `upsertSchedule`**

In `Backend/src/services/scheduler/schedules.js`, accept `schedule` alongside `cron`, and route both validation and the initial `nextRunAt` through the new module:

```js
export async function upsertSchedule({
  kind,
  targetId,
  workspaceId = null,
  cron = null,
  schedule = null,
  timezone,
  now = new Date(),
}) {
  const effectiveTimezone = await resolveTimezone({ workspaceId, timezone });

  if (Boolean(cron) === Boolean(schedule?.every?.unit)) {
    throw new Error(`Scheduler: exactly one of cron or schedule is required for "${kind}"`);
  }

  if (cron) {
    if (!isValidSchedule(cron, effectiveTimezone)) {
      throw new Error(
        `Scheduler: invalid schedule for "${kind}" — cron "${cron}", timezone "${effectiveTimezone}"`,
      );
    }
    // The floor is computed from a cron expression and only applies to one.
    // A picker schedule cannot breach it: the coarsest picker cadence is
    // {n: 1, unit: 'day'} = 1440 minutes, against floors of 60 and 5.
    assertMinimumInterval({ kind, cron, timezone: effectiveTimezone, now });
  }

  const nextRunAt = advanceSchedule({ cron, schedule, timezone: effectiveTimezone }, now);

  const job = await ScheduledJob.findOneAndUpdate(
    { kind, targetId },
    {
      $set: {
        workspaceId,
        cron,
        schedule,
        timezone: effectiveTimezone,
        enabled: true,
        nextRunAt,
        lastError: null,
        consecutiveFailures: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );

  info('Scheduler', 'Schedule upserted', {
    kind, targetId, cron, schedule, timezone: effectiveTimezone, nextRunAt: job.nextRunAt,
  });

  return job;
}
```

Add `import { advanceSchedule } from './advance.js';` at the top.

- [ ] **Step 6: Add a test that a picker schedule round-trips**

Append to `Backend/test/unit/services/scheduler.schedules.test.js`:

```js
it('upserts a picker schedule and computes nextRunAt from it', async () => {
  const job = await upsertSchedule({
    kind: 'invoice_automation',
    targetId: 'ws-1',
    workspaceId: 'ws-1',
    schedule: {
      every: { n: 1, unit: 'month' },
      runOn: 15,
      runAt: '09:00',
      startDate: new Date('2026-08-01T00:00:00+10:00'),
    },
    timezone: 'Australia/Sydney',
    now: new Date('2026-08-12T00:00:00Z'),
  });

  expect(job.cron).toBeNull();
  expect(job.schedule.every.unit).toBe('month');
  expect(job.nextRunAt).toBeInstanceOf(Date);
});

it('refuses a job given both cron and schedule', async () => {
  await expect(
    upsertSchedule({
      kind: 'invoice_automation',
      targetId: 'ws-2',
      cron: '0 9 * * *',
      schedule: { every: { n: 1, unit: 'month' }, runAt: '09:00' },
      timezone: 'Australia/Sydney',
    }),
  ).rejects.toThrow(/exactly one/i);
});
```

- [ ] **Step 7: Run the scheduler suite**

Run: `cd Backend && npx vitest run test/unit/services/scheduler.*.test.js`
Expected: PASS — all existing scheduler tests plus the new ones. Existing cron behaviour must be unchanged.

- [ ] **Step 8: Commit**

```bash
git add Backend/src/services/scheduler/advance.js Backend/src/services/scheduler/schedules.js \
        Backend/test/unit/services/scheduler.advance.test.js Backend/test/unit/services/scheduler.schedules.test.js
git commit -m "feat: upsertSchedule accepts picker schedules via a shared advance step"
```

---

## Task 10: The period key

**Files:**
- Create: `Backend/src/utils/automationPeriodKey.js`
- Test: `Backend/test/unit/utils/automationPeriodKey.test.js`

**Interfaces:**
- Produces: `automationPeriodKey({ slot, timezone })` → `string` of the form `YYYYMMDD-HHmm`

**This is the load-bearing part of the idempotency design.** The key derives from the **claimed slot**, never from `Date.now()`. A retry claims the same slot, produces the same key, and BullMQ drops the boards already enqueued. Deriving it from the current time would produce a fresh key per retry and duplicate-bill every board that already succeeded.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/utils/automationPeriodKey.test.js
import { describe, it, expect } from 'vitest';
import { automationPeriodKey } from '../../../src/utils/automationPeriodKey.js';

const TZ = 'Australia/Sydney';

describe('automationPeriodKey', () => {
  it('formats the slot in the schedule timezone', () => {
    const slot = new Date('2026-08-11T23:00:00Z'); // 09:00 on the 12th in Sydney
    expect(automationPeriodKey({ slot, timezone: TZ })).toBe('20260812-0900');
  });

  it('is stable — the same slot always yields the same key', () => {
    const slot = new Date('2026-08-11T23:00:00Z');
    const first = automationPeriodKey({ slot, timezone: TZ });
    const second = automationPeriodKey({ slot: new Date(slot.getTime()), timezone: TZ });
    expect(second).toBe(first);
  });

  it('distinguishes two slots on the same day', () => {
    const morning = automationPeriodKey({ slot: new Date('2026-08-11T23:00:00Z'), timezone: TZ });
    const evening = automationPeriodKey({ slot: new Date('2026-08-12T09:00:00Z'), timezone: TZ });
    expect(morning).not.toBe(evening);
  });

  it('does not collide across timezones for the same instant', () => {
    const slot = new Date('2026-08-11T23:00:00Z');
    const sydney = automationPeriodKey({ slot, timezone: TZ });
    const perth = automationPeriodKey({ slot, timezone: 'Australia/Perth' });
    expect(sydney).not.toBe(perth);
  });

  it('yields one key per slot across a DST boundary', () => {
    // Sydney leaves DST on 2026-04-05; 02:00 occurs twice in local terms.
    const before = automationPeriodKey({ slot: new Date('2026-04-04T15:00:00Z'), timezone: TZ });
    const after = automationPeriodKey({ slot: new Date('2026-04-05T16:00:00Z'), timezone: TZ });
    expect(before).not.toBe(after);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd Backend && npx vitest run test/unit/utils/automationPeriodKey.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```js
// Backend/src/utils/automationPeriodKey.js

/**
 * A stable identifier for one scheduled slot, used as the dedupe half of a
 * BullMQ jobId.
 *
 * `slot` MUST be the nextRunAt value that was claimed, never Date.now(). A
 * retry after a crash claims the same slot and therefore produces the same
 * key, so BullMQ drops the boards already enqueued and admits only the
 * missing ones. Deriving this from the current time would produce a fresh
 * key on every retry and duplicate-bill every board that already succeeded.
 *
 * Formatted in the schedule's own timezone so two workspaces on different
 * zones cannot collide on the same instant.
 */
export function automationPeriodKey({ slot, timezone }) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .formatToParts(slot)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  // Intl renders hour 24 for midnight in some engines; normalise it.
  const hour = parts.hour === '24' ? '00' : parts.hour;

  return `${parts.year}${parts.month}${parts.day}-${hour}${parts.minute}`;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd Backend && npx vitest run test/unit/utils/automationPeriodKey.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add Backend/src/utils/automationPeriodKey.js Backend/test/unit/utils/automationPeriodKey.test.js
git commit -m "feat: stable per-slot period key for automation idempotency"
```

---

## Task 11: Queue and fan-out

**Files:**
- Create: `Backend/src/services/automation/queue.js`
- Create: `Backend/src/services/automation/fanOut.js`
- Test: `Backend/test/unit/services/automation.fanOut.test.js`

**Interfaces:**
- Consumes: `automationPeriodKey` (Task 10); `Board` model
- Produces: `AUTOMATION_QUEUE_NAME`, `automationQueue`, `getAutomationQueue()`; `KIND_INVOICE`, `KIND_STATEMENT`, `KIND_PREFIX`; `buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone })` → `Array<{ name, data, opts: { jobId } }>`

A separate queue from `syncQueue`, per R7 — a stuck sync backlog must not delay billing.

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/services/automation.fanOut.test.js
import { describe, it, expect } from 'vitest';
import {
  buildFanOutSpecs,
  KIND_INVOICE,
  KIND_STATEMENT,
} from '../../../src/services/automation/fanOut.js';

const TZ = 'Australia/Sydney';
const slot = new Date('2026-08-11T23:00:00Z'); // 09:00 on the 12th, Sydney
const boards = [{ boardId: 'b1' }, { boardId: 'b2' }];

describe('buildFanOutSpecs', () => {
  it('produces one spec per board', () => {
    const specs = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    expect(specs).toHaveLength(2);
    expect(specs[0].data).toMatchObject({ workspaceId: 'ws-1', boardId: 'b1' });
  });

  it('keys each job on board and period', () => {
    const [first] = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    expect(first.opts.jobId).toBe('inv:b1:20260812-0900');
  });

  it('is stable — the same slot yields the same jobIds', () => {
    const a = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    const b = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot: new Date(slot), timezone: TZ });
    expect(b.map((s) => s.opts.jobId)).toEqual(a.map((s) => s.opts.jobId));
  });

  it('does not collide invoice with statement on the same slot and board', () => {
    const [inv] = buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    const [stmt] = buildFanOutSpecs({ kind: KIND_STATEMENT, workspaceId: 'ws-1', boards, slot, timezone: TZ });
    expect(inv.opts.jobId).not.toBe(stmt.opts.jobId);
    expect(stmt.opts.jobId).toBe('stmt:b1:20260812-0900');
  });

  it('returns an empty array when the workspace has no boards', () => {
    expect(buildFanOutSpecs({ kind: KIND_INVOICE, workspaceId: 'ws-1', boards: [], slot, timezone: TZ })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/automation.fanOut.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Extract a connection builder for the new code only**

`sync/queue.js` exports a shared `redisConnection` **instance**, not a builder, and `syncWorker.js` duplicates ~60 lines of that config to get its own — BullMQ workers block on their connection and cannot share one.

Rather than duplicate that config a third time, add a builder and use it for the new modules only. Do **not** retrofit `sync/queue.js` or `syncWorker.js` onto it; that is an unrequested refactor of code this ticket does not otherwise touch.

```js
// Backend/src/services/redisConnection.js
import Redis from 'ioredis';

/**
 * A fresh ioredis connection built from the same environment variables
 * sync/queue.js and syncWorker.js read.
 *
 * A builder rather than a shared instance because BullMQ Workers issue
 * blocking commands and must not share a connection with a Queue.
 *
 * Deliberately not retrofitted onto the sync modules, which predate it and
 * construct their own — see the follow-ups in the PR body.
 */
export function buildRedisConnection() {
  const useCluster = process.env.REDIS_CLUSTER === 'true';
  const host = process.env.REDIS_HOST ?? 'localhost';
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const password = process.env.REDIS_PASSWORD || undefined;
  const tls = process.env.REDIS_TLS === 'true' ? {} : undefined;

  // BullMQ requires this to be null on any connection a Worker uses.
  const common = { maxRetriesPerRequest: null, enableReadyCheck: false, password, tls };

  return useCluster
    ? new Redis.Cluster([{ host, port }], { redisOptions: common })
    : new Redis({ host, port, ...common });
}
```

Mirror whatever `sync/queue.js` actually reads for cluster/TLS options — copy its option names verbatim rather than inventing them.

- [ ] **Step 4: Implement the queue**

```js
// Backend/src/services/automation/queue.js
import { Queue } from 'bullmq';

import { buildRedisConnection } from '../redisConnection.js';

export const AUTOMATION_QUEUE_NAME = 'automation';

let queue = null;

/**
 * Deliberately separate from syncQueue (R7): a stuck sync backlog must not
 * delay billing. Lazily constructed so importing this module in a test does
 * not open a Redis connection.
 */
export function getAutomationQueue() {
  if (!queue) {
    queue = new Queue(AUTOMATION_QUEUE_NAME, { connection: buildRedisConnection() });
  }
  return queue;
}
```

- [ ] **Step 5: Implement fan-out**

```js
// Backend/src/services/automation/fanOut.js
import { automationPeriodKey } from '../../utils/automationPeriodKey.js';

export const KIND_INVOICE = 'invoice_automation';
export const KIND_STATEMENT = 'statement_automation';

// The prefix keeps an invoice and a statement falling on the same slot for
// the same board as two distinct jobs rather than one silently deduped away.
const KIND_PREFIX = {
  [KIND_INVOICE]: 'inv',
  [KIND_STATEMENT]: 'stmt',
};

/**
 * One job spec per board in the workspace.
 *
 * Every board is included: no eligibility concept exists in the data model
 * (Board.syncData governs ISO+ sync, not billing), and inventing a billing
 * flag is out of scope. Whether a board has anything to bill is the
 * generation step's question. If a real eligibility rule ever appears, this
 * is the only place it goes.
 */
export function buildFanOutSpecs({ kind, workspaceId, boards, slot, timezone }) {
  const periodKey = automationPeriodKey({ slot, timezone });
  const prefix = KIND_PREFIX[kind];

  return boards.map((board) => ({
    name: kind,
    data: { kind, workspaceId, boardId: board.boardId, slot, periodKey },
    opts: { jobId: `${prefix}:${board.boardId}:${periodKey}` },
  }));
}
```

- [ ] **Step 6: Run and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/automation.fanOut.test.js`
Expected: PASS — 5 tests

- [ ] **Step 7: Commit**

```bash
git add Backend/src/services/redisConnection.js Backend/src/services/automation/queue.js \
        Backend/src/services/automation/fanOut.js Backend/test/unit/services/automation.fanOut.test.js
git commit -m "feat: automation queue and per-board fan-out with idempotency keys"
```

---

## Task 12: Handler registration and the stub worker

**Files:**
- Modify: `Backend/src/services/scheduler/handlers.js`
- Create: `Backend/src/workers/automationWorker.js`
- Test: `Backend/test/unit/services/automation.handler.test.js`

**Interfaces:**
- Consumes: `register`, `AT_LEAST_ONCE` from `scheduler/registry.js`; `buildFanOutSpecs`, `KIND_INVOICE`, `KIND_STATEMENT`, `getAutomationQueue`; `AutomationSettings`; `Board`
- Produces: registrations for both kinds; `startAutomationWorker()`

- [ ] **Step 1: Write the failing test**

```js
// Backend/test/unit/services/automation.handler.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addBulk = vi.fn();
vi.mock('../../../src/services/automation/queue.js', () => ({
  AUTOMATION_QUEUE_NAME: 'automation',
  getAutomationQueue: () => ({ addBulk }),
}));

import Board from '../../../src/models/Board.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';
import { runAutomationKind } from '../../../src/services/scheduler/handlers.js';
import { KIND_INVOICE } from '../../../src/services/automation/fanOut.js';

const job = {
  targetId: 'ws-1',
  workspaceId: 'ws-1',
  timezone: 'Australia/Sydney',
  nextRunAt: new Date('2026-08-11T23:00:00Z'),
};

describe('runAutomationKind', () => {
  beforeEach(async () => {
    addBulk.mockReset();
    await Board.deleteMany({});
    await AutomationSettings.deleteMany({});
  });

  it('enqueues one job per board', async () => {
    await Board.collection.insertMany([
      { boardId: 'b1', workspaceId: 'ws-1' },
      { boardId: 'b2', workspaceId: 'ws-1' },
    ]);
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });

    await runAutomationKind(KIND_INVOICE, job);

    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0][0]).toHaveLength(2);
  });

  it('succeeds and enqueues nothing when the workspace has no boards', async () => {
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });
    await expect(runAutomationKind(KIND_INVOICE, job)).resolves.toBeUndefined();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when settings are missing', async () => {
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await expect(runAutomationKind(KIND_INVOICE, job)).resolves.toBeUndefined();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('no-ops when the block is disabled', async () => {
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: false } });
    await expect(runAutomationKind(KIND_INVOICE, job)).resolves.toBeUndefined();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('produces identical jobIds when the same slot is dispatched twice', async () => {
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });

    await Promise.all([runAutomationKind(KIND_INVOICE, job), runAutomationKind(KIND_INVOICE, job)]);

    const [firstCall, secondCall] = addBulk.mock.calls;
    expect(secondCall[0][0].opts.jobId).toBe(firstCall[0][0].opts.jobId);
  });
});
```

The last test is the double-fire assertion the plan demands. It asserts the two dispatches produce the **same** `jobId`, which is what makes BullMQ collapse them into one job. If it fails, the idempotency design is wrong, not the test.

- [ ] **Step 2: Run and watch it fail**

Run: `cd Backend && npx vitest run test/unit/services/automation.handler.test.js`
Expected: FAIL — `runAutomationKind` is not exported

- [ ] **Step 3: Implement the handler**

Add to `Backend/src/services/scheduler/handlers.js`:

```js
import Board from '../../models/Board.js';
import AutomationSettings from '../../models/AutomationSettings.js';
import { getAutomationQueue } from '../automation/queue.js';
import { buildFanOutSpecs, KIND_INVOICE, KIND_STATEMENT } from '../automation/fanOut.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';

const BLOCK_FOR_KIND = { [KIND_INVOICE]: 'invoice', [KIND_STATEMENT]: 'statement' };

/**
 * Exported for tests. A stale schedule whose settings are gone or disabled
 * must not throw: under AT_LEAST_ONCE a throw means no advance, so the same
 * dead schedule would be retried on every tick forever.
 */
export async function runAutomationKind(kind, { targetId, workspaceId, timezone, nextRunAt }) {
  const settings = await AutomationSettings.findOne({ workspaceId: mongoEq(targetId) }).lean();
  const block = settings?.[BLOCK_FOR_KIND[kind]];

  if (!block?.enabled) {
    warn('Automation', 'Schedule fired with no enabled settings; skipping', { kind, targetId });
    return;
  }

  const boards = await Board.find({ workspaceId: mongoEq(targetId) }).select('boardId').lean();

  // Zero boards is success, not failure. Treating it as failure would climb
  // consecutiveFailures on a workspace that is merely configured and idle,
  // and Epic 6 alerts on that field.
  if (boards.length === 0) {
    info('Automation', 'No boards to bill for workspace', { kind, targetId });
    return;
  }

  const specs = buildFanOutSpecs({ kind, workspaceId: workspaceId ?? targetId, boards, slot: nextRunAt, timezone });
  await getAutomationQueue().addBulk(specs);

  info('Automation', 'Enqueued automation jobs', { kind, targetId, count: specs.length });
}

export function registerAutomationHandlers() {
  for (const kind of [KIND_INVOICE, KIND_STATEMENT]) {
    // AT_LEAST_ONCE: the schedule advances only after the whole fan-out
    // succeeds, so a crash retries rather than silently skipping a billing
    // month. Duplicate billing is prevented by the per-board jobId, not by
    // the policy — see fanOut.js.
    register(kind, { policy: AT_LEAST_ONCE, handler: (job) => runAutomationKind(kind, job) });
  }
}
```

Call `registerAutomationHandlers()` from inside the existing `registerSchedulerHandlers()`.

- [ ] **Step 4: Implement the stub worker**

```js
// Backend/src/workers/automationWorker.js
import { Worker } from 'bullmq';

import { AUTOMATION_QUEUE_NAME } from '../services/automation/queue.js';
import { buildRedisConnection } from '../services/redisConnection.js';
import { info } from '../utils/logger.js';

/**
 * INTENTIONALLY INERT. This worker generates nothing and sends nothing.
 *
 * It exists so enqueued jobs are drained and completed rather than
 * accumulating and triggering BullMQ retry/backoff against a consumer that
 * was never meant to act. PDF generation and SES delivery are Epic 5 parts
 * 3-4 and replace the body of this handler.
 */
export function startAutomationWorker() {
  return new Worker(
    AUTOMATION_QUEUE_NAME,
    async (job) => {
      info('Automation', 'Received automation job (stub — nothing generated or sent)', {
        kind: job.data.kind,
        workspaceId: job.data.workspaceId,
        boardId: job.data.boardId,
        periodKey: job.data.periodKey,
      });
    },
    { connection: buildRedisConnection() },
  );
}
```

Start it alongside the sync worker in `src/index.js`.

- [ ] **Step 5: Run and watch it pass**

Run: `cd Backend && npx vitest run test/unit/services/automation.handler.test.js`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add Backend/src/services/scheduler/handlers.js Backend/src/workers/automationWorker.js \
        Backend/src/index.js Backend/test/unit/services/automation.handler.test.js
git commit -m "feat: register automation handlers and drain the queue with an inert worker"
```

---

## Task 13: Wire saving to the scheduler

**Files:**
- Modify: `Backend/src/routes/workspace.js` (the `PUT` handler from Task 3, and the `GET`)
- Modify: `Backend/src/utils/automationSettingsHelpers.js` (add `toScheduleInput`)
- Test: `Backend/test/integration/workspace.automation-settings.route.test.js` (extend)

**Interfaces:**
- Consumes: `upsertSchedule`, `disableSchedule` (Task 9); `KIND_INVOICE`, `KIND_STATEMENT`
- Produces: `toScheduleInput(block)` → `{ every, runOn, runAt, startDate }`

**Ordering matters: write the schedule first, settings second.** A failed schedule write then leaves the settings unchanged, so the UI keeps telling the truth rather than claiming "enabled" for something that will never fire.

- [ ] **Step 1: Write the failing test**

```js
it('creates a ScheduledJob when a block is enabled', async () => {
  await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
    invoice: {
      enabled: true,
      every: { n: 1, unit: 'month' },
      runOn: 15,
      runAt: '09:00',
      sendMethod: 'isoplus',
      recipient: 'billing_contact',
    },
  });

  const job = await ScheduledJob.findOne({ kind: 'invoice_automation', targetId: WS });
  expect(job).not.toBeNull();
  expect(job.enabled).toBe(true);
  expect(job.cron).toBeNull();
  expect(job.schedule.every.unit).toBe('month');
});

it('disables the ScheduledJob when the block is turned off', async () => {
  await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
    invoice: {
      enabled: true, every: { n: 1, unit: 'month' }, runOn: 15, runAt: '09:00',
      sendMethod: 'isoplus', recipient: 'billing_contact',
    },
  });
  await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
    invoice: { enabled: false },
  });

  const job = await ScheduledJob.findOne({ kind: 'invoice_automation', targetId: WS });
  expect(job.enabled).toBe(false);
});

it('returns nextRun from the linked job', async () => {
  await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
    invoice: {
      enabled: true, every: { n: 1, unit: 'month' }, runOn: 15, runAt: '09:00',
      sendMethod: 'isoplus', recipient: 'billing_contact',
    },
  });

  const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
  expect(res.body.invoice.nextRun).not.toBeNull();
});

it('leaves settings unchanged when the schedule write fails', async () => {
  const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
    invoice: {
      enabled: true, every: { n: 1, unit: 'month' }, runOn: 15, runAt: '09:00',
      sendMethod: 'isoplus', recipient: 'billing_contact', startDate: 'not-a-date',
    },
  });
  expect(res.status).toBe(400);
  const stored = await AutomationSettings.findOne({ workspaceId: WS });
  expect(stored).toBeNull();
});
```

Add the imports for `ScheduledJob` and `AutomationSettings` at the top of the test file.

- [ ] **Step 2: Run and watch it fail**

Run: `cd Backend && npx vitest run test/integration/workspace.automation-settings.route.test.js`
Expected: FAIL — no `ScheduledJob` is written; `nextRun` is null.

- [ ] **Step 3: Add `toScheduleInput`**

To `Backend/src/utils/automationSettingsHelpers.js`:

```js
/** The ScheduledJob.schedule projection of a settings block. */
export function toScheduleInput(block) {
  return {
    every: { n: block.every.n, unit: block.every.unit },
    runOn: block.runOn,
    runAt: block.runAt,
    startDate: block.startDate,
  };
}
```

- [ ] **Step 4: Wire the `PUT` handler**

First add the imports to `Backend/src/routes/workspace.js`, alongside the ones from Task 3:

```js
import ScheduledJob from '../models/ScheduledJob.js';
import { upsertSchedule, disableSchedule } from '../services/scheduler/schedules.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../services/automation/fanOut.js';
import { toScheduleInput } from '../utils/automationSettingsHelpers.js';
```

Then replace the body of the `PUT` handler's try block, after `parsed` is validated:

```js
const blocks = [
  { kind: KIND_INVOICE, block: parsed.value.invoice },
  { kind: KIND_STATEMENT, block: parsed.value.statement },
];

// Schedules first: if one fails we return 400/500 with the settings
// untouched, so the UI never claims "enabled" for something that cannot fire.
for (const { kind, block } of blocks) {
  if (block.enabled) {
    await upsertSchedule({
      kind,
      targetId: workspaceId,
      workspaceId,
      schedule: toScheduleInput(block),
    });
  } else {
    await disableSchedule({ kind, targetId: workspaceId });
  }
}

const settings = await AutomationSettings.findOneAndUpdate(
  { workspaceId: { $eq: workspaceId } },
  { $set: { workspaceId, ...parsed.value } },
  { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
).lean();

const jobs = await loadAutomationJobs(workspaceId);
return res.status(200).json(buildAutomationSettingsPayload(settings, jobs));
```

Catch a schedule validation error as a 400 rather than a 500 — it is caused by the request body:

```js
} catch (err) {
  const isValidation = /invalid schedule|exactly one|minimum interval/i.test(err.message);
  if (isValidation) return res.status(400).json({ message: err.message });
  // ... existing 500 path
}
```

- [ ] **Step 5: Add the job loader and wire the `GET`**

In `workspace.js`:

```js
async function loadAutomationJobs(workspaceId) {
  const jobs = await ScheduledJob.find({
    kind: { $in: [KIND_INVOICE, KIND_STATEMENT] },
    targetId: { $eq: workspaceId },
    enabled: true,
  }).select('kind nextRunAt').lean();

  return Object.fromEntries(jobs.map((job) => [job.kind, job]));
}
```

Replace the `{}` second argument in the `GET` handler with `await loadAutomationJobs(workspaceId)`.

- [ ] **Step 6: Run and watch it pass**

Run: `cd Backend && npx vitest run test/integration/workspace.automation-settings.route.test.js`
Expected: PASS — the 4 tests from Task 3 plus the 4 new ones.

- [ ] **Step 7: Commit**

```bash
git add Backend/src/routes/workspace.js Backend/src/utils/automationSettingsHelpers.js \
        Backend/test/integration/workspace.automation-settings.route.test.js
git commit -m "feat: saving automation settings creates and disables the schedule"
```

---

## Task 14: Coverage config and final verification

**Files:**
- Modify: `Backend/vitest.config.js`

- [ ] **Step 1: Add the new modules to coverage**

In the `coverage.include` array, keeping the file's existing grouping — services with services, utils with utils:

```js
'src/utils/automationScheduleHelpers.js',
'src/utils/automationSettingsHelpers.js',
'src/utils/automationPeriodKey.js',
'src/services/automation/**/*.js',
```

`src/services/scheduler/**/*.js` is already present from #855 and covers `advance.js`.

- [ ] **Step 2: Run the full backend suite**

Run: `cd Backend && npx vitest run`
Expected: PASS — all files, all tests. Record the counts for the PR body.

- [ ] **Step 3: Run the full frontend suite**

Run: `cd Frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Run the e2e suite**

Run: `npm run dev:up` from the repo root, then `cd Frontend && npx playwright test`
Expected: PASS.

- [ ] **Step 5: Verify the complexity gate**

Every new file must sit under cognitive complexity 15. If `workspace.js` has grown past it, extract the two handlers' bodies into `automationSettingsHelpers.js` — do not restructure unrelated parts of the file.

- [ ] **Step 6: Commit and update the PR**

```bash
git add Backend/vitest.config.js
git commit -m "test: include automation modules in the coverage report"
git push
```

Then update PR #857's body: it currently describes only `computeNextRun`. It needs the full scope, the real verification output from Steps 2–4, and the statement that it must not merge before #855.

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: data model → Tasks 1 and 8; components → Tasks 1–6 and 9–12; data flow save/read → Tasks 3 and 13, fire → Tasks 9–12; error handling → Tasks 2, 12, 13; testing → every task, plus Task 7 for e2e. The spec's open question on authorization is resolved explicitly in Task 3.

**Two errata against the spec**, recorded at the top: `upsertSchedule` needed extending rather than merely calling, and `assertMinimumInterval` is cron-only and is skipped for picker schedules with reasoning.

**Third erratum, found during self-review.** An earlier draft imported `buildRedisConnection` from `sync/queue.js`. That function does not exist — `sync/queue.js` exports a shared `redisConnection` *instance*, and `syncWorker.js` duplicates ~60 lines of config to get its own, because BullMQ Workers block on their connection and cannot share one. Task 11 now adds `services/redisConnection.js` for the new modules only, deliberately not retrofitting the sync modules.

**Deliberately deferred**, carried from the spec: mid-cycle schedule edits shifting `periodKey`; disable-mid-tick still dispatching; boards in one workspace unable to bill on different cycles; `missedRuns` staying zero under `AT_LEAST_ONCE`.
