import { formatPropertyValue, propertyByName, statusOf, stringValues } from "./format";
import type { DtCell, DtDocument, DtNode, DtProperty } from "./types";

export type MapKind = "ram" | "reserved" | "memreserve" | "pool" | "mmio";

export type MapRegion = {
  id: string;
  path: string | null;
  title: string;
  kind: MapKind;
  start: bigint | null;
  size: bigint | null;
  enabled: boolean;
  detail: string;
  overlaps: string[];
};

export type MemoryMap = {
  regions: MapRegion[];
  notes: string[];
};

type Space = {
  addressCells: number;
  sizeCells: number;
  toCpu: (local: bigint) => bigint | null;
};

type Decoded = {
  start: bigint | null;
  size: bigint | null;
  raw: string;
};

export function analyzeMemoryMap(doc: DtDocument): MemoryMap {
  const notes: string[] = [];
  const regions: MapRegion[] = [];
  let seq = 0;
  const nextId = () => `map-${seq++}`;

  for (const reserve of doc.memreserves) {
    const start = parseInteger(reserve.address);
    const size = parseInteger(reserve.size);
    regions.push({
      id: nextId(),
      path: null,
      title: "/memreserve/",
      kind: "memreserve",
      start,
      size,
      enabled: true,
      detail: "Kept out of the kernel until a driver claims it.",
      overlaps: [],
    });
    if (start === null || size === null) {
      notes.push(`/memreserve/ ${reserve.address} ${reserve.size} is not a plain integer.`);
    }
  }

  if (doc.root) {
    const rootSpace: Space = {
      addressCells: cellCount(doc.root, "#address-cells") ?? 2,
      sizeCells: cellCount(doc.root, "#size-cells") ?? 1,
      toCpu: (local) => local,
    };
    for (const child of doc.root.children) {
      walk(child, rootSpace, doc.root, true, regions, notes, nextId);
    }
  }

  markOverlaps(regions);
  regions.sort(compareRegions);
  return { regions, notes };
}

