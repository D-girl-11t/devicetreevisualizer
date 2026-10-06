import { findByPath, parseDts } from "./parse";
import { compatibleOf, statusOf } from "./format";
import { examples } from "./samples";
import { describe, expect, test } from "vitest";

describe("bundled examples", () => {
  test("Halcyon parses cleanly and keeps a disabled UART", () => {
    const doc = parseDts(examples[0].source);
    expect(doc.errors).toEqual([]);
    expect(doc.warnings).toEqual([]);
    expect(statusOf(findByPath(doc.root!, "/soc/serial@a40000")!)).toBe("disabled");
    expect(compatibleOf(findByPath(doc.root!, "/soc/ethernet@a80000/mdio/ethernet-phy@1")!)).toEqual([
      "ethernet-phy-ieee802.3-c22",
    ]);
  });

  test("the cape overlay merges, deletes, and leaves one unresolved reference", () => {
    const doc = parseDts(examples[1].source);
    expect(doc.errors).toEqual([]);
    expect(doc.plugin).toBe(true);
    expect(doc.warnings.length).toBeGreaterThan(0);
    expect(statusOf(findByPath(doc.root!, "/soc/serial@a40000")!)).toBe("okay");
    expect(findByPath(doc.root!, "/soc/i2c@a50000/temp@48")?.deleted).toBe(true);
    expect(findByPath(doc.root!, "/soc/i2c@a50000/humidity@40")?.fromOverlay).toBe(true);
    expect(findByPath(doc.root!, "/leds/cape")?.fromOverlay).toBe(true);
    expect(doc.unresolved.map((node) => node.path)).toContain("&not_on_this_board");
  });

  test("the minimal tree applies its fragment", () => {
    const doc = parseDts(examples[2].source);
    expect(doc.errors).toEqual([]);
    const uart = findByPath(doc.root!, "/serial@1000");
    expect(uart?.properties.some((property) => property.name === "current-speed" && property.fromOverlay)).toBe(
      true,
    );
  });
});