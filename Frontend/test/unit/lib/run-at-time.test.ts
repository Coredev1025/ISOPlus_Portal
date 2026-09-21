import { describe, it, expect } from "vitest";
import { parseRunAt, toRunAt, HOUR_OPTIONS, MINUTE_OPTIONS, MERIDIEM_OPTIONS } from "@/lib/run-at-time";

/**
 * KAN-263. The picker is three dropdowns, but the stored value is unchanged:
 * `HH:mm` on a 24-hour clock, which is what RUN_AT_PATTERN validates and what
 * the scheduler reads. These two functions are the whole conversion, so the
 * midnight and noon corners live or die here.
 */
describe("parseRunAt", () => {
  it("reads a morning time", () => {
    expect(parseRunAt("09:00")).toEqual({ hour: "9", minute: "00", meridiem: "AM" });
  });

  it("reads an afternoon time as its 12-hour equivalent", () => {
    expect(parseRunAt("17:30")).toEqual({ hour: "5", minute: "30", meridiem: "PM" });
  });

  // The two corners every 12-hour conversion gets wrong: midnight is 12 AM,
  // not 0 AM, and noon is 12 PM, not 0 PM.
  it("reads midnight as 12 AM", () => {
    expect(parseRunAt("00:00")).toEqual({ hour: "12", minute: "00", meridiem: "AM" });
  });

  it("reads noon as 12 PM", () => {
    expect(parseRunAt("12:00")).toEqual({ hour: "12", minute: "00", meridiem: "PM" });
  });

  it("reads the last minute before midnight", () => {
    expect(parseRunAt("23:59")).toEqual({ hour: "11", minute: "59", meridiem: "PM" });
  });

  // A stored value the picker cannot show would otherwise blank the field and
  // silently rewrite the client's schedule on the next save.
  it("falls back to 9 AM for a value it cannot read", () => {
    for (const bad of ["", "nonsense", "24:00", "09:60", null, undefined]) {
      expect(parseRunAt(bad as unknown as string)).toEqual({
        hour: "9", minute: "00", meridiem: "AM",
      });
    }
  });
});

describe("toRunAt", () => {
  it("writes a morning time back on the 24-hour clock", () => {
    expect(toRunAt({ hour: "9", minute: "00", meridiem: "AM" })).toBe("09:00");
  });

  it("writes an afternoon time back on the 24-hour clock", () => {
    expect(toRunAt({ hour: "5", minute: "30", meridiem: "PM" })).toBe("17:30");
  });

  it("writes 12 AM as midnight", () => {
    expect(toRunAt({ hour: "12", minute: "00", meridiem: "AM" })).toBe("00:00");
  });

  it("writes 12 PM as noon", () => {
    expect(toRunAt({ hour: "12", minute: "15", meridiem: "PM" })).toBe("12:15");
  });

  it("always pads to the HH:mm the scheduler validates", () => {
    expect(toRunAt({ hour: "1", minute: "5", meridiem: "AM" })).toBe("01:05");
  });
});

describe("the round trip", () => {
  // Every minute of the day, because an off-by-one at any boundary moves a
  // client's billing run by an hour.
  it("survives all 1440 minutes unchanged", () => {
    for (let h = 0; h < 24; h += 1) {
      for (let m = 0; m < 60; m += 1) {
        const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        expect(toRunAt(parseRunAt(value))).toBe(value);
      }
    }
  });
});

describe("the options offered", () => {
  it("offers 1 to 12, not 0 to 23", () => {
    expect(HOUR_OPTIONS.map((o) => o.value)).toEqual(
      ["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    );
  });

  // All 60, not 5-minute steps: the native input this replaces accepted any
  // minute, and a workspace already on 09:07 must not be silently moved.
  it("offers every minute, so no stored value becomes unreachable", () => {
    expect(MINUTE_OPTIONS).toHaveLength(60);
    expect(MINUTE_OPTIONS[0]).toEqual({ value: "00", label: "00" });
    expect(MINUTE_OPTIONS[7]).toEqual({ value: "07", label: "07" });
    expect(MINUTE_OPTIONS[59]).toEqual({ value: "59", label: "59" });
  });

  it("offers AM and PM, which is what the client asked for", () => {
    expect(MERIDIEM_OPTIONS.map((o) => o.value)).toEqual(["AM", "PM"]);
  });
});
