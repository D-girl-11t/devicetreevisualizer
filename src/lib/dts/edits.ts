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
  "Type one line, such as model = \"New board\" or uart0: serial@a01000. Remove a node with “remove serial0”. Or try “Add a temperature sensor connected externally”, “Add an EEPROM on i2c1”, “Add a status LED”, or “Enable uart0”.";

export const MINIMUM_TEMPLATE = `/dts-v1/;

/ {
    model = "New board";
    compatible = "vendor,board";
    #address-cells = <1>;
    #size-cells = <1>;

    cpus {
        #address-cells = <1>;
        #size-cells = <0>;

        cpu@0 {
            device_type = "cpu";
            compatible = "arm,cortex-a53";
            reg = <0>;
        };
    };

    memory@80000000 {
        device_type = "memory";
        reg = <0x80000000 0x40000000>;
    };

    chosen {
        stdout-path = "serial0:115200n8";
    };

    soc {
        compatible = "simple-bus";
        #address-cells = <1>;
        #size-cells = <1>;
        ranges;
    };
};
`;

export type DesignNeed = {
  id: string;
  title: string;
  detail: string;
  met: boolean;
};

export function designChecklist(doc: DtDocument): DesignNeed[] {
  const root = doc.root;
  const chosen = root?.children.find((node) => !node.deleted && node.name === "chosen") ?? null;
  return [
    { id: "version", title: "/dts-v1/;", detail: "The file starts with the version line.", met: doc.hasVersion },
    { id: "root", title: "Root node", detail: "Everything else lives inside / { }.", met: Boolean(root) },
    { id: "model", title: "model", detail: "A name for this board.", met: Boolean(root && propertyByName(root, "model")) },
    { id: "compatible", title: "compatible", detail: "The strings the kernel matches to a board.", met: Boolean(root && propertyByName(root, "compatible")) },
    {
      id: "cells",
      title: "Address cells",
      detail: "#address-cells and #size-cells tell children how to read reg.",
      met: Boolean(root && propertyByName(root, "#address-cells") && propertyByName(root, "#size-cells")),
    },
    { id: "cpu", title: "One CPU", detail: "A cpus node with at least one cpu.", met: hasCpu(root) },
    { id: "memory", title: "Memory", detail: "A memory node with the RAM window.", met: hasMemory(root) },
    {
      id: "console",
      title: "Console",
      detail: "chosen stdout-path names the serial port used for boot messages.",
      met: Boolean(chosen && propertyByName(chosen, "stdout-path")),
    },
  ];
}

export function designNodes(doc: DtDocument): { path: string; title: string }[] {
  if (!doc.root) return [];
  const listed: { path: string; title: string }[] = [];
  const visit = (node: DtNode, depth: number) => {
    if (node.deleted || node.path === "/") return;
    listed.push({
      path: node.path,
      title: node.labels.length > 0 ? `${node.labels[0]} · ${node.fullName}` : node.fullName,
    });
    if (depth >= 3) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const child of doc.root.children) visit(child, 1);
  return listed;
}

export function fillGap(id: string, doc: DtDocument): EditPlan {
  if (!doc.root && id !== "version") {
    return templatePlan();
  }
  switch (id) {
    case "version":
      return doc.hasVersion
        ? { edits: [], note: "The version line is already there." }
        : {
            edits: [
              {
                id: "gap-version",
                title: "Add /dts-v1/;",
                detail: "Put the version line at the top of the file.",
                apply: (source) => (source.startsWith("/dts-v1/") ? source : `/dts-v1/;\n\n${source}`),
              },
            ],
            note: null,
          };
    case "root":
      return templatePlan();
    case "model":
      return propertyEdit(doc, "/", "model", 'model = "New board"', "Name the board.");
    case "compatible":
      return propertyEdit(doc, "/", "compatible", 'compatible = "vendor,board"', "Name the board binding.");
    case "cells":
      return cellsEdit(doc);
    case "cpu":
      return cpuEdit(doc);
    case "memory":
      return nodeEdit(doc, "/", "memory@80000000", undefined, "Describe the RAM window.");
    case "console":
      return consoleEdit(doc);
    default:
      return { edits: [], note: HELP };
  }
}

