import { describe, it, expect } from "vitest";
import {
  runOnOptionsForUnit,
  defaultRunOnForUnit,
} from "@/lib/automation-run-on-options";

describe("runOnOptionsForUnit", () => {
  it("gives no options for day", () => {
    expect(runOnOptionsForUnit("day").kind).toBe("none");
    expect(runOnOptionsForUnit("day").options).toHaveLength(0);
  });

  it("gives seven weekdays for week, starting Monday", () => {
    const { kind, options } = runOnOptionsForUnit("week");
    expect(kind).toBe("weekday");
    expect(options).toHaveLength(7);
    expect(options[0].value).toBe("monday");
  });

  it("offers days 1-31 for month; the scheduler clamps 29-31 in short months", () => {
    const { kind, options } = runOnOptionsForUnit("month");
    expect(kind).toBe("day-of-month");
    expect(options).toHaveLength(31);
    expect(options[30].value).toBe(31);
  });

  it("uses month+day for quarter and year", () => {
    expect(runOnOptionsForUnit("quarter").kind).toBe("month-day");
    expect(runOnOptionsForUnit("year").kind).toBe("month-day");
  });
});

describe("defaultRunOnForUnit", () => {
  it("returns a unit-appropriate default", () => {
    expect(defaultRunOnForUnit("day")).toBe(null);
    expect(defaultRunOnForUnit("week")).toBe("monday");
    expect(defaultRunOnForUnit("month")).toBe(1);
    expect(defaultRunOnForUnit("quarter")).toEqual({ month: 1, day: 1 });
    expect(defaultRunOnForUnit("year")).toEqual({ month: 1, day: 1 });
  });
});
