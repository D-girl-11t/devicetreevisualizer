import { findByPath, parseDts } from "./parse";
import { compatibleOf, propertyByName, statusOf, stringValues } from "./format";
import { describe, expect, test } from "vitest";

function prop(path: string, source: string, name: string) {
  const doc = parseDts(source);
  expect(doc.errors, JSON.stringify(doc.errors, null, 2)).toEqual([]);
  const node = findByPath(doc.root!, path);
  expect(node, path).toBeTruthy();
  return propertyByName(node!, name);
}

describe("parseDts", () => {
  test("parses the root model, compatible list, and nested paths", () => {
    const source = `
      /dts-v1/;
      / {
        model = "Halcyon";
        compatible = "halcyon,board", "halcyon,soc";
        #address-cells = <1>;
        #size-cells = <1>;
        soc {
          serial@101f1000 {
            compatible = "arm,pl011";
            reg = <0x101f1000 0x1000>;
          };
        };
      };
    `;
    const doc = parseDts(source);
    expect(doc.errors).toEqual([]);
    expect(doc.hasVersion).toBe(true);
    expect(stringValues(propertyByName(doc.root!, "model"))).toEqual(["Halcyon"]);
    expect(compatibleOf(doc.root!)).toEqual(["halcyon,board", "halcyon,soc"]);
    const serial = findByPath(doc.root!, "/soc/serial@101f1000");
    expect(serial?.fullName).toBe("serial@101f1000");
    expect(stringValues(propertyByName(serial!, "compatible"))).toEqual(["arm,pl011"]);
    const reg = propertyByName(serial!, "reg");
    expect(reg?.parts[0]).toMatchObject({
      kind: "cells",
      cells: [
        { kind: "number", raw: "0x101f1000" },
        { kind: "number", raw: "0x1000" },
      ],
    });
  });

  test("keeps labels, booleans, bytes, phandles, and string concatenation", () => {
    const source = `
      / {
        uart0: serial@1000 {
          compatible = "acme," "uart";
          status = "disabled";
          interrupt-controller;
          local-mac-address = [00 1a 2b 3c 4d 5e];
          interrupt-parent = <&intc>;
        };
        aliases {
          serial0 = &uart0;
        };
      };
    `;
    const doc = parseDts(source);
    expect(doc.errors).toEqual([]);
    const uart = findByPath(doc.root!, "/serial@1000");
    expect(uart?.labels).toEqual(["uart0"]);
    expect(stringValues(propertyByName(uart!, "compatible"))).toEqual(["acme,uart"]);
    expect(propertyByName(uart!, "interrupt-controller")?.boolean).toBe(true);
    expect(propertyByName(uart!, "local-mac-address")?.parts[0]).toMatchObject({
      kind: "bytes",
      bytes: [0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e],
    });
    const alias = propertyByName(findByPath(doc.root!, "/aliases")!, "serial0");
    expect(alias?.parts[0]).toEqual({ kind: "phandle", ref: { kind: "label", label: "uart0" } });
  });

  test("ignores comments and records memory reservations", () => {
    const source = `
      /dts-v1/;
      /plugin/;
      /memreserve/ 0x80000000 0x1000;
      /* header
         comment */
      / { // root
        model = "x";
      };
    `;
    const doc = parseDts(source);
    expect(doc.errors).toEqual([]);
    expect(doc.plugin).toBe(true);
    expect(doc.memreserves).toEqual([{ address: "0x80000000", size: "0x1000", line: 4 }]);
    expect(stringValues(propertyByName(doc.root!, "model"))).toEqual(["x"]);
  });

  test("merges a forward label overlay and adds a child", () => {
    const source = `
      &uart0 {
        status = "okay";
        pinctrl-0 = <&pinctrl 1>;
      };
      / {
        uart0: serial@1000 {
          compatible = "acme,uart";
          status = "disabled";
        };
        i2c@20 {
          #address-cells = <1>;
          temp@48 { compatible = "ti,tmp102"; reg = <0x48>; };
        };
      };
      &{/i2c@20} {
        humidity@40 {
          compatible = "aosong,am2320";
          reg = <0x40>;
        };
      };
    `;
    const doc = parseDts(source);
    expect(doc.errors).toEqual([]);
    expect(doc.unresolved).toEqual([]);
    const uart = findByPath(doc.root!, "/serial@1000");
    expect(statusOf(uart!)).toBe("okay");
    expect(uart?.modifiedByOverlay).toBe(true);
    expect(propertyByName(uart!, "status")?.fromOverlay).toBe(true);
    expect(compatibleOf(uart!)).toEqual(["acme,uart"]);
    const humidity = findByPath(doc.root!, "/i2c@20/humidity@40");
    expect(humidity?.fromOverlay).toBe(true);
    expect(compatibleOf(humidity!)).toEqual(["aosong,am2320"]);
  });

  test("deletes nodes and properties from an overlay", () => {
    const source = `
      / {
        i2c {
          temp@48 { compatible = "ti,tmp102"; };
          eeprom@50 { compatible = "atmel,24c32"; status = "okay"; };
        };
        serial { clock-names = "ipg"; status = "disabled"; };
      };
      &{/i2c} {
        /delete-node/ temp@48;
      };
      &{/serial} {
        /delete-property/ clock-names;
        status = "okay";
      };
    `;
    const doc = parseDts(source);
    expect(doc.errors).toEqual([]);
    const temp = findByPath(doc.root!, "/i2c/temp@48");
    expect(temp?.deleted).toBe(true);
    const eeprom = findByPath(doc.root!, "/i2c/eeprom@50");
    expect(eeprom?.deleted).toBe(false);
    const serial = findByPath(doc.root!, "/serial");
    expect(propertyByName(serial!, "clock-names")).toBeUndefined();
    expect(serial?.properties.find((item) => item.name === "clock-names")?.deleted).toBe(true);
    expect(statusOf(serial!)).toBe("okay");
  });

  test("preserves symbols, expressions, bit widths, and incbin", () => {
    const taken = prop(
      "/gpio",
      `
        / {
          gpio {
            gpios = <&gpio1 8 GPIO_ACTIVE_LOW>;
            mask = <(1 << 5)>;
            raw = /bits/ 8 [0f ff];
            logo = /incbin/("logo.bin", 0x100, 0x20);
          };
        };
      `,
      "gpios",
    );
    expect(taken?.parts[0]).toMatchObject({
      kind: "cells",
      cells: [
        { kind: "ref", ref: { kind: "label", label: "gpio1" } },
        { kind: "number", raw: "8" },
        { kind: "symbol", name: "GPIO_ACTIVE_LOW" },
      ],
    });
    const doc = parseDts(`
      / {
        gpio {
          gpios = <&gpio1 8 GPIO_ACTIVE_LOW>;
          mask = <(1 << 5)>;
          raw = /bits/ 8 [0f ff];
          logo = /incbin/("logo.bin", 0x100, 0x20);
        };
      };
    `);
    const gpio = findByPath(doc.root!, "/gpio")!;
    expect(propertyByName(gpio, "mask")?.parts[0]).toMatchObject({
      kind: "cells",
      cells: [{ kind: "expr", raw: "(1 << 5)" }],
    });
    expect(propertyByName(gpio, "raw")?.parts[0]).toMatchObject({
      kind: "bytes",
      bits: 8,
      bytes: [0x0f, 0xff],
    });
    expect(propertyByName(gpio, "logo")?.parts[0]).toMatchObject({
      kind: "incbin",
      file: "logo.bin",
      offset: "0x100",
      size: "0x20",
    });
  });

  test("warns on preprocessor directives without eating #address-cells", () => {
    const doc = parseDts(`
      #include "board.h"
      #define GPIO_ACTIVE_LOW 1
      / {
        #address-cells = <1>;
        soc { compatible = "simple-bus"; };
      };
    `);
    expect(doc.errors).toEqual([]);
    expect(propertyByName(doc.root!, "#address-cells")?.parts[0]).toMatchObject({
      kind: "cells",
    });
    expect(doc.warnings.map((issue) => issue.message).join("\n")).toMatch(/#include/);
    expect(doc.warnings.map((issue) => issue.message).join("\n")).toMatch(/#define/);
  });

  test("reports an unresolved fragment and a syntax error without dropping the rest", () => {
    const doc = parseDts(`
      / {
        ok { compatible = "acme,ok"; };
        !!! ;
        later { status = "okay"; };
      };
      &missing { status = "okay"; };
    `);
    expect(doc.errors.length).toBeGreaterThan(0);
    expect(compatibleOf(findByPath(doc.root!, "/ok")!)).toEqual(["acme,ok"]);
    expect(statusOf(findByPath(doc.root!, "/later")!)).toBe("okay");
    expect(doc.unresolved.map((node) => node.path)).toEqual(["&missing"]);
  });

  test("omits unreferenced /omit-if-no-ref/ nodes and keeps referenced ones", () => {
    const doc = parseDts(`
      / {
        /omit-if-no-ref/ hidden: secret {
          compatible = "acme,secret";
        };
        /omit-if-no-ref/ used: widget {
          compatible = "acme,widget";
        };
        consumer { link = <&used>; };
      };
    `);
    expect(doc.errors).toEqual([]);
    expect(findByPath(doc.root!, "/secret")?.omitted).toBe(true);
    expect(findByPath(doc.root!, "/widget")?.deleted).toBe(false);
    expect(findByPath(doc.root!, "/widget")?.omitted).toBe(false);
  });

  test("accepts multiple cell groups and a path reference", () => {
    const doc = parseDts(`
      / {
        bus {
          reg = <0x0 0x1000>, <0x2000 0x10>;
        };
      };
      &{/bus} { status = "okay"; };
    `);
    expect(doc.errors).toEqual([]);
    const reg = propertyByName(findByPath(doc.root!, "/bus")!, "reg");
    expect(reg?.parts).toHaveLength(2);
    expect(statusOf(findByPath(doc.root!, "/bus")!)).toBe("okay");
  });

  test("escapes strings and rejects an empty file", () => {
    const doc = parseDts(`/ { model = "a \\"quote\\""; };`);
    expect(stringValues(propertyByName(doc.root!, "model"))).toEqual(['a "quote"']);
    expect(parseDts("   ").errors[0]?.message).toMatch(/empty/i);
  });
});
