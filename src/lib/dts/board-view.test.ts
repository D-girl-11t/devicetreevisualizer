import { describe, expect, test } from "vitest";
import { summarizeBoard } from "./brief";
import { analyzeBringup } from "./bringup";
import { analyzeMemoryMap, formatAddress } from "./memory-map";
import { parseDts } from "./parse";
import { examples } from "./samples";

function view(id: string) {
  const example = examples.find((item) => item.id === id);
  if (!example) throw new Error(id);
  const doc = parseDts(example.source);
  const board = analyzeBringup(doc);
  const map = analyzeMemoryMap(doc);
  return { doc, board, map, brief: summarizeBoard(doc, board, map) };
}

describe("memory map", () => {
  test("places Halcyon RAM, the reserve, and the UART windows", () => {
    const { map } = view("halcyon");
    const ram = map.regions.find((region) => region.kind === "ram");
    expect(ram?.start).toBe(0x80000000n);
    expect(ram?.size).toBe(0x40000000n);

    const reserve = map.regions.find((region) => region.kind === "memreserve");
    expect(reserve?.start).toBe(0x88000000n);
    expect(reserve?.size).toBe(0x10000n);

    const cma = map.regions.find((region) => region.title === "linux,cma");
    expect(cma?.kind).toBe("pool");
    expect(cma?.start).toBeNull();
    expect(cma?.size).toBe(0x14000000n);

    const uart1 = map.regions.find((region) => region.path === "/soc/serial@a41000");
    expect(uart1?.start).toBe(0xa41000n);
    expect(uart1?.size).toBe(0x1000n);
    expect(uart1?.enabled).toBe(true);

    const uart0 = map.regions.find((region) => region.path === "/soc/serial@a40000");
    expect(uart0?.enabled).toBe(false);

    expect(map.regions.some((region) => region.path === "/soc/i2c@a50000/eeprom@50")).toBe(false);

    const gic = map.regions.filter((region) => region.path === "/soc/interrupt-controller@a01000");
    expect(gic.map((region) => region.start)).toEqual([0xa01000n, 0xa02000n]);
    expect(map.notes).toEqual([]);
  });

  test("translates a non-empty ranges window and a two-cell address", () => {
    const translated = analyzeMemoryMap(
      parseDts(`
        / {
          #address-cells = <1>;
          #size-cells = <1>;
          soc {
            #address-cells = <1>;
            #size-cells = <1>;
            ranges = <0x0 0x80000000 0x100000>;
            serial@1000 { compatible = "example,uart"; reg = <0x1000 0x100>; status = "okay"; };
          };
        };
      `),
    );
    expect(translated.regions.find((region) => region.title === "serial@1000")?.start).toBe(0x80001000n);

    const wide = analyzeMemoryMap(
      parseDts(`
        / {
          #address-cells = <2>;
          #size-cells = <2>;
          memory@0 { device_type = "memory"; reg = <0x0 0x80000000 0x0 0x40000000>; };
        };
      `),
    );
    const ram = wide.regions.find((region) => region.kind === "ram");
    expect(formatAddress(ram!.start!)).toBe("0x80000000");
    expect(ram?.size).toBe(0x40000000n);
  });
});

describe("board brief", () => {
  test("tells the Halcyon story: console off, pins, and the projects that fit", () => {
    const { brief } = view("halcyon");
    expect(brief.title).toBe("Halcyon HC1 Evaluation Board");
    expect(brief.board).toContain("1 GiB at 0x80000000");
    expect(brief.board).toContain("Two CPUs");
    expect(brief.board).toContain("1.2 GHz");
    expect(brief.board).toContain("serial0:115200n8");
    expect(brief.pins).toContain("gpio1-io04");
    expect(brief.pins).toContain("uart0grp");
    expect(brief.pins).toContain("i2c@a50000");
    expect(brief.inactive).toContain("serial@a40000");
    expect(brief.inactive).toContain("usb@a90000");
    expect(brief.inactive).toContain("boot console");
    expect(brief.scope).toContain("/dev/ttyS1");
    expect(brief.scope).toContain("network");
    expect(brief.scope).toContain("serial@a40000");
    expect(brief.scope).toContain("not a schematic");
  });

  test("the cape mentions the skipped include and the removed sensor", () => {
    const { brief } = view("overlay");
    expect(brief.inactive).toContain("temp@48");
    expect(brief.scope).toContain("not expanded");
  });
});
