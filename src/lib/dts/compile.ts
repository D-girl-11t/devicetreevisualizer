import { propertyByName } from "./format";
import { parseInteger } from "./memory-map";
import type { DtCell, DtDocument, DtNode, DtProperty, DtRef, DtValuePart } from "./types";

const FDT_MAGIC = 0xd00dfeed;
const FDT_BEGIN_NODE = 0x1;
const FDT_END_NODE = 0x2;
const FDT_PROP = 0x3;
const FDT_END = 0x9;

export function compileDtb(doc: DtDocument): Uint8Array {
  if (!doc.root) throw new Error("There is no tree to compile.");
  const phandles = assignPhandles(doc.root);
  const strings = new StringTable();
  const struct = new ByteBuffer();
  writeNode(struct, strings, doc.root, "", phandles);
  struct.u32(FDT_END);
  struct.align(4);

  const reserve = new ByteBuffer();
  for (const entry of doc.memreserves) {
    const address = parseInteger(entry.address);
    const size = parseInteger(entry.size);
    if (address === null || size === null) {
      throw new Error(`/memreserve/ ${entry.address} ${entry.size} is not a plain integer.`);
    }
    reserve.u64(address);
    reserve.u64(size);
  }
  reserve.u64(0n);
  reserve.u64(0n);

  const header = 40;
  const offReserve = header;
  const offStruct = align(offReserve + reserve.length, 4);
  const offStrings = align(offStruct + struct.length, 4);
  const total = offStrings + strings.length;
  const out = new ByteBuffer();
  out.u32(FDT_MAGIC);
  out.u32(total);
  out.u32(offStruct);
  out.u32(offStrings);
  out.u32(offReserve);
  out.u32(17);
  out.u32(16);
  out.u32(0);
  out.u32(strings.length);
  out.u32(struct.length);
  out.pad(offReserve);
  out.raw(reserve.bytes);
  out.pad(offStruct);
  out.raw(struct.bytes);
  out.pad(offStrings);
  out.raw(strings.bytes);
  return out.toUint8();
}

function writeNode(out: ByteBuffer, strings: StringTable, node: DtNode, name: string, phandles: Handles) {
  out.u32(FDT_BEGIN_NODE);
  out.cstr(name);
  out.align(4);
  const phandle = node.path ? phandles.byPath.get(node.path) : undefined;
  const hasPhandleProp = node.properties.some((property) => !property.deleted && property.name === "phandle");
  for (const property of node.properties) {
    if (property.deleted) continue;
    writeProperty(out, strings, property, phandles);
  }
  if (phandle !== undefined && !hasPhandleProp) {
    writeCells(out, strings, "phandle", [phandle]);
  }
  for (const child of node.children) {
    if (child.deleted) continue;
    writeNode(out, strings, child, child.fullName, phandles);
  }
  out.u32(FDT_END_NODE);
}

function writeProperty(out: ByteBuffer, strings: StringTable, property: DtProperty, phandles: Handles) {
  if (property.boolean || property.parts.length === 0) {
    writeRaw(out, strings, property.name, []);
    return;
  }
  const data = new ByteBuffer();
  for (const part of property.parts) writePart(data, part, phandles);
  writeRaw(out, strings, property.name, data.bytes);
}

function writePart(out: ByteBuffer, part: DtValuePart, phandles: Handles) {
  if (part.kind === "string") {
    out.cstr(part.value);
    return;
  }
  if (part.kind === "bytes") {
    if (part.bits && part.bits !== 8) {
      throw new Error(`A byte list uses /bits/ ${part.bits}, which this page cannot pack.`);
    }
    out.raw(part.bytes);
    return;
  }
  if (part.kind === "phandle") {
    out.u32(phandleOf(part.ref, phandles));
    return;
  }
  if (part.kind === "incbin") {
    throw new Error(`/incbin/ "${part.file}" is not included in the downloaded blob.`);
  }
  if (part.bits && part.bits !== 32) {
    throw new Error(`A cell list uses /bits/ ${part.bits}, which this page cannot pack.`);
  }
  for (const cell of part.cells) writeCell(out, cell, phandles);
}

function writeCell(out: ByteBuffer, cell: DtCell, phandles: Handles) {
  if (cell.kind === "number") {
    const value = parseInteger(cell.raw);
    if (value === null || value < 0n || value > 0xffffffffn) {
      throw new Error(`Cannot pack cell ${cell.raw} into a 32-bit blob cell.`);
    }
    out.u32(Number(value));
    return;
  }
  if (cell.kind === "ref") {
    out.u32(phandleOf(cell.ref, phandles));
    return;
  }
  const text = cell.kind === "symbol" ? cell.name : cell.raw;
  throw new Error(`Cannot pack ${text} into a blob. Replace it with a number first.`);
}

function writeCells(out: ByteBuffer, strings: StringTable, name: string, cells: number[]) {
  const data = new ByteBuffer();
  for (const cell of cells) data.u32(cell);
  writeRaw(out, strings, name, data.bytes);
}

