import { indexDocument, type DtIndex } from "./analyze";
import { formatPropertyValue, propertyByName, statusOf, stringValues } from "./format";
import type { DtCell, DtDocument, DtNode, DtProperty, DtRef } from "./types";

export type KernelOwner = "kernel" | "userspace" | "internal";

export type KernelGuess = {
  subsystem: string;
  driver: string;
  config: string | null;
  owner: KernelOwner;
  /** This block needs a pin group before it can leave the SoC balls. */
  needsPins: boolean;
};

export type BringupNote = {
  tone: "warn" | "info";
  message: string;
};

export type BringupLink = {
  path: string;
  title: string;
  label: string | null;
  status: string | null;
  deleted: boolean;
  fromOverlay: boolean;
  compatible: string[];
  aliases: string[];
  pins: string[];
  supplies: string[];
  clocks: string[];
  interrupt: string | null;
  reg: string | null;
  kernel: KernelGuess;
  userspace: string;
  notes: BringupNote[];
};

export type BoardAlias = {
  name: string;
  path: string | null;
  title: string | null;
  status: string | null;
  missing: boolean;
};

export type BringupBoard = {
  model: string | null;
  compatible: string[];
  stdout: string | null;
  bootargs: string | null;
  memory: string[];
  reserved: string[];
  cpus: number;
  aliases: BoardAlias[];
  unresolved: string[];
  links: BringupLink[];
};

const SKIP_CHILD_NAMES = new Set([
  "aliases",
  "chosen",
  "cpus",
  "memory",
  "reserved-memory",
  "clocks",
  "regulators",
]);

export function analyzeBringup(doc: DtDocument, index: DtIndex = indexDocument(doc)): BringupBoard {
  const root = doc.root;
  const aliases = aliasTable(root, index);
  const byPath = invertAliases(aliases);
  const stdout = chosenString(root, "stdout-path");
  const consoleAlias = stdout?.split(":")[0] ?? null;
  const consolePath =
    consoleAlias && aliases.has(consoleAlias) ? aliases.get(consoleAlias)!.path : null;
  const hasPinctrl = index.nodes.some(isPinctrlController);
  const gpioIndex = new Map<string, number>();
  let gpioNext = 0;
  for (const node of index.nodes) {
    if (node.deleted) continue;
    if (isGpioController(node)) gpioIndex.set(node.path, gpioNext++);
  }

  const links: BringupLink[] = [];
  const walk = (node: DtNode, parent: DtNode | null) => {
    if (shouldList(node, parent)) {
      links.push(
        describeLink(node, parent, {
          index,
          aliases: byPath.get(node.path) ?? [],
          consolePath,
          stdout,
          hasPinctrl,
          gpioIndex,
          aliasByName: aliases,
        }),
      );
    }
    for (const child of node.children) walk(child, node);
  };
  if (root) walk(root, null);
  const rank = new Map(
    ["serial", "i2c", "eeprom", "hwmon", "spi", "mtd", "mmc", "net", "phy", "usb", "gpio", "LED", "input", "regulator", "pinctrl", "clock", "irq", "memory", "other"].map(
      (name, index) => [name, index],
    ),
  );
  links.sort(
    (a, b) =>
      (rank.get(a.kernel.subsystem) ?? 99) - (rank.get(b.kernel.subsystem) ?? 99) ||
      Number(a.deleted) - Number(b.deleted),
  );

  return {
    model: chosenModel(root),
    compatible: root ? stringValues(propertyByName(root, "compatible")) : [],
    stdout,
    bootargs: chosenString(root, "bootargs"),
    memory: memoryLines(root),
    reserved: reservedLines(root),
    cpus: root ? root.children.find((node) => node.name === "cpus")?.children.length ?? 0 : 0,
    aliases: [...aliases.values()],
    unresolved: doc.unresolved.map((node) => (node.ref ? formatRefLabel(node.ref) : node.fullName)),
    links,
  };
}

type DescribeContext = {
  index: DtIndex;
  aliases: string[];
  consolePath: string | null;
  stdout: string | null;
  hasPinctrl: boolean;
  gpioIndex: Map<string, number>;
  aliasByName: Map<string, BoardAlias>;
};

