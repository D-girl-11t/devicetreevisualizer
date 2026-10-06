import type { BringupBoard, BringupLink } from "./bringup";
import { propertyByName, stringValues } from "./format";
import { formatSize, type MemoryMap } from "./memory-map";
import type { DtDocument, DtNode } from "./types";

export type DiagramRole = "cpu" | "soc" | "board";
export type DiagramSide = "inside" | "left" | "right" | "top" | "bottom";

export type DiagramNode = {
  id: string;
  path: string | null;
  title: string;
  subtitle: string;
  role: DiagramRole;
  side: DiagramSide;
  enabled: boolean;
  names: string[];
  /** Labels of on-chip blocks this part is wired to, taken from pinctrl and gpios. */
  hooks: string[];
};

export type DiagramEdge = {
  from: string;
  to: string;
};

export type BoardDiagram = {
  socLabel: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

export type PlacedNode = DiagramNode & { x: number; y: number; w: number; h: number };

export type PlacedDiagram = {
  width: number;
  height: number;
  soc: { x: number; y: number; w: number; h: number; label: string };
  nodes: PlacedNode[];
  edges: { from: string; to: string; x1: number; y1: number; x2: number; y2: number }[];
};

const BOX_W = 128;
const BOX_H = 48;
const GAP = 12;

export function buildBoardDiagram(doc: DtDocument, board: BringupBoard, map: MemoryMap): BoardDiagram {
  const nodes: DiagramNode[] = [];
  const cpu = cpuNode(doc.root);
  if (cpu) nodes.push(cpu);

  const links = board.links.filter((link) => !link.deleted);
  for (const link of links) {
    const placed = classify(link);
    if (!placed) continue;
    nodes.push(placed);
  }

  const leds = links.filter((link) => link.kernel.subsystem === "LED");
  if (leds.length > 1) {
    replaceGroup(nodes, leds, "leds", "LEDs", `${leds.length} lamps`, "/leds");
  }
  const keys = links.filter((link) => link.kernel.subsystem === "input");
  if (keys.length > 1) {
    replaceGroup(nodes, keys, "keys", "Buttons", `${keys.length} keys`, "/gpio-keys");
  }

  for (const ram of map.regions.filter((region) => region.kind === "ram")) {
    nodes.push({
      id: `ram:${ram.id}`,
      path: ram.path,
      title: "DDR memory",
      subtitle: ram.size !== null ? formatSize(ram.size) : "RAM",
      role: "board",
    side: "right",
    enabled: true,
    names: ["memory"],
    hooks: [],
  });
  }

  const edges = connect(nodes);
  return { socLabel: "System-on-chip", nodes, edges };
}

const ARROW = 36;

export function layoutDiagram(diagram: BoardDiagram): PlacedDiagram {
  const inside = diagram.nodes.filter((node) => node.side === "inside");
  const outside = diagram.nodes.filter((node) => node.side !== "inside");
  const partnerOf = new Map(diagram.edges.map((edge) => [edge.from, edge.to]));
  const groups = new Map<string, DiagramNode[]>();
  const loose: DiagramNode[] = [];
  for (const node of outside) {
    const partner = partnerOf.get(node.id);
    if (!partner || !inside.some((item) => item.id === partner)) {
      loose.push(node);
      continue;
    }
    const list = groups.get(partner) ?? [];
    list.push(node);
    groups.set(partner, list);
  }
  const sideOf = new Map<string, DiagramSide>();
  for (const [insideId, members] of groups) sideOf.set(insideId, members[0].side);

  const { rows, cols, slots } = arrange(inside, sideOf);
  const rowH = Array.from({ length: rows }, (_, row) => {
    let height = BOX_H;
    for (let column = 0; column < cols; column += 1) {
      const node = slots[row * cols + column];
      if (!node) continue;
      const side = sideOf.get(node.id);
      const count = groups.get(node.id)?.length ?? 0;
      if ((side === "left" && column === 0) || (side === "right" && column === cols - 1)) {
        height = Math.max(height, stackExtent(count, BOX_H));
      }
    }
    return height;
  });
  const colW = Array.from({ length: cols }, (_, column) => {
    let width = BOX_W;
    for (let row = 0; row < rows; row += 1) {
      const node = slots[row * cols + column];
      if (!node) continue;
      const side = sideOf.get(node.id);
      const count = groups.get(node.id)?.length ?? 0;
      if ((side === "top" && row === 0) || (side === "bottom" && row === rows - 1)) {
        width = Math.max(width, stackExtent(count, BOX_W));
      }
    }
    return width;
  });

  const has = (side: DiagramSide) => outside.some((node) => node.side === side);
  const leftMargin = has("left") ? 8 + BOX_W + ARROW : 22;
  const topMargin = has("top") ? 8 + BOX_H + ARROW : 22;
  const rowY: number[] = [];
  let cursorY = topMargin;
  for (const height of rowH) {
    rowY.push(cursorY);
    cursorY += height + GAP;
  }
  const colX: number[] = [];
  let cursorX = leftMargin;
  for (const width of colW) {
    colX.push(cursorX);
    cursorX += width + GAP;
  }
  const gridRight = colX[cols - 1] + colW[cols - 1];
  const gridBottom = rowY[rows - 1] + rowH[rows - 1];
  const soc = {
    x: leftMargin - 14,
    y: topMargin - 14,
    w: gridRight - leftMargin + 28,
    h: gridBottom - topMargin + 28 + 16,
    label: diagram.socLabel,
  };

  const placed = new Map<string, PlacedNode>();
  slots.forEach((node, index) => {
    if (!node) return;
    const column = index % cols;
    const row = Math.floor(index / cols);
    const box: PlacedNode = {
      ...node,
      x: colX[column] + (colW[column] - BOX_W) / 2,
      y: rowY[row] + (rowH[row] - BOX_H) / 2,
      w: BOX_W,
      h: BOX_H,
    };
    placed.set(node.id, box);
    const members = groups.get(node.id) ?? [];
    const side = sideOf.get(node.id) ?? "left";
    members.forEach((member, memberIndex) => {
      placed.set(member.id, beside(box, member, side, memberIndex, members.length));
    });
  });

  let lowest = soc.y + soc.h;
  for (const node of placed.values()) lowest = Math.max(lowest, node.y + node.h);
  let looseX = soc.x;
  const looseY = lowest + GAP;
  for (const node of loose) {
    placed.set(node.id, { ...node, x: looseX, y: looseY, w: BOX_W, h: BOX_H });
    looseX += BOX_W + GAP;
  }

  let width = soc.x + soc.w + (has("right") ? ARROW + BOX_W + 8 : 16);
  let height = soc.y + soc.h + (has("bottom") || loose.length > 0 ? ARROW + BOX_H + 8 : 16);
  for (const node of placed.values()) {
    width = Math.max(width, node.x + node.w + 8);
    height = Math.max(height, node.y + node.h + 8);
  }

  const edges = diagram.edges.flatMap((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return [];
    const side = from.side === "inside" ? to.side : from.side;
    const stub = shortStub(from, to, side);
    return [{ ...edge, ...stub }];
  });

  return { width, height, soc, nodes: [...placed.values()], edges };
}

function cpuNode(root: DtNode | null): DiagramNode | null {
  const cores = root?.children.find((node) => node.name === "cpus")?.children.filter((node) => !node.deleted) ?? [];
  if (cores.length === 0) return null;
  const names = [...new Set(cores.flatMap((core) => stringValues(propertyByName(core, "compatible"))))];
  const short = names.map((name) => name.split(",").pop() ?? name);
  const kind = short.length > 0 ? short.join(", ") : "CPU";
  return {
    id: "cpu",
    path: root?.children.find((node) => node.name === "cpus")?.path ?? null,
    title: "CPU cores",
    subtitle: cores.length === 1 ? kind : `${cores.length}× ${kind}`,
    role: "cpu",
    side: "inside",
    enabled: true,
    names: ["cpu", "cpus"],
    hooks: [],
  };
}

function classify(link: BringupLink): DiagramNode | null {
  const subsystem = link.kernel.subsystem;
  const enabled = link.status !== "disabled";
  const off = enabled ? "" : "off";

  if (subsystem === "pinctrl" || subsystem === "memory") return null;
  if (subsystem === "clock" && link.compatible.some((item) => item.includes("fixed-clock"))) return null;
  if (subsystem === "i2c" && link.kernel.driver.startsWith("No standard")) return null;
  if (subsystem === "spi" && link.kernel.driver.startsWith("No standard")) return null;

  if (isInside(link)) {
    const named = insideName(link);
    return {
      id: link.path,
      path: link.path,
      title: named.title,
      subtitle: off || named.subtitle,
      role: "soc",
      side: "inside",
      enabled,
      names: [link.label, link.title, link.path.split("/").pop() ?? ""].filter((name): name is string => Boolean(name)),
      hooks: pinHooks(link),
    };
  }

  if (isBoard(link)) {
    const named = boardName(link);
    return {
      id: link.path,
      path: link.path,
      title: named.title,
      subtitle: off || named.subtitle,
      role: "board",
      side: boardSide(link),
      enabled,
      names: [link.label, link.title].filter((name): name is string => Boolean(name)),
      hooks: pinHooks(link),
    };
  }

  return null;
}

function isInside(link: BringupLink): boolean {
  const subsystem = link.kernel.subsystem;
  if (["serial", "mmc", "net", "usb", "gpio", "irq"].includes(subsystem)) return true;
  if (subsystem === "i2c" || subsystem === "spi") return !link.kernel.driver.startsWith("No standard");
  if (subsystem === "clock") return true;
  const blob = `${link.title} ${link.compatible.join(" ")}`.toLowerCase();
  return /gpu|pcie|\bpci\b|i2s|sai\b|hdmi|\bdsi\b|\bcsi\b|crypto|caam/.test(blob);
}

function isBoard(link: BringupLink): boolean {
  const subsystem = link.kernel.subsystem;
  if (["eeprom", "hwmon", "mtd", "phy", "LED", "input", "regulator"].includes(subsystem)) return true;
  const blob = `${link.title} ${link.compatible.join(" ")}`.toLowerCase();
  return /wifi|wlan|camera|panel|lcd|codec|touch/.test(blob);
}

function insideName(link: BringupLink): { title: string; subtitle: string } {
  const label = link.label ?? "";
  switch (link.kernel.subsystem) {
    case "serial":
      return { title: label ? label.toUpperCase() : "UART", subtitle: link.title };
    case "i2c":
      return { title: label || "I2C", subtitle: "bus" };
    case "spi":
      return { title: label || "SPI", subtitle: "bus" };
    case "mmc":
      return { title: "MMC", subtitle: label || link.title };
    case "net":
      return { title: "Ethernet", subtitle: "MAC" };
    case "usb":
      return { title: "USB", subtitle: link.title };
    case "gpio":
      return { title: label || "GPIO", subtitle: "pins" };
    case "irq":
      return { title: "IRQ", subtitle: "controller" };
    case "clock":
      return { title: "Clocks", subtitle: "controller" };
    default:
      return { title: clip(link.title), subtitle: link.compatible[0]?.split(",")[0] ?? "" };
  }
}

function boardName(link: BringupLink): { title: string; subtitle: string } {
  switch (link.kernel.subsystem) {
    case "eeprom":
      return { title: "EEPROM", subtitle: link.title };
    case "hwmon":
      return { title: clip(link.title), subtitle: "sensor" };
    case "mtd":
      return { title: "SPI flash", subtitle: link.title };
    case "phy":
      return { title: "Ethernet PHY", subtitle: link.label || link.title };
    case "LED":
      return { title: "LED", subtitle: link.title };
    case "input":
      return { title: "Button", subtitle: link.title };
    case "regulator":
      return { title: "Supply", subtitle: link.title };
    default:
      return { title: clip(link.title), subtitle: "" };
  }
}

function boardSide(link: BringupLink): DiagramSide {
  const blob = `${link.title} ${link.compatible.join(" ")} ${link.kernel.subsystem}`.toLowerCase();
  if (/phy|wifi|wlan/.test(blob)) return "top";
  if (/mtd|spi|eeprom|hwmon|i2c|touch|codec/.test(blob)) return "left";
  if (/camera|csi|panel|lcd|dsi|display/.test(blob)) return "right";
  return "bottom";
}

function replaceGroup(nodes: DiagramNode[], members: BringupLink[], id: string, title: string, subtitle: string, path: string) {
  const paths = new Set(members.map((link) => link.path));
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (paths.has(nodes[index].path ?? "")) nodes.splice(index, 1);
  }
  nodes.push({
    id,
    path,
    title,
    subtitle,
    role: "board",
    side: "bottom",
    enabled: members.some((link) => link.status !== "disabled"),
    names: members.flatMap((link) => [link.label, link.title].filter((name): name is string => Boolean(name))),
    hooks: [...new Set(members.flatMap((link) => pinHooks(link)))],
  });
}

