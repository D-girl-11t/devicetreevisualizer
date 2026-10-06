import { propertyByName, statusOf, stringValues } from "./format";
import { parseInteger } from "./memory-map";
import { parseDts } from "./parse";
import type { DtDocument, DtNode } from "./types";

export type TreeEdit = {
  id: string;
  title: string;
  detail: string;
  apply: (source: string) => string;
};

export type EditPlan = {
  edits: TreeEdit[];
  note: string | null;
};

const HELP =
  "Try “Add a temperature sensor connected externally”, “Add an EEPROM on i2c1”, “Add a status LED”, or “Enable uart0”.";

export function proposeEdits(request: string, doc: DtDocument): EditPlan {
  const text = request.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return { edits: [], note: HELP };
  if (!doc.root) return { edits: [], note: "The source has no root node yet." };

  if (/(temp|temperature|thermal)/.test(text) && /(add|connect|attach|sensor)/.test(text)) {
    return temperaturePlan(doc, text);
  }
  if (/(eeprom|24c32|at24)/.test(text) && /(add|connect|attach)/.test(text)) {
    return chipPlan(doc, text, {
      id: "eeprom",
      title: "EEPROM",
      compatible: "atmel,24c32",
      node: "ext-eeprom",
      start: 0x50,
    });
  }
  if (/(^| )led/.test(text) && /(add|connect|attach)/.test(text)) {
    return ledPlan(doc);
  }
  const toggle = text.match(/^(enable|turn on|disable|turn off)\s+(.+)$/);
  if (toggle) {
    const enabling = toggle[1] === "enable" || toggle[1] === "turn on";
    return statusPlan(doc, toggle[2], enabling);
  }
  return { edits: [], note: HELP };
}

export type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

export function changedLines(before: string, after: string): DiffLine[] {
  const all = diff(before.split("\n"), after.split("\n"));
  const interesting = all.map((line, index) => {
    if (line.kind !== "ctx") return true;
    return all.slice(Math.max(0, index - 2), index + 3).some((near) => near.kind !== "ctx");
  });
  const hunk: DiffLine[] = [];
  let skipping = false;
  all.forEach((line, index) => {
    if (!interesting[index]) {
      if (!skipping && hunk.length > 0) hunk.push({ kind: "ctx", text: "…" });
      skipping = true;
      return;
    }
    skipping = false;
    hunk.push(line);
  });
  return hunk;
}

function temperaturePlan(doc: DtDocument, text: string): EditPlan {
  const compatible = text.includes("lm75") ? "national,lm75" : text.includes("tmp103") ? "ti,tmp103" : "ti,tmp102";
  return chipPlan(doc, text, {
    id: "temp",
    title: "temperature sensor",
    compatible,
    node: "ext-temp",
    start: 0x48,
  });
}

function chipPlan(
  doc: DtDocument,
  text: string,
  spec: { id: string; title: string; compatible: string; node: string; start: number },
): EditPlan {
  const buses = i2cBuses(doc.root);
  if (buses.length === 0) {
    return { edits: [], note: `This tree has no I2C bus, so an external ${spec.title} has nowhere to connect.` };
  }
  const bus = pickBus(buses, text) ?? buses[0];
  const address = freeAddress(bus, spec.start);
  const hex = `0x${address.toString(16)}`;
  const nodeName = `${spec.node}@${address.toString(16)}`;
  const label = bus.labels[0] ?? bus.fullName;
  const edits: TreeEdit[] = [];
  if (statusOf(bus) === "disabled") {
    edits.push({
      id: `${spec.id}-bus`,
      title: `Enable ${label}`,
      detail: `${label} is disabled. The ${spec.title} cannot probe until this bus is turned on.`,
      apply: (source) => setStatus(source, busPath(bus), "okay"),
    });
  }
  const pagesize = spec.compatible.includes("24c") ? "\n    pagesize = <32>;" : "";
  edits.push({
    id: `${spec.id}-node`,
    title: `Add ${nodeName} on ${label}`,
    detail: `Insert an external ${spec.title} at ${hex} on ${label}. The node is ${spec.compatible}.`,
    apply: (source) =>
      insertChild(
        source,
        busPath(bus),
        `${nodeName} {\n    compatible = "${spec.compatible}";\n    reg = <${hex}>;${pagesize}\n    status = "okay";\n};`,
      ),
  });
  return { edits, note: null };
}