function describeLink(node: DtNode, parent: DtNode | null, ctx: DescribeContext): BringupLink {
  const compatible = stringValues(propertyByName(node, "compatible"));
  const status = statusOf(node);
  const enabled = !node.deleted && status !== "disabled" && !ancestorDisabled(node, ctx.index);
  const kernel = guessKernel(node, parent, compatible);
  const pinLines = pinLinesFor(node, ctx.index);
  const supplies = supplyLines(node, ctx.index);
  const notes: BringupNote[] = [];

  if (node.deleted) {
    notes.push({
      tone: "info",
      message: node.fromOverlay
        ? "An overlay removes this node."
        : "This node is deleted and will not probe.",
    });
  }

  if (!node.deleted && status === "disabled" && node.path === ctx.consolePath) {
    notes.push({
      tone: "warn",
      message: `Boot console ${ctx.stdout} points here, and the node is disabled. The tty the bootloader named will not exist.`,
    });
  } else if (!node.deleted && status === "disabled" && ctx.aliases.length > 0) {
    notes.push({
      tone: "warn",
      message: `Alias ${ctx.aliases.join(", ")} points at a disabled node.`,
    });
  }

  if (!node.deleted && status !== "disabled" && ancestorDisabled(node, ctx.index)) {
    const holder = disabledAncestor(node, ctx.index);
    notes.push({
      tone: "warn",
      message: holder
        ? `Parent ${holder.fullName} is disabled, so this node will not probe.`
        : "A parent node is disabled, so this node will not probe.",
    });
  }

  for (const ref of unresolvedRefs(node, ctx.index)) {
    notes.push({
      tone: "warn",
      message: `${formatRefLabel(ref)} is not in this tree.`,
    });
  }

  const describedPins = pinLines.length > 0 || supplies.length > 0;
  if (kernel.needsPins && enabled && ctx.hasPinctrl && !describedPins && !hasPinctrlProp(node)) {
    notes.push({
      tone: "warn",
      message: "No pin group. The balls for this block are not described, so the pad mux is still whatever reset left behind.",
    });
  }

  if (enabled && compatible.length > 0 && kernel.driver.startsWith("No standard driver")) {
    notes.push({
      tone: "info",
      message: "Match this compatible string to a binding and a CONFIG_ symbol before expecting a device node.",
    });
  }

  return {
    path: node.path,
    title: node.fullName,
    label: node.labels[0] ?? null,
    status,
    deleted: node.deleted,
    fromOverlay: node.fromOverlay || node.modifiedByOverlay,
    compatible,
    aliases: ctx.aliases,
    pins: pinLines,
    supplies,
    clocks: clockLines(node),
    interrupt: interruptLine(node),
    reg: regLine(node),
    kernel,
    userspace: userspacePath(node, parent, kernel, ctx),
    notes,
  };
}