function connect(nodes: DiagramNode[]): DiagramEdge[] {
  const inside = nodes.filter((node) => node.side === "inside");
  const byPath = new Map(inside.filter((node) => node.path).map((node) => [node.path as string, node]));
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();

  const add = (from: string | null, to: string | null) => {
    if (!from || !to || from === to) return;
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };

  for (const node of nodes) {
    if (node.side === "inside" || node.role === "cpu") continue;
    if (node.id.startsWith("ram:")) {
      add(node.id, inside.find((item) => /ddr|memory-controller/i.test(item.title))?.id ?? "cpu");
      continue;
    }
    const parent = parentInside(node.path, byPath);
    if (parent) {
      add(node.id, parent.id);
      continue;
    }
    const hooked = inside.find((item) => node.hooks.some((hook) => item.names.includes(hook)));
    if (hooked) add(node.id, hooked.id);
  }

  return edges.filter((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to));
}

function pinHooks(link: BringupLink): string[] {
  return link.pins
    .map((pin) => pin.split(/[\s:]/)[0] ?? "")
    .filter((hook) => hook.length > 0);
}

function parentInside(path: string | null, byPath: Map<string, DiagramNode>): DiagramNode | undefined {
  let cursor = path ? parentOf(path) : null;
  while (cursor) {
    const found = byPath.get(cursor);
    if (found) return found;
    cursor = parentOf(cursor);
  }
  return undefined;
}

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "/";
  return path.slice(0, cut);
}