export function formatAddress(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function formatSize(size: bigint): string {
  const units: [bigint, string][] = [
    [1n << 30n, "GiB"],
    [1n << 20n, "MiB"],
    [1n << 10n, "KiB"],
  ];
  for (const [unit, label] of units) {
    if (size >= unit && size % unit === 0n) return `${size / unit} ${label}`;
  }
  if (size === 1n) return "1 byte";
  return `${size} bytes`;
}

export function formatHz(value: bigint): string {
  if (value >= 1_000_000_000n && value % 100_000_000n === 0n) {
    const tenths = value / 100_000_000n;
    const whole = tenths / 10n;
    const frac = tenths % 10n;
    return frac === 0n ? `${whole} GHz` : `${whole}.${frac} GHz`;
  }
  if (value >= 1_000_000n && value % 1_000_000n === 0n) return `${value / 1_000_000n} MHz`;
  if (value >= 1_000n && value % 1_000n === 0n) return `${value / 1_000n} kHz`;
  return `${value} Hz`;
}

export function parseInteger(raw: string): bigint | null {
  const text = raw.trim().toLowerCase().replace(/[ul]+$/, "");
  if (/^0x[0-9a-f]+$/.test(text)) return BigInt(text);
  if (/^[0-9]+$/.test(text)) return BigInt(text);
  return null;
}

function walk(
  node: DtNode,
  parent: Space,
  parentNode: DtNode | null,
  parentEnabled: boolean,
  regions: MapRegion[],
  notes: string[],
  nextId: () => string,
) {
  if (node.deleted) return;
  const enabled = parentEnabled && statusOf(node) !== "disabled";

  if (isRam(node)) {
    pushReg(node, parent, "ram", true, "System RAM.", regions, notes, nextId);
  } else if (parentNode?.name === "reserved-memory") {
    pushReservation(node, parent, regions, notes, nextId);
  } else if (parent.sizeCells > 0 && !isCpu(node)) {
    const compatible = stringValues(propertyByName(node, "compatible"));
    const detail = [compatible[0], enabled ? null : "status disabled"].filter(Boolean).join(" · ");
    pushReg(node, parent, "mmio", enabled, detail || "Register window.", regions, notes, nextId);
  }

  const space = childSpace(node, parent, notes);
  for (const child of node.children) walk(child, space, node, enabled, regions, notes, nextId);
}

function pushReservation(
  node: DtNode,
  parent: Space,
  regions: MapRegion[],
  notes: string[],
  nextId: () => string,
) {
  const reusable = Boolean(propertyByName(node, "reusable"));
  const noMap = Boolean(propertyByName(node, "no-map"));
  const decoded = decodeReg(node, parent, notes);
  const alloc = allocRangeText(node, parent);
  if (decoded.length > 0) {
    for (const [index, item] of decoded.entries()) {
      regions.push({
        id: nextId(),
        path: node.path,
        title: decoded.length > 1 ? `${node.fullName} (${index + 1})` : node.fullName,
        kind: reusable ? "pool" : "reserved",
        start: item.start,
        size: item.size,
        enabled: true,
        detail: reservationDetail(reusable, noMap, alloc),
        overlaps: [],
      });
    }
    return;
  }

  const size = firstInteger(propertyByName(node, "size"));
  regions.push({
    id: nextId(),
    path: node.path,
    title: node.fullName,
    kind: "pool",
    start: null,
    size,
    enabled: true,
    detail: reservationDetail(reusable, noMap, alloc) || "Size only. The kernel chooses the address.",
    overlaps: [],
  });
}

function pushReg(
  node: DtNode,
  parent: Space,
  kind: MapKind,
  enabled: boolean,
  detail: string,
  regions: MapRegion[],
  notes: string[],
  nextId: () => string,
) {
  const decoded = decodeReg(node, parent, notes);
  for (const [index, item] of decoded.entries()) {
    if (item.size === 0n) continue;
    regions.push({
      id: nextId(),
      path: node.path,
      title: decoded.length > 1 ? `${node.fullName} (${index + 1})` : node.fullName,
      kind,
      start: item.start,
      size: item.size,
      enabled,
      detail,
      overlaps: [],
    });
  }
}

function decodeReg(node: DtNode, parent: Space, notes: string[]): Decoded[] {
  const reg = propertyByName(node, "reg");
  if (!reg || parent.addressCells <= 0) return [];
  const stride = parent.addressCells + parent.sizeCells;
  const cells = flattenCells(reg);
  if (cells.length === 0) return [];
  if (stride > 0 && cells.length % stride !== 0) {
    notes.push(`${node.path} reg is ${cells.length} cells and does not match the parent's address and size cells.`);
    return [{ start: null, size: null, raw: formatPropertyValue(reg) }];
  }
  const rows: Decoded[] = [];
  for (let cursor = 0; cursor < cells.length; cursor += stride) {
    const addressCells = cells.slice(cursor, cursor + parent.addressCells);
    const sizeCells = parent.sizeCells > 0 ? cells.slice(cursor + parent.addressCells, cursor + stride) : [];
    const local = combine(addressCells);
    const size = sizeCells.length > 0 ? combine(sizeCells) : null;
    const start = local === null ? null : parent.toCpu(local);
    if (local !== null && start === null) {
      notes.push(`${node.path} reg ${formatAddress(local)} is outside the parent's ranges.`);
    }
    rows.push({ start, size, raw: formatPropertyValue(reg) });
  }
  return rows;
}

function childSpace(node: DtNode, parent: Space, notes: string[]): Space {
  const addressCells = cellCount(node, "#address-cells") ?? parent.addressCells;
  const sizeCells = cellCount(node, "#size-cells") ?? parent.sizeCells;
  const ranges = propertyByName(node, "ranges");
  // reserved-memory addresses are already in the parent (CPU) space.
  if (node.name === "reserved-memory") {
    return { addressCells, sizeCells, toCpu: parent.toCpu };
  }
  let toParent: (local: bigint) => bigint | null;
  if (!ranges) {
    toParent = () => null;
  } else if (ranges.boolean || flattenCells(ranges).length === 0) {
    toParent = (local) => local;
  } else {
    const windows = parseRanges(ranges, addressCells, parent.addressCells, sizeCells, node, notes);
    toParent = (local) => {
      for (const window of windows) {
        if (local >= window.child && local < window.child + window.size) {
          return window.parent + (local - window.child);
        }
      }
      return null;
    };
  }
  return {
    addressCells,
    sizeCells,
    toCpu: (local) => {
      const translated = toParent(local);
      return translated === null ? null : parent.toCpu(translated);
    },
  };
}

function parseRanges(
  ranges: DtProperty,
  childCells: number,
  parentCells: number,
  sizeCells: number,
  node: DtNode,
  notes: string[],
): { child: bigint; parent: bigint; size: bigint }[] {
  const cells = flattenCells(ranges);
  const stride = childCells + parentCells + sizeCells;
  if (stride <= 0 || cells.length % stride !== 0) {
    notes.push(`${node.path} ranges could not be split into address windows.`);
    return [];
  }
  const windows: { child: bigint; parent: bigint; size: bigint }[] = [];
  for (let cursor = 0; cursor < cells.length; cursor += stride) {
    const child = combine(cells.slice(cursor, cursor + childCells));
    const parent = combine(cells.slice(cursor + childCells, cursor + childCells + parentCells));
    const size = combine(cells.slice(cursor + childCells + parentCells, cursor + stride));
    if (child === null || parent === null || size === null) {
      notes.push(`${node.path} ranges contains a value that is not a plain integer.`);
      continue;
    }
    windows.push({ child, parent, size });
  }
  return windows;
}

function markOverlaps(regions: MapRegion[]) {
  const placed = regions.filter((region) => region.start !== null && region.size !== null && region.size > 0n);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      if (sameDevice(a, b)) continue;
      if (a.kind === "ram" && (b.kind === "reserved" || b.kind === "memreserve" || b.kind === "pool")) continue;
      if (b.kind === "ram" && (a.kind === "reserved" || a.kind === "memreserve" || a.kind === "pool")) continue;
      if (!overlaps(a, b)) continue;
      a.overlaps.push(b.title);
      b.overlaps.push(a.title);
    }
  }
}