function guessKernel(node: DtNode, parent: DtNode | null, compatible: string[]): KernelGuess {
  const joined = compatible.join(" ");
  const parentCompatible = parent ? stringValues(propertyByName(parent, "compatible")) : [];
  const name = node.name;

  if (compatible.includes("gpio-leds") || parentCompatible.includes("gpio-leds")) {
    return internalish("LED", "leds-gpio", "CONFIG_LEDS_GPIO", "kernel", false);
  }
  if (compatible.includes("gpio-keys") || parentCompatible.includes("gpio-keys")) {
    return internalish("input", "gpio-keys", "CONFIG_KEYBOARD_GPIO", "kernel", false);
  }
  if (compatible.some((item) => item === "regulator-fixed" || item.startsWith("regulator-"))) {
    return internalish("regulator", "regulator-fixed", "CONFIG_REGULATOR_FIXED_VOLTAGE", "kernel", false);
  }
  if (compatible.includes("fixed-clock") || name === "clock" || name.startsWith("clock-")) {
    return internalish("clock", compatible[0] ?? "clock", "CONFIG_COMMON_CLK", "internal", false);
  }
  if (compatible.some((item) => item.includes("shared-dma-pool"))) {
    return internalish("memory", "reserved DMA pool", null, "internal", false);
  }
  if (compatible.some((item) => item.startsWith("arm,gic") || item.includes("interrupt-controller"))) {
    return internalish("irq", compatible[0] ?? "irqchip", null, "internal", false);
  }
  if (isPinctrlController(node)) {
    return internalish("pinctrl", compatible[0] ?? "pinctrl", null, "internal", false);
  }
  if (isGpioController(node)) {
    return internalish("gpio", compatible[0] ?? "gpio", "CONFIG_GPIOLIB", "kernel", false);
  }
  if (compatible.some((item) => item.includes("ethernet-phy"))) {
    return internalish("phy", "phylib", "CONFIG_PHYLIB", "internal", false);
  }
  if (isSerial(node, joined)) {
    const driver = joined.includes("ns16550") ? "8250 / ns16550" : "serial";
    return internalish("serial", driver, "CONFIG_SERIAL_8250", "kernel", true);
  }
  if (compatible.some((item) => item.startsWith("atmel,24c") || item.includes("at24"))) {
    return internalish("eeprom", "at24", "CONFIG_EEPROM_AT24", "kernel", false);
  }
  if (compatible.some((item) => item.includes("tmp102"))) {
    return internalish("hwmon", "tmp102", "CONFIG_SENSORS_TMP102", "kernel", false);
  }
  if (compatible.some((item) => item.includes("am2320") || item.includes("am2315"))) {
    return internalish("hwmon", "humidity sensor", "CONFIG_SENSORS_AM2320", "kernel", false);
  }
  if (compatible.some((item) => item.includes("spi-nor") || item.includes("m25p"))) {
    return internalish("mtd", "spi-nor", "CONFIG_MTD_SPI_NOR", "kernel", false);
  }
  if (compatible.includes("spidev")) {
    return internalish("spi", "spidev", "CONFIG_SPI_SPIDEV", "userspace", false);
  }
  if (isI2cController(node)) {
    return internalish("i2c", compatible[0] ?? "i2c", "CONFIG_I2C", "kernel", true);
  }
  if (isSpiController(node)) {
    return internalish("spi", compatible[0] ?? "spi", "CONFIG_SPI", "kernel", true);
  }
  if (isMmc(node, joined)) {
    return internalish("mmc", compatible[0] ?? "mmc", "CONFIG_MMC", "kernel", true);
  }
  if (isEthernet(node, joined)) {
    return internalish("net", compatible[0] ?? "ethernet", "CONFIG_NET", "kernel", true);
  }
  if (isUsb(node, joined)) {
    return internalish("usb", compatible[0] ?? "usb", "CONFIG_USB", "kernel", true);
  }
  if (parent && isI2cController(parent)) {
    return internalish("i2c", "No standard driver guess", null, "kernel", false);
  }
  if (parent && isSpiController(parent)) {
    return internalish("spi", "No standard driver guess", null, "kernel", false);
  }
  if (compatible.length > 0) {
    return internalish("other", "No standard driver guess", null, "kernel", false);
  }
  return internalish("other", node.name, null, "internal", false);
}

function internalish(
  subsystem: string,
  driver: string,
  config: string | null,
  owner: KernelOwner,
  needsPins: boolean,
): KernelGuess {
  return { subsystem, driver, config, owner, needsPins };
}

function userspacePath(
  node: DtNode,
  parent: DtNode | null,
  kernel: KernelGuess,
  ctx: DescribeContext,
): string {
  const alias = (prefix: string): number | null => {
    const name = ctx.aliases.find((item) => item.startsWith(prefix));
    if (!name) return null;
    const number = name.slice(prefix.length);
    return /^\d+$/.test(number) ? Number(number) : null;
  };

  if (kernel.subsystem === "serial") {
    const number = alias("serial");
    return number === null ? "a tty after the driver probes (no serialN alias)" : `/dev/ttyS${number}`;
  }
  if (kernel.subsystem === "i2c" && isI2cController(node)) {
    const number = alias("i2c");
    return number === null
      ? "/dev/i2c-* once i2c-dev is loaded (no i2cN alias)"
      : `/dev/i2c-${number} with CONFIG_I2C_CHARDEV`;
  }
  if (parent && isI2cController(parent)) {
    const parentAlias = [...ctx.aliasByName.values()].find((alias) => alias.path === parent.path);
    const busName = parentAlias?.name.startsWith("i2c") ? parentAlias.name : null;
    const bus = busName && /^\d+$/.test(busName.slice(3)) ? busName.slice(3) : "?";
    const reg = stringValues(propertyByName(node, "reg"))[0] ?? propertyCell(node, "reg");
    const addr = reg ? i2cAddress(reg) : "????";
    if (kernel.subsystem === "eeprom") return `/sys/bus/i2c/devices/${bus}-${addr}/eeprom`;
    if (kernel.subsystem === "hwmon") return `/sys/class/hwmon (i2c ${bus}-${addr})`;
    return `/sys/bus/i2c/devices/${bus}-${addr} after a driver binds`;
  }
  if (kernel.subsystem === "spi" && isSpiController(node)) {
    return "/dev/spidev* only if a child is compatible \"spidev\"";
  }
  if (parent && isSpiController(parent) && kernel.subsystem === "mtd") {
    return "/dev/mtd*";
  }
  if (kernel.subsystem === "mmc") {
    const number = alias("mmc");
    return number === null ? "/dev/mmcblk*" : `/dev/mmcblk${number}`;
  }
  if (kernel.subsystem === "net") {
    const number = alias("ethernet");
    return number === null ? "a netdev after the MAC probes" : `eth${number} (alias ethernet${number})`;
  }
  if (kernel.subsystem === "usb") return "/dev/bus/usb and the gadget or host class device";
  if (kernel.subsystem === "gpio") {
    const chip = ctx.gpioIndex.get(node.path);
    return chip === undefined ? "a gpiochip via libgpiod" : `/dev/gpiochip${chip} via libgpiod`;
  }
  if (kernel.subsystem === "LED") {
    const label = stringValues(propertyByName(node, "label"))[0] ?? node.name;
    return `/sys/class/leds/${label}`;
  }
  if (kernel.subsystem === "input") {
    const label = stringValues(propertyByName(node, "label"))[0] ?? node.name;
    return `/dev/input/event* (${label})`;
  }
  if (kernel.subsystem === "regulator") {
    const name = stringValues(propertyByName(node, "regulator-name"))[0] ?? node.name;
    return `/sys/class/regulator/${name}`;
  }
  if (kernel.subsystem === "phy") return "attached to the MAC; no userspace node";
  if (kernel.subsystem === "clock") return "kernel clock tree";
  if (kernel.subsystem === "irq") return "kernel IRQ domain";
  if (kernel.subsystem === "pinctrl") return "debugfs pinctrl map";
  if (kernel.subsystem === "memory") return "kernel reserved memory";
  if (kernel.owner === "userspace") return kernel.driver;
  return "no stable userspace node from this description";
}