function arrange(
  inside: DiagramNode[],
  sideOf: Map<string, DiagramSide>,
): { rows: number; cols: number; slots: (DiagramNode | null)[] } {
  const on = (side: DiagramSide) => inside.filter((node) => sideOf.get(node.id) === side);
  const left = on("left");
  const right = on("right");
  const top = on("top");
  const bottom = on("bottom");
  const pinned = new Set([...left, ...right, ...top, ...bottom].map((node) => node.id));
  const rest = inside.filter((node) => !pinned.has(node.id));
  const count = Math.max(inside.length, 1);
  let cols = count <= 2 ? count : count <= 4 ? 2 : 4;
  let rows = Math.max(1, Math.ceil(count / cols), left.length, right.length);
  cols = Math.max(cols, top.length, bottom.length, 1);
  while (rows * cols < count) rows += 1;

  const slots: (DiagramNode | null)[] = Array(rows * cols).fill(null);
  left.forEach((node, index) => {
    slots[Math.min(index, rows - 1) * cols] = node;
  });
  right.forEach((node, index) => {
    slots[Math.min(index, rows - 1) * cols + cols - 1] = node;
  });
  let topColumn = 0;
  for (const node of top) {
    while (topColumn < cols && slots[topColumn]) topColumn += 1;
    if (topColumn < cols) slots[topColumn] = node;
    else fillFirstFree(slots, node);
  }
  let bottomColumn = 0;
  for (const node of bottom) {
    while (bottomColumn < cols && slots[(rows - 1) * cols + bottomColumn]) bottomColumn += 1;
    if (bottomColumn < cols) slots[(rows - 1) * cols + bottomColumn] = node;
    else fillFirstFree(slots, node);
  }
  const cpu = rest.find((node) => node.role === "cpu");
  const others = rest.filter((node) => node !== cpu);
  if (cpu) {
    const center = Math.floor((rows - 1) / 2) * cols + Math.floor((cols - 1) / 2);
    if (!slots[center]) slots[center] = cpu;
    else fillFirstFree(slots, cpu);
  }
  for (const node of others) fillFirstFree(slots, node);
  return { rows, cols, slots };
}