function writeRaw(out: ByteBuffer, strings: StringTable, name: string, data: number[]) {
  out.u32(FDT_PROP);
  out.u32(data.length);
  out.u32(strings.offset(name));
  out.raw(data);
  out.align(4);
}

type Handles = {
  byPath: Map<string, number>;
  byLabel: Map<string, number>;
};

function assignPhandles(root: DtNode): Handles {
  const byPath = new Map<string, number>();
  const byLabel = new Map<string, number>();
  const used = new Set<number>();
  const remember = (node: DtNode, value: number) => {
    if (!node.path) return;
    byPath.set(node.path, value);
    for (const label of node.labels) byLabel.set(label, value);
    used.add(value);
  };
  const visitExisting = (node: DtNode) => {
    if (node.deleted || !node.path) return;
    const existing = propertyByName(node, "phandle");
    const value = existing ? firstCell(existing) : null;
    if (value !== null) remember(node, value);
    for (const child of node.children) visitExisting(child);
  };
  visitExisting(root);

  const needed: DtNode[] = [];
  const visitRefs = (node: DtNode) => {
    if (node.deleted) return;
    for (const property of node.properties) {
      if (property.deleted) continue;
      for (const ref of refsIn(property.parts)) {
        const target = resolve(root, ref);
        if (!target?.path) {
          const label = ref.kind === "label" ? `&${ref.label}` : `&{${ref.path}}`;
          throw new Error(`${label} is not in this tree, so the blob cannot be built.`);
        }
        if (!byPath.has(target.path)) needed.push(target);
      }
    }
    for (const child of node.children) visitRefs(child);
  };
  visitRefs(root);

  let next = 1;
  for (const node of needed) {
    if (!node.path || byPath.has(node.path)) continue;
    while (used.has(next)) next += 1;
    remember(node, next);
    next += 1;
  }
  return { byPath, byLabel };
}

function phandleOf(ref: DtRef, phandles: Handles): number {
  const value = ref.kind === "path" ? phandles.byPath.get(ref.path) : phandles.byLabel.get(ref.label);
  if (value === undefined) {
    const label = ref.kind === "label" ? `&${ref.label}` : `&{${ref.path}}`;
    throw new Error(`${label} is not in this tree, so the blob cannot be built.`);
  }
  return value;
}

function resolve(root: DtNode, ref: DtRef): DtNode | null {
  if (ref.kind === "path") return findPath(root, ref.path);
  return findLabel(root, ref.label);
}

function findPath(node: DtNode, path: string): DtNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    if (child.deleted) continue;
    const found = findPath(child, path);
    if (found) return found;
  }
  return null;
}

function findLabel(node: DtNode, label: string): DtNode | null {
  if (!node.deleted && node.labels.includes(label)) return node;
  for (const child of node.children) {
    const found = findLabel(child, label);
    if (found) return found;
  }
  return null;
}

function refsIn(parts: DtValuePart[]): DtRef[] {
  const refs: DtRef[] = [];
  for (const part of parts) {
    if (part.kind === "phandle") refs.push(part.ref);
    if (part.kind === "cells") {
      for (const cell of part.cells) {
        if (cell.kind === "ref") refs.push(cell.ref);
      }
    }
  }
  return refs;
}

function firstCell(property: DtProperty): number | null {
  for (const part of property.parts) {
    if (part.kind !== "cells") continue;
    const cell = part.cells[0];
    if (!cell || cell.kind !== "number") continue;
    const value = parseInteger(cell.raw);
    if (value !== null && value <= 0xffffffffn) return Number(value);
  }
  return null;
}

class ByteBuffer {
  bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u32(value: number) {
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  u64(value: bigint) {
    const high = Number((value >> 32n) & 0xffffffffn);
    const low = Number(value & 0xffffffffn);
    this.u32(high);
    this.u32(low);
  }

  cstr(value: string) {
    this.raw(Array.from(new TextEncoder().encode(value)));
    this.bytes.push(0);
  }

  raw(data: number[]) {
    for (const byte of data) this.bytes.push(byte & 0xff);
  }

  align(boundary: number) {
    while (this.bytes.length % boundary !== 0) this.bytes.push(0);
  }

  pad(offset: number) {
    while (this.bytes.length < offset) this.bytes.push(0);
  }

  toUint8(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class StringTable {
  bytes: number[] = [];
  private offsets = new Map<string, number>();

  get length(): number {
    return this.bytes.length;
  }

  offset(name: string): number {
    const existing = this.offsets.get(name);
    if (existing !== undefined) return existing;
    const offset = this.bytes.length;
    this.offsets.set(name, offset);
    for (const byte of new TextEncoder().encode(name)) this.bytes.push(byte);
    this.bytes.push(0);
    return offset;
  }
}

function align(value: number, boundary: number): number {
  return (value + boundary - 1) & ~(boundary - 1);
}