function shouldList(node: DtNode, parent: DtNode | null): boolean {
  if (node.path === "/") return false;
  if (isPinGroup(node)) return false;
  if (SKIP_CHILD_NAMES.has(node.name) && stringValues(propertyByName(node, "compatible")).length === 0) {
    return false;
  }
  const compatible = stringValues(propertyByName(node, "compatible"));
  if (compatible.length === 1 && (compatible[0] === "simple-bus" || compatible[0] === "simple-pm-bus")) {
    return false;
  }
  if (node.properties.some((property) => property.name === "device_type" && stringValues(property)[0] === "cpu")) {
    return false;
  }
  if (node.properties.some((property) => property.name === "device_type" && stringValues(property)[0] === "memory")) {
    return false;
  }
  if (compatible.some((item) => item.includes("shared-dma-pool"))) return false;
  const parentCompatible = parent ? stringValues(propertyByName(parent, "compatible")) : [];
  if (parentCompatible.includes("gpio-leds") || parentCompatible.includes("gpio-keys")) return true;
  if (
    (compatible.includes("gpio-leds") || compatible.includes("gpio-keys")) &&
    node.children.some((child) => !child.deleted)
  ) {
    return false;
  }
  if (compatible.length > 0) return true;
  if (isGpioController(node)) return true;
  return false;
}

function pinLinesFor(node: DtNode, index: DtIndex): string[] {
  const lines: string[] = [];
  for (const property of node.properties) {
    if (property.deleted) continue;
    if (!/^pinctrl-\d+$/.test(property.name)) continue;
    for (const ref of refsOf(property)) {
      const target = resolveRef(ref, index);
      if (!target) {
        lines.push(`${formatRefLabel(ref)} missing`);
        continue;
      }
      const pins = stringValues(propertyByName(target, "pins"));
      const group = target.labels[0] ?? target.fullName;
      lines.push(pins.length > 0 ? `${group}: ${pins.join(", ")}` : group);
    }
  }
  for (const property of node.properties) {
    if (property.deleted) continue;
    if (property.name !== "gpios" && property.name !== "gpio" && !property.name.endsWith("-gpios")) continue;
    lines.push(...gpioLines(property, index));
  }
  if (isPinGroup(node)) {
    const pins = stringValues(propertyByName(node, "pins"));
    if (pins.length) lines.push(pins.join(", "));
  }
  return lines;
}