function fillFirstFree(slots: (DiagramNode | null)[], node: DiagramNode) {
  const index = slots.indexOf(null);
  if (index >= 0) slots[index] = node;
}

function stackExtent(count: number, item: number): number {
  if (count <= 1) return item;
  return count * item + (count - 1) * 8;
}

function beside(box: PlacedNode, member: DiagramNode, side: DiagramSide, index: number, count: number): PlacedNode {
  if (side === "top" || side === "bottom") {
    const span = stackExtent(count, BOX_W);
    const start = box.x + box.w / 2 - span / 2;
    const y = side === "top" ? box.y - ARROW - BOX_H : box.y + box.h + ARROW;
    return { ...member, x: start + index * (BOX_W + 8), y, w: BOX_W, h: BOX_H };
  }
  const span = stackExtent(count, BOX_H);
  const start = box.y + box.h / 2 - span / 2;
  const x = side === "left" ? box.x - ARROW - BOX_W : box.x + box.w + ARROW;
  return { ...member, x, y: start + index * (BOX_H + 8), w: BOX_W, h: BOX_H };
}

function shortStub(from: PlacedNode, to: PlacedNode, side: DiagramSide): { x1: number; y1: number; x2: number; y2: number } {
  const outer = from.side === "inside" ? to : from;
  const inner = from.side === "inside" ? from : to;
  if (side === "left") {
    return { x1: outer.x + outer.w, y1: outer.y + outer.h / 2, x2: inner.x, y2: inner.y + inner.h / 2 };
  }
  if (side === "right") {
    return { x1: outer.x, y1: outer.y + outer.h / 2, x2: inner.x + inner.w, y2: inner.y + inner.h / 2 };
  }
  if (side === "top") {
    return { x1: outer.x + outer.w / 2, y1: outer.y + outer.h, x2: inner.x + inner.w / 2, y2: inner.y };
  }
  return { x1: outer.x + outer.w / 2, y1: outer.y, x2: inner.x + inner.w / 2, y2: inner.y + inner.h };
}

function clip(text: string): string {
  return text.length > 16 ? `${text.slice(0, 15)}…` : text;
}