export function proposeEdits(request: string, doc: DtDocument): EditPlan {
  const raw = request.trim();
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  if (!text) return { edits: [], note: HELP };
  if (/^(start from( the)? template|use the minimum template|new board from template)$/.test(text)) {
    return templatePlan();
  }
  if (/^remove\s+/.test(text)) return proposeRemoval(doc, raw.replace(/^remove\s+/i, ""));
  if (looksLikeLine(raw)) return proposeLine(raw, doc);
  if (!doc.root) return { edits: [], note: "The source has no root node yet. Start from the template." };

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

export function proposeLine(request: string, doc: DtDocument): EditPlan {
  const raw = request.trim().replace(/^(add|insert)\s+/i, "");
  if (!doc.root) return { edits: [], note: "The source has no root node yet. Start from the template." };
  if (/^remove\s+/i.test(request.trim())) return proposeRemoval(doc, request.trim().replace(/^remove\s+/i, ""));

  const property = raw.match(/^([#A-Za-z_][\w,.-]*)\s*=\s*([\s\S]+?)\s*;?$/);
  if (property && !raw.includes("{")) {
    return placeProperty(doc, property[1], `${property[1]} = ${property[2].trim().replace(/;$/, "")}`);
  }
  const flag = raw.match(/^([#A-Za-z_][\w,.-]*)\s*;$/);
  if (flag) return placeProperty(doc, flag[1], `${flag[1]};`);

  const node = splitNode(raw);
  if (!node) return { edits: [], note: HELP };
  return nodeEdit(doc, parentPath(doc, node.name), node.name, node.label, `Add ${node.label ? `${node.label}: ` : ""}${node.name} from the line you typed.`, node.body);
}

export function proposeRemoval(doc: DtDocument, query: string): EditPlan {
  if (!doc.root) return { edits: [], note: "The source has no root node yet." };
  const node = resolveQuery(doc, query);
  if (!node) return { edits: [], note: `No node matches “${query.trim()}”. Use a label, alias, or node name.` };
  if (node.path === "/") return { edits: [], note: "The root stays. Remove a node inside it." };
  const name = node.labels[0] ?? node.fullName;
  return {
    edits: [
      {
        id: `remove-${node.path}`,
        title: `Remove ${name}`,
        detail: `Delete ${node.path} from the file. An alias that still names it is left in place.`,
        apply: (source) => deleteNode(source, node.path),
      },
    ],
    note: null,
  };
}

function templatePlan(): EditPlan {
  return {
    edits: [
      {
        id: "template",
        title: "Start from the minimum template",
        detail: "Replace the open file with /dts-v1/;, a root, one CPU, memory, a console, and an empty soc.",
        apply: () => MINIMUM_TEMPLATE,
      },
    ],
    note: null,
  };
}

function looksLikeLine(raw: string): boolean {
  const text = raw.trim();
  if (text.includes("\n") && !text.includes("{")) return false;
  if (/^(add|insert)\s+/i.test(text)) return looksLikeLine(text.replace(/^(add|insert)\s+/i, ""));
  return text.includes("=") || text.includes("@") || text.includes("{") || text.endsWith(";") || /^[A-Za-z_][\w-]*(\s*:\s*[A-Za-z_][\w-]*)?$/.test(text);
}

function placeProperty(doc: DtDocument, name: string, statement: string): EditPlan {
  if (name === "stdout-path" || name === "bootargs") {
    const chosen = doc.root?.children.find((node) => !node.deleted && node.name === "chosen");
    if (!chosen) {
      return nodeEdit(doc, "/", "chosen", undefined, `Add chosen with ${name}.`, `${statement};`.replace(/;;$/, ";"));
    }
    return propertyEdit(doc, chosen.path, name, statement, `Set ${name} on chosen.`);
  }
  return propertyEdit(doc, "/", name, statement, `Set ${name} on the root.`);
}

function propertyEdit(doc: DtDocument, path: string, name: string, statement: string, detail: string): EditPlan {
  if (!doc.root) return { edits: [], note: "The source has no root node yet. Start from the template." };
  return {
    edits: [
      {
        id: `prop-${path}-${name}`,
        title: `Set ${name}`,
        detail,
        apply: (source) => upsertProperty(source, path, name, statement),
      },
    ],
    note: null,
  };
}

function cellsEdit(doc: DtDocument): EditPlan {
  const edits: TreeEdit[] = [];
  if (!propertyByName(doc.root!, "#address-cells")) {
    edits.push({
      id: "gap-address-cells",
      title: "Set #address-cells",
      detail: "Children read the first cell of reg as an address.",
      apply: (source) => upsertProperty(source, "/", "#address-cells", "#address-cells = <1>"),
    });
  }
  if (!propertyByName(doc.root!, "#size-cells")) {
    edits.push({
      id: "gap-size-cells",
      title: "Set #size-cells",
      detail: "Children read the following cells of reg as a size.",
      apply: (source) => upsertProperty(source, "/", "#size-cells", "#size-cells = <1>"),
    });
  }
  return edits.length > 0 ? { edits, note: null } : { edits: [], note: "Address cells are already set." };
}

function cpuEdit(doc: DtDocument): EditPlan {
  const cpus = doc.root?.children.find((node) => !node.deleted && node.name === "cpus");
  if (!cpus) return nodeEdit(doc, "/", "cpus", undefined, "Add a cpus node with one CPU.", defaultBody("cpus") + "\n\n    cpu@0 {\n        device_type = \"cpu\";\n        compatible = \"arm,cortex-a53\";\n        reg = <0>;\n    };");
  return nodeEdit(doc, cpus.path, "cpu@0", undefined, "Add cpu@0 under cpus.");
}

function consoleEdit(doc: DtDocument): EditPlan {
  const chosen = doc.root?.children.find((node) => !node.deleted && node.name === "chosen");
  if (!chosen) return nodeEdit(doc, "/", "chosen", undefined, "Add a chosen console.");
  return propertyEdit(doc, chosen.path, "stdout-path", 'stdout-path = "serial0:115200n8"', "Name the boot console.");
}

function nodeEdit(doc: DtDocument, parent: string, fullName: string, label: string | undefined, detail: string, body?: string): EditPlan {
  if (!doc.root) return { edits: [], note: "The source has no root node yet. Start from the template." };
  const parentNode = parent === "/" ? doc.root : findPath(doc.root, parent);
  if (parentNode?.children.some((child) => !child.deleted && child.fullName === fullName)) {
    return { edits: [], note: `${fullName} is already in ${parent === "/" ? "the root" : parent}.` };
  }
  if (label && findLabel(doc.root, label)) {
    return { edits: [], note: `The label ${label} is already in this file. Pick another label, or type the node name alone.` };
  }
  const edits: TreeEdit[] = [];
  let target = parent;
  if (parent === "/soc" && !findPath(doc.root, "/soc")) {
    edits.push({
      id: "add-soc",
      title: "Add an soc bus",
      detail: "On-chip devices sit on soc so their reg values share one address map.",
      apply: (source) => insertChild(source, "/", nodeBlock(undefined, "soc", undefined)),
    });
    target = "/soc";
  }
  const heading = label ? `${label}: ${fullName}` : fullName;
  edits.push({
    id: `add-${target}-${fullName}`,
    title: `Add ${heading}`,
    detail,
    apply: (source) => insertChild(source, target, nodeBlock(label, fullName, body)),
  });
  return { edits, note: null };
}

function parentPath(doc: DtDocument, fullName: string): string {
  const name = fullName.split("@")[0] ?? fullName;
  if (["chosen", "aliases", "cpus", "memory", "soc", "reserved-memory", "leds", "gpio-keys"].includes(name) || name.startsWith("memory") || name.startsWith("reserved")) {
    return "/";
  }
  if (name === "cpu" || name.startsWith("cpu")) {
    const cpus = doc.root?.children.find((node) => !node.deleted && node.name === "cpus");
    return cpus?.path ?? "/";
  }
  if (/flash|nor|nand|mtd/.test(name)) {
    const spi = findFirst(doc.root!, (node) => node.name.startsWith("spi") && Boolean(propertyByName(node, "#address-cells")));
    if (spi?.path) return spi.path;
  }
  if (!/^(serial|uart|i2c|spi|mmc|gpio|ethernet|usb|pwm|can|adc|timer|intc|interrupt-controller)$/.test(name) && fullName.includes("@")) {
    const i2c = i2cBuses(doc.root)[0];
    if (i2c?.path) return i2c.path;
  }
  const soc = doc.root?.children.find((node) => !node.deleted && node.name === "soc");
  if (soc) return "/soc";
  if (/^(serial|uart|i2c|spi|mmc|gpio|ethernet|usb)$/.test(name)) return "/soc";
  return "/";
}

function splitNode(raw: string): { label?: string; name: string; body?: string } | null {
  const brace = raw.indexOf("{");
  const head = (brace >= 0 ? raw.slice(0, brace) : raw).trim().replace(/;$/, "");
  const match = head.match(/^(?:([A-Za-z_][\w-]*)\s*:\s*)?([A-Za-z_][\w-]*)(?:@([0-9A-Za-z]+))?$/);
  if (!match) return null;
  const name = match[3] ? `${match[2]}@${match[3]}` : match[2];
  if (brace < 0) return { label: match[1], name };
  const end = raw.lastIndexOf("}");
  if (end <= brace) return null;
  return { label: match[1], name, body: raw.slice(brace, end + 1).trim() };
}

function nodeBlock(label: string | undefined, fullName: string, body: string | undefined): string {
  const head = `${label ? `${label}: ` : ""}${fullName}`;
  if (body?.trim().startsWith("{")) return `${head} ${body.trim()}`;
  const inner = (body ?? defaultBody(fullName)).trim();
  return `${head} {\n    ${inner.replaceAll("\n", "\n    ")}\n};`;
}

function defaultBody(fullName: string): string {
  const at = fullName.indexOf("@");
  const name = at >= 0 ? fullName.slice(0, at) : fullName;
  const unit = at >= 0 ? fullName.slice(at + 1) : null;
  const addr = unit === null ? null : unit.startsWith("0x") ? unit : `0x${unit}`;
  if (name === "cpu") return `device_type = "cpu";\n    compatible = "arm,cortex-a53";\n    reg = <${unit ?? "0"}>;`;
  if (name === "memory") return `device_type = "memory";\n    reg = <${addr ?? "0x80000000"} 0x40000000>;`;
  if (name === "chosen") return `stdout-path = "serial0:115200n8";`;
  if (name === "cpus") return `#address-cells = <1>;\n    #size-cells = <0>;`;
  if (name === "soc") return `compatible = "simple-bus";\n    #address-cells = <1>;\n    #size-cells = <1>;\n    ranges;`;
  if (name === "leds") return `compatible = "gpio-leds";`;
  if (name.startsWith("serial") || name.startsWith("uart")) {
    return `compatible = "ns16550";\n    reg = <${addr ?? "0x0"} 0x1000>;\n    status = "okay";`;
  }
  if (name.startsWith("i2c")) return `#address-cells = <1>;\n    #size-cells = <0>;\n    status = "okay";`;
  if (name.startsWith("spi")) return `#address-cells = <1>;\n    #size-cells = <0>;\n    status = "okay";`;
  if (addr) return `reg = <${addr} 0x1000>;\n    status = "okay";`;
  return `status = "okay";`;
}

function hasCpu(root: DtNode | null): boolean {
  if (!root) return false;
  return Boolean(findFirst(root, (node) => node.name === "cpu" || node.fullName.startsWith("cpu@") || stringValues(propertyByName(node, "device_type")).includes("cpu")));
}

function hasMemory(root: DtNode | null): boolean {
  if (!root) return false;
  return Boolean(findFirst(root, (node) => node.name === "memory" || stringValues(propertyByName(node, "device_type")).includes("memory")));
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

function deleteNode(source: string, path: string): string {
  const node = nodeByPath(source, path);
  if (node.path === "/") throw new Error("The root stays.");
  const lines = source.split("\n");
  lines.splice(node.line - 1, node.endLine - node.line + 1);
  return lines.join("\n");
}

function upsertProperty(source: string, path: string, name: string, statement: string): string {
  const node = nodeByPath(source, path);
  const lines = source.split("\n");
  const closing = lines[node.endLine - 1] ?? "";
  const indent = `${(closing.match(/^\s*/) ?? [""])[0]}    `;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const slot = lines.findIndex(
    (line, index) =>
      index >= node.line &&
      index < node.endLine - 1 &&
      line.startsWith(indent) &&
      !line.startsWith(`${indent} `) &&
      new RegExp(`^\\s*${escaped}\\s*(=|;)`).test(line),
  );
  const written = `${indent}${statement.trim().replace(/;$/, "")};`;
  if (slot >= 0) {
    lines[slot] = written;
    return lines.join("\n");
  }
  lines.splice(node.line, 0, written);
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
