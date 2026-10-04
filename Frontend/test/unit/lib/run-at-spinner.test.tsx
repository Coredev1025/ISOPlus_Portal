import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunAtSpinner } from "@/lib/run-at-spinner";

/**
 * KAN-263. Run At looks like the ISO+ "Scheduled Shift Start Date & Time"
 * picker the client pointed at: a field showing the time that opens a panel of
 * hour : minute spinners with up/down arrows, Cancel and Select — plus the
 * AM/PM column the client asked to have added.
 *
 * The value in and out is still `HH:mm` on a 24-hour clock; only Select hands
 * a new one back, so an abandoned panel can never retime a client's schedule.
 */
const renderSpinner = (value: string) => {
  const onChange = vi.fn();
  render(<RunAtSpinner id="invoice-run-at" value={value} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
};

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /run at/i }));
  return screen.getByRole("dialog", { name: /choose the run at time/i });
};

const column = (panel: HTMLElement, name: RegExp) => within(panel).getByRole("spinbutton", { name });

describe("RunAtSpinner", () => {
  it("shows the stored time on the 12-hour clock", () => {
    renderSpinner("00:27");
    expect(screen.getByRole("button", { name: /run at/i })).toHaveTextContent("12:27 AM");
  });

  it("opens on the stored time", async () => {
    const { user } = renderSpinner("17:05");
    const panel = await open(user);
    expect(column(panel, /^hour$/i)).toHaveTextContent("5");
    expect(column(panel, /^minute$/i)).toHaveTextContent("05");
    expect(column(panel, /am or pm/i)).toHaveTextContent("PM");
  });

  it("hands back HH:mm when Select is pressed", async () => {
    const { user, onChange } = renderSpinner("09:00");
    const panel = await open(user);

    await user.click(within(panel).getByRole("button", { name: /increase hour/i }));
    await user.click(within(panel).getByRole("button", { name: /decrease minute/i }));
    await user.click(within(panel).getByRole("button", { name: /increase am or pm/i }));
    expect(within(panel).getByText("10:59 PM")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /^select$/i }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("22:59");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Midnight and noon: the two 12s a naive conversion gets backwards.
  it("hands back 12 AM as 00 and 12 PM as 12", async () => {
    const { user, onChange } = renderSpinner("11:30");
    let panel = await open(user);
    await user.click(within(panel).getByRole("button", { name: /increase hour/i }));
    await user.click(within(panel).getByRole("button", { name: /^select$/i }));
    expect(onChange).toHaveBeenLastCalledWith("00:30");

    panel = await open(user);
    await user.click(within(panel).getByRole("button", { name: /increase am or pm/i }));
    await user.click(within(panel).getByRole("button", { name: /^select$/i }));
    expect(onChange).toHaveBeenLastCalledWith("23:30");
  });

  it("changes nothing when Cancel is pressed", async () => {
    const { user, onChange } = renderSpinner("09:00");
    const panel = await open(user);
    await user.click(within(panel).getByRole("button", { name: /increase hour/i }));
    await user.click(within(panel).getByRole("button", { name: /cancel/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run at/i })).toHaveTextContent("9:00 AM");
  });

  it("forgets a cancelled draft when it is opened again", async () => {
    const { user } = renderSpinner("09:00");
    let panel = await open(user);
    await user.click(within(panel).getByRole("button", { name: /increase hour/i }));
    await user.keyboard("{Escape}");

    panel = await open(user);
    expect(column(panel, /^hour$/i)).toHaveTextContent("9");
  });

  it("steps the focused column with the arrow keys", async () => {
    const { user } = renderSpinner("09:00");
    const panel = await open(user);
    column(panel, /^minute$/i).focus();
    await user.keyboard("{ArrowDown}");
    expect(column(panel, /^minute$/i)).toHaveTextContent("59");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(column(panel, /^minute$/i)).toHaveTextContent("01");
  });
});