function gpioLines(property: DtProperty, index: DtIndex): string[] {
  const lines: string[] = [];
  for (const part of property.parts) {
    if (part.kind !== "cells") continue;
    let cursor = 0;
    while (cursor < part.cells.length) {
      const cell = part.cells[cursor];
      if (cell.kind !== "ref") {
        cursor += 1;
        continue;
      }
      const controller = resolveRef(cell.ref, index);
      const width = gpioCells(controller);
      const line = part.cells[cursor + 1];
      const flag = part.cells[cursor + 2];
      const who = controller?.labels[0] ?? formatRefLabel(cell.ref);
      const flagText = flag ? gpioFlag(cellText(flag)) : "";
      lines.push([`${who} line ${line ? cellText(line) : "?"}`, flagText].filter(Boolean).join(" · "));
      cursor += 1 + width;
    }
  }
  return lines;
}

function cellText(cell: DtCell): string {
  if (cell.kind === "number" || cell.kind === "expr") return cell.raw;
  if (cell.kind === "symbol") return cell.name;
  return formatRefLabel(cell.ref);
}

function gpioCells(controller: DtNode | undefined): number {
  const raw = propertyCell(controller, "#gpio-cells");
  const value = raw ? Number(raw) : 2;
  return Number.isFinite(value) && value > 0 ? value : 2;
}

function gpioFlag(raw: string): string {
  if (!raw) return "";
  if (/active[_-]?low/i.test(raw) || raw === "1" || raw === "0x1") return "active-low";
  if (raw === "0" || raw === "0x0") return "active-high";
  return raw;
}

function supplyLines(node: DtNode, index: DtIndex): string[] {
  const lines: string[] = [];
  for (const property of node.properties) {
    if (property.deleted || !property.name.endsWith("-supply")) continue;
    const role = property.name.replace(/-supply$/, "");
    for (const ref of refsOf(property)) {
      const target = resolveRef(ref, index);
      const name = target
        ? stringValues(propertyByName(target, "regulator-name"))[0] ?? target.fullName
        : formatRefLabel(ref);
      lines.push(`${role} ← ${name}`);
    }
  }
  return lines;
}

function clockLines(node: DtNode): string[] {
  const clocks = propertyByName(node, "clocks");
  if (!clocks) return [];
  const names = stringValues(propertyByName(node, "clock-names"));
  if (names.length > 0) return [names.join(", ")];
  return [shortValue(clocks)];
}

function interruptLine(node: DtNode): string | null {
  const interrupts = propertyByName(node, "interrupts");
  if (!interrupts) return null;
  return shortValue(interrupts);
}

function regLine(node: DtNode): string | null {
  const reg = propertyByName(node, "reg");
  if (!reg) return null;
  return shortValue(reg);
}

function shortValue(property: DtProperty): string {
  const text = formatPropertyValue(property);
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

function hasPinctrlProp(node: DtNode): boolean {
  return node.properties.some((property) => !property.deleted && /^pinctrl-\d+$/.test(property.name));
}

function unresolvedRefs(node: DtNode, index: DtIndex): DtRef[] {
  const missing: DtRef[] = [];
  const seen = new Set<string>();
  for (const property of node.properties) {
    if (property.deleted) continue;
    for (const ref of refsOf(property)) {
      if (resolveRef(ref, index)) continue;
      const key = formatRefLabel(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(ref);
    }
  }
  return missing;
}

function refsOf(property: DtProperty): DtRef[] {
  const refs: DtRef[] = [];
  for (const part of property.parts) {
    if (part.kind === "phandle") refs.push(part.ref);
    if (part.kind === "cells") {
      for (const cell of part.cells) {
        if (cell.kind === "ref") refs.push(cell.ref);
      }
    }
  }
  return refs;
}

function resolveRef(ref: DtRef, index: DtIndex): DtNode | undefined {
  return ref.kind === "label" ? index.byLabel.get(ref.label) : index.byPath.get(ref.path);
}

function formatRefLabel(ref: DtRef): string {
  return ref.kind === "label" ? `&${ref.label}` : `&{${ref.path}}`;
}

function ancestorDisabled(node: DtNode, index: DtIndex): boolean {
  return disabledAncestor(node, index) !== null;
}

function disabledAncestor(node: DtNode, index: DtIndex): DtNode | null {
  let path = parentOf(node.path);
  while (path) {
    const parent = index.byPath.get(path);
    if (parent && statusOf(parent) === "disabled") return parent;
    path = parentOf(path);
  }
  return null;
}

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  if (cut <= 0) return "/";
  return path.slice(0, cut);
}

function aliasTable(root: DtNode | null, index: DtIndex): Map<string, BoardAlias> {
  const table = new Map<string, BoardAlias>();
  const aliases = root?.children.find((node) => node.name === "aliases");
  if (!aliases) return table;
  for (const property of aliases.properties) {
    if (property.deleted) continue;
    const ref = refsOf(property)[0];
    const target = ref ? resolveRef(ref, index) : undefined;
    table.set(property.name, {
      name: property.name,
      path: target?.path ?? null,
      title: target?.fullName ?? null,
      status: target ? statusOf(target) : null,
      missing: !target,
    });
  }
  return table;
}

function invertAliases(aliases: Map<string, BoardAlias>): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const alias of aliases.values()) {
    if (!alias.path) continue;
    const list = byPath.get(alias.path) ?? [];
    list.push(alias.name);
    byPath.set(alias.path, list);
  }
  return byPath;
}