function sameDevice(a: MapRegion, b: MapRegion): boolean {
  return a.path !== null && a.path === b.path;
}

function overlaps(a: MapRegion, b: MapRegion): boolean {
  const a0 = a.start!;
  const b0 = b.start!;
  const a1 = a0 + a.size!;
  const b1 = b0 + b.size!;
  return a0 < b1 && b0 < a1;
}

function compareRegions(a: MapRegion, b: MapRegion): number {
  if (a.start === null && b.start === null) return a.title.localeCompare(b.title);
  if (a.start === null) return 1;
  if (b.start === null) return -1;
  if (a.start < b.start) return -1;
  if (a.start > b.start) return 1;
  return a.title.localeCompare(b.title);
}

function reservationDetail(reusable: boolean, noMap: boolean, alloc: string | null): string {
  const bits = [
    noMap ? "no-map" : null,
    reusable ? "reusable" : null,
    alloc ? `allocatable inside ${alloc}` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function allocRangeText(node: DtNode, parent: Space): string | null {
  const alloc = propertyByName(node, "alloc-ranges");
  if (!alloc) return null;
  const cells = flattenCells(alloc);
  const stride = parent.addressCells + parent.sizeCells;
  if (stride <= 0 || cells.length < stride) return formatPropertyValue(alloc);
  const start = combine(cells.slice(0, parent.addressCells));
  const size = combine(cells.slice(parent.addressCells, stride));
  if (start === null || size === null) return formatPropertyValue(alloc);
  return `${formatAddress(start)} + ${formatSize(size)}`;
}

function isRam(node: DtNode): boolean {
  return stringValues(propertyByName(node, "device_type"))[0] === "memory";
}

function isCpu(node: DtNode): boolean {
  return stringValues(propertyByName(node, "device_type"))[0] === "cpu" || node.name.startsWith("cpu@");
}

function cellCount(node: DtNode, name: string): number | null {
  const value = firstInteger(propertyByName(node, name));
  if (value === null) return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function firstInteger(property: DtProperty | undefined): bigint | null {
  if (!property) return null;
  for (const cell of flattenCells(property)) {
    const value = cellValue(cell);
    if (value !== null) return value;
  }
  return null;
}

function flattenCells(property: DtProperty): DtCell[] {
  const cells: DtCell[] = [];
  for (const part of property.parts) {
    if (part.kind === "cells") cells.push(...part.cells);
  }
  return cells;
}

function combine(cells: DtCell[]): bigint | null {
  if (cells.length === 0) return null;
  let value = 0n;
  for (const cell of cells) {
    const part = cellValue(cell);
    if (part === null) return null;
    value = (value << 32n) | part;
  }
  return value;
}

function cellValue(cell: DtCell): bigint | null {
  if (cell.kind !== "number") return null;
  return parseInteger(cell.raw);
}
