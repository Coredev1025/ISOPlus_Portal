import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutomationScheduleBlock } from "@/lib/automation-schedule-block";
import type { AutomationBlock } from "@/lib/automation-settings";

/**
 * KAN-262. The client asked for the Next Run caption to be cut back to the one
 * thing it needs to say — which zone the time is in.
 *
 * The zone stays named. The row is deliberately not in the reader's local
 * time: it is the same clock as Run At above it, so a reader in another
 * country reads their own morning into a bare "7:02 PM". What was dropped is
 * "Calculated by the scheduler — read-only.", which the disabled-looking
 * input already says by being one.
 */
const block = (overrides: Partial<AutomationBlock> = {}): AutomationBlock => ({
  enabled: true,
  every: { n: 1, unit: "month" },
  runOn: 1,
  runAt: "09:00",
  startDate: "2026-09-01",
  sendMethod: "isoplus",
  recipient: "billing_contact",
  sendCopyTo: "",
  replyTo: "",
  emailFrom: "",
  emailSubject: "",
  emailMessage: "",
  nextRun: "2027-08-20T11:02:00.000Z",
  timezone: "Australia/Perth",
  ...overrides,
});

const renderBlock = (value: AutomationBlock) =>
  render(
    <AutomationScheduleBlock
      idPrefix="invoice"
      label="Invoice Automation"
      value={value}
      onChange={() => {}}
    />,
  );

describe("AutomationScheduleBlock — the Next Run caption", () => {
  it("names the timezone the time is shown in", () => {
    renderBlock(block());
    expect(screen.getByText("Times shown in Australia/Perth.")).toBeInTheDocument();
  });

  // The zone comes from the block the API sent, which after KAN-262 always
  // tracks the business's Head Office Timezone. Nothing in this component
  // pins it, so changing the business changes the caption.
  it("follows whatever timezone the block carries", () => {
    renderBlock(block({ timezone: "Australia/Melbourne" }));
    expect(screen.getByText("Times shown in Australia/Melbourne.")).toBeInTheDocument();
  });

  it("drops the scheduler/read-only preamble the client asked to remove", () => {
    renderBlock(block());
    expect(screen.queryByText(/Calculated by the scheduler/)).not.toBeInTheDocument();
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
  });
});

/**
 * KAN-263. Run At is the ISO+-style spinner field, not three dropdowns: the
 * client pointed at the "Scheduled Shift Start Date & Time" picker as the look
 * to copy. The block reads the stored HH:mm straight into it.
 */
describe("AutomationScheduleBlock — Run At", () => {
  it("is the spinner field, showing the stored time on a 12-hour clock", () => {
    renderBlock(block({ runAt: "17:30" }));
    expect(screen.getByRole("button", { name: /run at/i })).toHaveTextContent("5:30 PM");
  });

  it("no longer offers the hour / minute / AM-PM dropdowns", () => {
    renderBlock(block({ runAt: "17:30" }));
    expect(screen.queryByRole("combobox", { name: /run at hour/i })).not.toBeInTheDocument();
  });
});
