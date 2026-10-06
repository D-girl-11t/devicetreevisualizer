import { decompileDtb, isDtb } from "./dtb";
import { findByPath, parseDts } from "./parse";
import { compatibleOf, propertyByName, statusOf } from "./format";
import { describe, expect, test } from "vitest";

const FDT_BEGIN_NODE = 0x1;
const FDT_END_NODE = 0x2;
const FDT_PROP = 0x3;
const FDT_END = 0x9;

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u64(value: bigint): number[] {
  const high = Number((value >> 32n) & 0xffffffffn);
  const low = Number(value & 0xffffffffn);
  return [...u32(high), ...u32(low)];
}

function cstring(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value), 0];
  while (bytes.length % 4 !== 0) bytes.push(0);
  return bytes;
}

function buildBlob(): Uint8Array {
  const strings = new Map<string, number>();
  const stringBytes: number[] = [];
  const intern = (value: string) => {
    const found = strings.get(value);
    if (found !== undefined) return found;
    const offset = stringBytes.length;
    strings.set(value, offset);
    stringBytes.push(...new TextEncoder().encode(value), 0);
    return offset;
  };

  const prop = (name: string, data: number[]) => [
    ...u32(FDT_PROP),
    ...u32(data.length),
    ...u32(intern(name)),
    ...data,
    ...Array((4 - (data.length % 4)) % 4).fill(0),
  ];
  const begin = (name: string) => [...u32(FDT_BEGIN_NODE), ...cstring(name)];
  const end = () => u32(FDT_END_NODE);

  const model = [...new TextEncoder().encode("tiny"), 0];
  const compatible = [...new TextEncoder().encode("acme,uart"), 0];
  const status = [...new TextEncoder().encode("okay"), 0];
  const cells = [...u32(0x1000), ...u32(0x100)];

  const struct = [
    ...begin(""),
    ...prop("model", model),
    ...prop("#address-cells", u32(1)),
    ...begin("serial@1000"),
    ...prop("compatible", compatible),
    ...prop("reg", cells),
    ...prop("status", status),
    ...prop("enabled", []),
    ...end(),
    ...end(),
    ...u32(FDT_END),
  ];

  const reserve = [...u64(0n), ...u64(0n)];
  const headerSize = 40;
  const offReserve = headerSize;
  const offStruct = offReserve + reserve.length;
  const offStrings = offStruct + struct.length;
  const totalsize = offStrings + stringBytes.length;
  const header = [
    ...u32(0xd00dfeed),
    ...u32(totalsize),
    ...u32(offStruct),
    ...u32(offStrings),
    ...u32(offReserve),
    ...u32(17),
    ...u32(16),
    ...u32(0),
    ...u32(stringBytes.length),
    ...u32(struct.length),
  ];
  return Uint8Array.from([...header, ...reserve, ...struct, ...stringBytes]);
}

describe("decompileDtb", () => {
  test("turns a flattened blob back into a tree the source parser understands", () => {
    const bytes = buildBlob();
    expect(isDtb(bytes)).toBe(true);
    const text = decompileDtb(bytes);
    const doc = parseDts(text);
    expect(doc.errors, text).toEqual([]);
    expect(statusOf(findByPath(doc.root!, "/serial@1000")!)).toBe("okay");
    expect(compatibleOf(findByPath(doc.root!, "/serial@1000")!)).toEqual(["acme,uart"]);
    expect(propertyByName(findByPath(doc.root!, "/serial@1000")!, "enabled")?.boolean).toBe(true);
    expect(propertyByName(doc.root!, "#address-cells")).toBeTruthy();
    expect(propertyByName(doc.root!, "model")).toBeTruthy();
  });

  test("rejects a byte-swapped magic", () => {
    const bytes = Uint8Array.from([0xed, 0xfe, 0x0d, 0xd0, 0, 0, 0, 0]);
    expect(() => decompileDtb(bytes)).toThrow(/byte-swapped/);
  });
});