function ledPlan(doc: DtDocument): EditPlan {
  const root = doc.root;
  if (!root) return { edits: [], note: HELP };
  const gpio = findFirst(root, (node) => node.properties.some((property) => property.boolean && property.name === "gpio-controller" && !property.deleted));
  if (!gpio) return { edits: [], note: "This tree has no GPIO controller, so a new LED has no pin to name." };
  const gpioLabel = gpio.labels[0] ?? gpio.fullName;
  const line = freeGpioLine(root, gpioLabel);
  const leds = findFirst(root, (node) => stringValues(propertyByName(node, "compatible")).includes("gpio-leds"));
  const lamp = `ext {\n    label = "board:green:ext";\n    gpios = <&${gpioLabel} ${line} 0>;\n};`;
  if (leds) {
    return {
      edits: [
        {
          id: "led",
          title: `Add an LED on ${gpioLabel} line ${line}`,
          detail: "The new lamp is a child of the existing gpio-leds node, active-high.",
          apply: (source) => insertChild(source, leds.path, lamp),
        },
      ],
      note: null,
    };
  }
  return {
    edits: [
      {
        id: "led",
        title: `Add an LED on ${gpioLabel} line ${line}`,
        detail: "This file has no gpio-leds node yet, so the edit adds one at the root.",
        apply: (source) =>
          insertChild(source, "/", `leds {\n    compatible = "gpio-leds";\n\n    ${lamp.replaceAll("\n", "\n    ")}\n};`),
      },
    ],
    note: null,
  };
}

function statusPlan(doc: DtDocument, query: string, enabling: boolean): EditPlan {
  const node = resolveQuery(doc, query);
  if (!node) return { edits: [], note: `No node matches “${query.trim()}”. Use a label, alias, or node name.` };
  const status = enabling ? "okay" : "disabled";
  const name = node.labels[0] ?? node.fullName;
  if (statusOf(node) === status || (enabling && statusOf(node) !== "disabled")) {
    return { edits: [], note: `${name} is already ${enabling ? "enabled" : "disabled"}.` };
  }
  return {
    edits: [
      {
        id: `status-${node.path}`,
        title: `${enabling ? "Enable" : "Disable"} ${name}`,
        detail: `Set status to "${status}" on ${node.path}.`,
        apply: (source) => setStatus(source, node.path, status),
      },
    ],
    note: null,
  };
}

function i2cBuses(root: DtNode | null): DtNode[] {
  const buses: DtNode[] = [];
  if (!root) return buses;
  walk(root, (node) => {
    if (node.deleted) return;
    if (node.name.startsWith("i2c") && propertyByName(node, "#address-cells")) buses.push(node);
  });
  return buses;
}

function pickBus(buses: DtNode[], text: string): DtNode | undefined {
  return buses.find((bus) => bus.labels.some((label) => text.includes(label.toLowerCase())) || text.includes(bus.fullName.toLowerCase()));
}

function freeAddress(bus: DtNode, start: number): number {
  const used = new Set<number>();
  for (const child of bus.children) {
    if (child.deleted) continue;
    const value = regNumber(child);
    if (value !== null) used.add(value);
  }
  for (let address = start; address < 0x78; address += 1) {
    if (!used.has(address)) return address;
  }
  return start;
}

function freeGpioLine(root: DtNode, label: string): number {
  const used = new Set<number>();
  walk(root, (node) => {
    for (const property of node.properties) {
      if (property.deleted) continue;
      if (property.name !== "gpios" && !property.name.endsWith("-gpios")) continue;
      for (const part of property.parts) {
        if (part.kind !== "cells") continue;
        for (let index = 0; index < part.cells.length; index += 1) {
          const cell = part.cells[index];
          if (cell.kind === "ref" && cell.ref.kind === "label" && cell.ref.label === label) {
            const line = part.cells[index + 1];
            if (line?.kind === "number") {
              const value = parseInteger(line.raw);
              if (value !== null) used.add(Number(value));
            }
          }
        }
      }
    }
  });
  for (let line = 0; line < 32; line += 1) {
    if (!used.has(line)) return line;
  }
  return 0;
}

