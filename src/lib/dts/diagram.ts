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

export function layoutDiagram(diagram: BoardDiagram): PlacedDiagram {
  const inside = diagram.nodes.filter((node) => node.side === "inside");
  const left = diagram.nodes.filter((node) => node.side === "left");
  const right = diagram.nodes.filter((node) => node.side === "right");
  const top = diagram.nodes.filter((node) => node.side === "top");
  const bottom = diagram.nodes.filter((node) => node.side === "bottom");

  const count = Math.max(inside.length, 1);
  const cols = count <= 2 ? count : count <= 4 ? 2 : 4;
  const rows = Math.max(1, Math.ceil(inside.length / cols));
  const gridW = cols * BOX_W + Math.max(0, cols - 1) * GAP;
  const gridH = rows * BOX_H + Math.max(0, rows - 1) * GAP;
  const sideH = (items: DiagramNode[]) => (items.length === 0 ? 0 : items.length * BOX_H + (items.length - 1) * GAP);

  const socW = gridW + 36;
  const socH = Math.max(gridH + 46, sideH(left), sideH(right)) + 8;
  const topH = top.length > 0 ? BOX_H + 28 : 18;
  const bottomH = bottom.length > 0 ? BOX_H + 28 : 18;
  const leftW = left.length > 0 ? BOX_W + 40 : 18;
  const rightW = right.length > 0 ? BOX_W + 40 : 18;
  const width = leftW + socW + rightW;
  const height = topH + socH + bottomH;
  const soc = { x: leftW, y: topH, w: socW, h: socH, label: diagram.socLabel };

  const placed = new Map<string, PlacedNode>();
  const slots = placeInside(inside, rows, cols);
  const originX = soc.x + (soc.w - gridW) / 2;
  const originY = soc.y + 14 + (soc.h - 28 - gridH) / 2;
  slots.forEach((node, index) => {
    if (!node) return;
    const column = index % cols;
    const row = Math.floor(index / cols);
    placed.set(node.id, {
      ...node,
      x: originX + column * (BOX_W + GAP),
      y: originY + row * (BOX_H + GAP),
      w: BOX_W,
      h: BOX_H,
    });
  });

  stack(left, 8, soc.y + (soc.h - sideH(left)) / 2, placed);
  stack(right, soc.x + soc.w + 32, soc.y + (soc.h - sideH(right)) / 2, placed);
  const topW = top.length * BOX_W + Math.max(0, top.length - 1) * GAP;
  rowOf(top, soc.x + (soc.w - topW) / 2, 8, placed);
  const bottomW = bottom.length * BOX_W + Math.max(0, bottom.length - 1) * GAP;
  rowOf(bottom, soc.x + (soc.w - bottomW) / 2, soc.y + soc.h + 20, placed);

  const edges = diagram.edges.flatMap((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return [];
    const start = borderPoint(from, centerOf(to));
    const end = borderPoint(to, centerOf(from));
    return [{ ...edge, x1: start.x, y1: start.y, x2: end.x, y2: end.y }];
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

function placeInside(nodes: DiagramNode[], rows: number, cols: number): (DiagramNode | null)[] {
  const slots: (DiagramNode | null)[] = Array(rows * cols).fill(null);
  const cpu = nodes.find((node) => node.role === "cpu");
  const rest = nodes.filter((node) => node.role !== "cpu");
  if (cpu) {
    const center = Math.floor((rows - 1) / 2) * cols + Math.floor((cols - 1) / 2);
    slots[center] = cpu;
  }
  let cursor = 0;
  for (const node of rest) {
    while (cursor < slots.length && slots[cursor]) cursor += 1;
    if (cursor < slots.length) slots[cursor] = node;
  }
  return slots;
}

function stack(nodes: DiagramNode[], x: number, y: number, placed: Map<string, PlacedNode>) {
  nodes.forEach((node, index) => {
    placed.set(node.id, { ...node, x, y: y + index * (BOX_H + GAP), w: BOX_W, h: BOX_H });
  });
}

function rowOf(nodes: DiagramNode[], x: number, y: number, placed: Map<string, PlacedNode>) {
  nodes.forEach((node, index) => {
    placed.set(node.id, { ...node, x: x + index * (BOX_W + GAP), y, w: BOX_W, h: BOX_H });
  });
}

function centerOf(node: PlacedNode): { x: number; y: number } {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

function borderPoint(box: PlacedNode, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function clip(text: string): string {
  return text.length > 16 ? `${text.slice(0, 15)}…` : text;
}
