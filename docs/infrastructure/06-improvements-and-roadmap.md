# Improvements and Roadmap — Automated Invoicing and Statement Delivery

**Status:** Proposed. Not in the approved scope, not scheduled, not estimated for delivery.
**Purpose:** Items identified during the Epic 5 and 6 build that fall outside the agreed scope. Each needs client approval and budget before any work starts.
**Raised:** 20 August 2026

---

## How to read this

Everything here was found while building the approved scope. None of it is a defect: the system meets what was specified. These are places where the specification stops short of what the business will eventually want.

Sizing is **relative complexity**, not days. `S` is a contained change in one place, `M` touches a few components, `L` needs data model, API and UI together.

| | |
|---|---|
| In scope, already delivered | Monitoring that can be configured in AWS |
| Out of scope, listed below | Anything requiring application code or UI changes |

---

## What monitoring already exists

Delivered, no further budget required.

| Capability | How |
|---|---|
| Alert when the event pipeline stalls | CloudWatch alarm, emails the operations address |
| Alert when a message fails processing repeatedly | CloudWatch alarm on the dead letter queue |
| Delivery and bounce events captured durably | SES publishes to SNS, buffered in SQS for 14 days |
| Every bounce and complaint attributed to its invoice | Recorded against the document record, with a plain-English reason |
| Raw delivery and bounce notifications by email | An email subscription on the events topic, **dev only** |
| Automation status across every client | System Health screen, System Owner and Support Admin roles only |

**One limitation worth stating.** The raw email subscription is practical in dev, where volume is low. It is deliberately switched off in production, because at production volume it produces one email per delivery event — thousands a day. So production has the *data* but no *push notification* of a failure. That is the gap item 1 addresses.

---

## 1. Failure notification to ISO+ · `S`

**What.** When an invoice or statement permanently fails to reach a participant, notify the ISO+ operations address. Permanent bounces and complaints only, not deliveries or transient retries.

**Why.** Production has no push notification of a delivery failure. The information is recorded and visible on the System Health screen, but only to somebody who opens it. For invoicing, the first sign of a problem should not be a client asking why they were not paid.

**Approach.** The delivery-event handler already distinguishes a permanent bounce from a transient one and already holds a human-readable reason for each. Publishing those to the existing alerts topic reuses the notification path the CloudWatch alarms already use, so failures arrive in the same place as infrastructure alerts rather than a second inbox.

**Dependency.** None. Smallest item here and the one with the highest ratio of value to effort.

---

## 2. Per-run failure summary to the workspace · `M`

**What.** After an automation run completes, if anything failed to deliver, email the client organisation a single summary: how many documents went out, how many did not, which participants are affected, and why in plain language.

**Why.** The client organisation currently has no visibility of a failed send at all. The System Health screen is restricted to System Owner and Support Admin, correctly — it shows automation status across *every* client, so it cannot be opened to client staff. That leaves the people who can actually fix a wrong email address unaware that one exists.

**Approach.** One digest per run, not one message per failure. A systemic problem — an expired accounting-platform connection, a misconfigured sender — would otherwise generate one email per participant. A digest also gives the recipient something they can act on in one sitting.

The reasons are already written for a non-technical reader: *"Email address doesn't exist"*, *"This address bounced before, so it is on the suppression list."* No new copywriting needed.

**Dependency.** Item 3, to know who receives it.

---

## 3. Notification recipient setting · `M`

**What.** A configurable recipient for automation notifications, per workspace, alongside the existing automation email settings.

**Why.** There is no notification-recipient concept in the data model today. Item 2 has nowhere to send to without it.

**Approach.** Not the participant billing contact, and not the provider's own address. The person who fixes a bad email address is an operations or finance role, not necessarily whoever receives invoices. This should be its own setting so the two can differ.

**Dependency.** Blocks item 2.

---

## 4. Delivery status in the client-facing invoice list · `L`

**What.** A status column on the invoice and statement lists the client organisation already uses: Delivered, Bounced, Not sent, with the failure reason available on the row.

**Why.** Answers "did this go out?" at the moment somebody is already looking at the invoice, rather than requiring them to remember a notification from days earlier.

**Approach.** The delivery state is already recorded per document, so this is presentation rather than new data capture. It needs an API surface scoped to a single workspace — distinct from the cross-client System Health API, which must stay restricted.

**Dependency.** None technically. Lowest priority of the four, because a notification reaches someone whether or not they think to look, and a screen only rewards curiosity.

---

## 5. Bounce handling policy · decision first, then `S`–`M`

**What.** Decide what happens after a permanent bounce, then implement it.

**Why.** A permanent bounce means that participant was not invoiced for that period. Three questions have no answer today:

- Does the next scheduled run retry them, or skip them until somebody intervenes?
- Should an unresolved bounce hold back the participant's next invoice, or continue and accumulate?
- At what point does a repeatedly failing address stop being retried?

**Approach.** This is a business decision before it is a technical one, and the answer changes what gets built. Worth settling before items 1 and 2 are specified in detail, since both surface the outcome.

**Dependency.** None, but it shapes items 1 and 2.

---

## Suggested order

| Order | Item | Rationale |
|---|---|---|
| 1 | Item 5, the policy decision | Costs nothing and shapes the rest |
| 2 | Item 1, ISO+ notification | Smallest change, closes the production blind spot |
| 3 | Items 3 then 2, workspace digest | The client-facing half, in dependency order |
| 4 | Item 4, in-app status | Presentation only, valuable once the notifications exist |

Items 1, 2, 3 and 5 together give both audiences a push notification of failure. Item 4 is a convenience on top.

---

## Explicitly not proposed here

**A general notification service.** Nothing above needs one. Each item reuses the delivery and alerting paths that already exist.

**Opening System Health to client staff.** It shows automation status across every client. The role restriction to System Owner and Support Admin is correct and should stay. Item 4 is the client-facing alternative, scoped to a single workspace.