function regNumber(node: DtNode): number | null {
  const property = propertyByName(node, "reg");
  if (!property) return null;
  for (const part of property.parts) {
    if (part.kind !== "cells") continue;
    const cell = part.cells[0];
    if (!cell || cell.kind !== "number") continue;
    const value = parseInteger(cell.raw);
    if (value !== null) return Number(value);
  }
  return null;
}

function resolveQuery(doc: DtDocument, query: string): DtNode | null {
  const needle = query.trim().toLowerCase().replace(/^the\s+/, "");
  if (!doc.root || !needle) return null;
  const alias = aliasTarget(doc.root, needle);
  if (alias) return alias;
  let found: DtNode | null = null;
  walk(doc.root, (node) => {
    if (found || node.deleted) return;
    const names = [node.fullName, node.name, node.path, ...node.labels].map((item) => item.toLowerCase());
    if (names.includes(needle)) found = node;
  });
  return found;
}

function aliasTarget(root: DtNode, name: string): DtNode | null {
  const aliases = root.children.find((node) => node.name === "aliases");
  const property = aliases?.properties.find((item) => !item.deleted && item.name.toLowerCase() === name);
  if (!property) return null;
  for (const part of property.parts) {
    if (part.kind === "phandle" && part.ref.kind === "label") return findLabel(root, part.ref.label);
    if (part.kind === "cells") {
      for (const cell of part.cells) {
        if (cell.kind === "ref" && cell.ref.kind === "label") return findLabel(root, cell.ref.label);
      }
    }
  }
  return null;
}

function setStatus(source: string, path: string, status: string): string {
  const node = nodeByPath(source, path);
  const lines = source.split("\n");
  const closing = lines[node.endLine - 1] ?? "";
  const indent = `${(closing.match(/^\s*/) ?? [""])[0]}    `;
  const slot = lines.findIndex(
    (line, index) =>
      index >= node.line &&
      index < node.endLine - 1 &&
      line.startsWith(indent) &&
      !line.startsWith(`${indent} `) &&
      /^\s*status\s*=/.test(line),
  );
  if (slot >= 0) {
    lines[slot] = lines[slot].replace(/status\s*=\s*"[^"]*"/, `status = "${status}"`);
    return lines.join("\n");
  }
  lines.splice(node.line, 0, `${indent}status = "${status}";`);
  return lines.join("\n");
}

function insertChild(source: string, path: string, body: string): string {
  const node = nodeByPath(source, path);
  const lines = source.split("\n");
  const closing = lines[node.endLine - 1] ?? "";
  const indent = `${(closing.match(/^\s*/) ?? [""])[0]}    `;
  const block = body
    .trim()
    .split("\n")
    .map((line) => (line.length > 0 ? indent + line : line))
    .join("\n");
  lines.splice(node.endLine - 1, 0, block);
  return lines.join("\n");
}

function nodeByPath(source: string, path: string): DtNode {
  const doc = parseDts(source);
  const node = path === "/" ? doc.root : findPath(doc.root, path);
  if (!node) throw new Error(`${path} is no longer in the tree.`);
  return node;
}

function busPath(bus: DtNode): string {
  if (!bus.path) throw new Error("The I2C bus has no path.");
  return bus.path;
}

function findPath(node: DtNode | null, path: string): DtNode | null {
  if (!node || node.deleted) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
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

function findFirst(node: DtNode, test: (node: DtNode) => boolean): DtNode | null {
  if (!node.deleted && test(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, test);
    if (found) return found;
  }
  return null;
}

function walk(node: DtNode, visit: (node: DtNode) => void) {
  visit(node);
  for (const child of node.children) {
    if (!child.deleted) walk(child, visit);
  }
}

function diff(before: string[], after: string[]): DiffLine[] {
  const scores: number[][] = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      scores[row][column] =
        before[row] === after[column]
          ? scores[row + 1][column + 1] + 1
          : Math.max(scores[row + 1][column], scores[row][column + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      lines.push({ kind: "ctx", text: before[row] });
      row += 1;
      column += 1;
    } else if (scores[row + 1][column] >= scores[row][column + 1]) {
      lines.push({ kind: "del", text: before[row] });
      row += 1;
    } else {
      lines.push({ kind: "add", text: after[column] });
      column += 1;
    }
  }
  while (row < before.length) lines.push({ kind: "del", text: before[row++] });
  while (column < after.length) lines.push({ kind: "add", text: after[column++] });
  return lines;
}