function chosenString(root: DtNode | null, name: string): string | null {
  const chosen = root?.children.find((node) => node.name === "chosen");
  if (!chosen) return null;
  return stringValues(propertyByName(chosen, name))[0] ?? null;
}

function chosenModel(root: DtNode | null): string | null {
  if (!root) return null;
  return stringValues(propertyByName(root, "model"))[0] ?? null;
}

function memoryLines(root: DtNode | null): string[] {
  if (!root) return [];
  return root.children
    .filter((node) => stringValues(propertyByName(node, "device_type"))[0] === "memory")
    .map((node) => {
      const reg = propertyByName(node, "reg");
      return reg ? shortValue(reg) : node.fullName;
    });
}

function reservedLines(root: DtNode | null): string[] {
  const reserved = root?.children.find((node) => node.name === "reserved-memory");
  if (!reserved) return [];
  return reserved.children.filter((node) => !node.deleted).map((node) => {
    const size = propertyByName(node, "size");
    return size ? `${node.fullName} ${shortValue(size)}` : node.fullName;
  });
}

function isPinGroup(node: DtNode): boolean {
  return (
    stringValues(propertyByName(node, "compatible")).length === 0 &&
    Boolean(propertyByName(node, "pins") || propertyByName(node, "groups"))
  );
}

function isPinctrlController(node: DtNode): boolean {
  const compatible = stringValues(propertyByName(node, "compatible"));
  return compatible.some((item) => item.includes("pinctrl")) || node.name.startsWith("pinctrl");
}

function isGpioController(node: DtNode): boolean {
  return node.properties.some((property) => !property.deleted && property.boolean && property.name === "gpio-controller");
}

function isSerial(node: DtNode, compatible: string): boolean {
  return (
    node.name.startsWith("serial") ||
    node.name.startsWith("uart") ||
    /uart|ns16550|serial/i.test(compatible)
  );
}

function isI2cController(node: DtNode): boolean {
  if (propertyByName(node, "#address-cells") && (node.name.startsWith("i2c") || node.fullName.startsWith("i2c"))) {
    return true;
  }
  const compatible = stringValues(propertyByName(node, "compatible")).join(" ");
  return node.name.startsWith("i2c") && /i2c/i.test(compatible);
}

function isSpiController(node: DtNode): boolean {
  return node.name.startsWith("spi") && Boolean(propertyByName(node, "#address-cells"));
}

function isMmc(node: DtNode, compatible: string): boolean {
  return node.name.startsWith("mmc") || node.name.startsWith("usdhc") || /mmc|sdhci|usdhc/i.test(compatible);
}

function isEthernet(node: DtNode, compatible: string): boolean {
  if (/ethernet-phy/i.test(compatible)) return false;
  return node.name.startsWith("ethernet") || node.name === "fec" || node.name.startsWith("eth") || /ethernet|,fec/i.test(compatible);
}

function isUsb(node: DtNode, compatible: string): boolean {
  return node.name.startsWith("usb") || /\busb\b/i.test(compatible);
}

function propertyCell(node: DtNode | undefined | null, name: string): string | null {
  if (!node) return null;
  const property = propertyByName(node, name);
  if (!property) return null;
  for (const part of property.parts) {
    if (part.kind === "string") return part.value;
    if (part.kind === "cells") {
      const cell = part.cells[0];
      if (!cell || cell.kind === "ref") continue;
      if (cell.kind === "symbol") return cell.name;
      return cell.raw;
    }
  }
  return null;
}

function i2cAddress(raw: string): string {
  const text = raw.trim().toLowerCase();
  const value = text.startsWith("0x") ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  if (!Number.isFinite(value)) return raw;
  return value.toString(16).padStart(4, "0");
}
