import type { BringupBoard, BringupLink } from "./bringup";
import { propertyByName, stringValues } from "./format";
import { formatAddress, formatHz, formatSize, parseInteger, type MemoryMap } from "./memory-map";
import type { DtDocument, DtNode } from "./types";

export type BoardBrief = {
  title: string;
  board: string;
  pins: string;
  inactive: string;
  scope: string;
};

const FACING = new Set([
  "serial",
  "i2c",
  "eeprom",
  "hwmon",
  "spi",
  "mtd",
  "mmc",
  "net",
  "usb",
  "gpio",
  "LED",
  "input",
  "regulator",
]);

export function descriptionFile(brief: BoardBrief): string {
  return [brief.title, "", brief.board, "", "Pins", brief.pins, "", "Not activated", brief.inactive, "", "What you can build", brief.scope, ""].join("\n");
}

export function summarizeBoard(doc: DtDocument, board: BringupBoard, map: MemoryMap): BoardBrief {
  const title = board.model ?? "This board file";
  return {
    title,
    board: boardParagraph(doc, board, map, title),
    pins: pinsParagraph(doc, board),
    inactive: inactiveParagraph(board),
    scope: scopeParagraph(doc, board),
  };
}

function boardParagraph(doc: DtDocument, board: BringupBoard, map: MemoryMap, title: string): string {
  const compatible = board.compatible.length > 0 ? ` Compatible strings: ${board.compatible.join(", ")}.` : "";
  const sentences = [`${title}.${compatible}`, cpuSentence(doc.root), ramSentence(map), holdSentence(map), consoleSentence(board)];
  return sentences.filter(Boolean).join(" ");
}

function cpuSentence(root: DtNode | null): string {
  const cores = root?.children.find((node) => node.name === "cpus")?.children.filter((node) => !node.deleted) ?? [];
  if (cores.length === 0) return "";
  const names = [...new Set(cores.flatMap((core) => stringValues(propertyByName(core, "compatible"))))];
  const freqs = cores
    .map((core) => integerProp(core, "clock-frequency"))
    .filter((value): value is bigint => value !== null);
  const count = cores.length === 1 ? "One CPU" : `${countWord(cores.length)} CPUs`;
  const named = names.length > 0 ? ` (${names.join(", ")})` : "";
  const sameClock = freqs.length === cores.length && freqs.every((value) => value === freqs[0]);
  const clock = sameClock ? `, clocked at ${formatHz(freqs[0])}` : "";
  return `${count}${named}${clock}.`;
}

function ramSentence(map: MemoryMap): string {
  const rams = map.regions.filter((region) => region.kind === "ram" && region.start !== null && region.size !== null);
  if (rams.length === 0) return "This file has no memory node, so the RAM window is unknown.";
  return `RAM is ${joinAnd(rams.map((region) => `${formatSize(region.size!)} at ${formatAddress(region.start!)}`))}.`;
}

function holdSentence(map: MemoryMap): string {
  const fixed = map.regions.filter(
    (region) =>
      (region.kind === "memreserve" || region.kind === "reserved") && region.start !== null && region.size !== null,
  );
  const pools = map.regions.filter((region) => region.kind === "pool" && region.size !== null);
  const parts: string[] = [];
  if (fixed.length > 0) {
    const held = joinAnd(fixed.map((region) => `${formatSize(region.size!)} at ${formatAddress(region.start!)} (${region.title})`));
    parts.push(`${held} ${fixed.length === 1 ? "is" : "are"} kept out of normal allocations.`);
  }
  if (pools.length > 0) {
    const asked = joinAnd(pools.map((region) => `${region.title} asks for ${formatSize(region.size!)}`));
    const window = pools.some((region) => region.detail.includes("allocatable")) ? " inside the stated window" : "";
    parts.push(`${asked}. The kernel picks ${pools.length === 1 ? "that address" : "those addresses"}${window}.`);
  }
  return parts.join(" ");
}

function consoleSentence(board: BringupBoard): string {
  if (!board.stdout) return "No stdout-path is chosen.";
  return `The chosen console is ${board.stdout}.`;
}

function pinsParagraph(doc: DtDocument, board: BringupBoard): string {
  const enabled = board.links.filter(isOn);
  const claimed = enabled.filter((link) => link.pins.length > 0);
  const missing = enabled.filter((link) => link.notes.some((note) => note.message.startsWith("No pin group")));
  const groups = pinGroups(doc.root);
  const unused = groups.filter(
    (group) => !enabled.some((link) => link.pins.some((pin) => pin.includes(group.name))),
  );
  const parts: string[] = [];
  if (claimed.length > 0) {
    parts.push(`Pins in use: ${joinAnd(claimed.map((link) => `${link.title} uses ${link.pins.join("; ")}`))}.`);
  }
  if (unused.length > 0) {
    parts.push(
      `Described, and not claimed by an enabled node: ${joinAnd(unused.map((group) => `${group.name} (${group.pins})`))}.`,
    );
  }
  if (missing.length > 0) {
    parts.push(
      `No pin group is written for ${joinAnd(missing.map((link) => link.title))}. Those nodes are enabled, and this file never names their balls.`,
    );
  }
  if (parts.length === 0) return "This file does not name any pins or GPIO lines.";
  return parts.join(" ");
}

function inactiveParagraph(board: BringupBoard): string {
  const off = board.links.filter((link) => !link.deleted && link.status === "disabled" && FACING.has(link.kernel.subsystem));
  const removed = board.links.filter((link) => link.deleted);
  const consoleAlias = board.stdout?.split(":")[0] ?? null;
  const consoleLink = consoleAlias
    ? board.links.find((link) => link.aliases.includes(consoleAlias) && !link.deleted)
    : undefined;
  const parts: string[] = [];
  if (off.length === 0) parts.push("Nothing in this tree is marked disabled.");
  else parts.push(`Not activated: ${joinAnd(off.map(linkLabel))}.`);
  if (consoleLink && consoleLink.status === "disabled") {
    parts.push(`${consoleAlias} is the boot console, so the tty that name implies will not exist until that node is enabled.`);
  }
  if (removed.length > 0) parts.push(`Taken out of the tree: ${joinAnd(removed.map((link) => link.title))}.`);
  return parts.join(" ");
}

function scopeParagraph(doc: DtDocument, board: BringupBoard): string {
  const enabled = board.links.filter((link) => isOn(link) && FACING.has(link.kernel.subsystem));
  const take = (subsystem: string) => enabled.filter((link) => link.kernel.subsystem === subsystem);
  const phrases: string[] = [];

  const serial = take("serial");
  if (serial.length > 0) phrases.push(`open a serial port at ${joinAnd(serial.map((link) => link.userspace))}`);

  const eeproms = take("eeprom");
  if (eeproms.length > 0) {
    phrases.push(`store a board id or calibration in ${joinAnd(eeproms.map((link) => link.userspace))}`);
  }

  const sensors = take("hwmon");
  if (sensors.length > 0) phrases.push(`read a sensor from ${joinAnd(sensors.map((link) => link.userspace))}`);

  const i2c = take("i2c");
  if (i2c.length > 0 && eeproms.length + sensors.length === 0) {
    phrases.push(`talk to I2C chips on ${joinAnd(i2c.map((link) => link.userspace))}`);
  }

  const flash = take("mtd");
  if (flash.length > 0) phrases.push(`keep a boot image or a small filesystem in ${joinAnd(flash.map((link) => link.title))}`);

  const spi = take("spi");
  if (spi.length > 0 && flash.length === 0) phrases.push(`drive SPI from ${joinAnd(spi.map((link) => link.title))}`);

  const mmc = take("mmc");
  if (mmc.length > 0) phrases.push(`root a system from ${joinAnd(mmc.map((link) => link.title))}`);

  const net = take("net");
  if (net.length > 0) phrases.push(`put the board on the network through ${joinAnd(net.map((link) => link.title))}`);

  const usb = take("usb");
  if (usb.length > 0) phrases.push(`use USB on ${joinAnd(usb.map((link) => link.title))}`);

  const leds = take("LED");
  if (leds.length > 0) {
    phrases.push(`blink ${joinAnd(leds.map((link) => link.userspace.replace("/sys/class/leds/", "")))}`);
  }

  const keys = take("input");
  if (keys.length > 0) phrases.push(`take a button press from ${joinAnd(keys.map((link) => link.title))}`);

  const gpio = take("gpio");
  if (gpio.length > 0) phrases.push(`drive other lines on ${joinAnd(gpio.map((link) => link.label ?? link.title))} with libgpiod`);

  const off = board.links.filter((link) => !link.deleted && link.status === "disabled" && FACING.has(link.kernel.subsystem));
  const offSentence =
    off.length > 0
      ? ` ${joinAnd(off.map((link) => link.title))} ${off.length === 1 ? "is" : "are"} still off, so a project that needs ${off.length === 1 ? "that block" : "those blocks"} starts by enabling the node and naming its pins.`
      : "";
  const skipped = doc.warnings.some((warning) => warning.message.startsWith("Skipped #"));
  const includeSentence = skipped
    ? " Includes in this file were not expanded, so anything that lives only in a header or a dtsi is missing from this picture."
    : "";
  const limit =
    " This is the scope of the description in front of you. It is not a schematic, a kernel defconfig, or a root filesystem.";

  if (phrases.length === 0) {
    return `Nothing here is enabled in a way userspace can open.${offSentence}${includeSentence}${limit}`;
  }
  return `With what is switched on, you can ${joinAnd(phrases)}.${offSentence}${includeSentence}${limit}`;
}

function isOn(link: BringupLink): boolean {
  return !link.deleted && link.status !== "disabled";
}

function linkLabel(link: BringupLink): string {
  return link.aliases.length > 0 ? `${link.title} (${link.aliases.join(", ")})` : link.title;
}

function pinGroups(root: DtNode | null): { name: string; pins: string }[] {
  const groups: { name: string; pins: string }[] = [];
  const visit = (node: DtNode) => {
    if (node.deleted) return;
    const pins = stringValues(propertyByName(node, "pins"));
    if (pins.length > 0 && stringValues(propertyByName(node, "compatible")).length === 0) {
      groups.push({ name: node.labels[0] ?? node.fullName, pins: pins.join(", ") });
    }
    for (const child of node.children) visit(child);
  };
  if (root) visit(root);
  return groups;
}

function integerProp(node: DtNode, name: string): bigint | null {
  const property = propertyByName(node, name);
  if (!property) return null;
  for (const part of property.parts) {
    if (part.kind !== "cells") continue;
    for (const cell of part.cells) {
      if (cell.kind !== "number") continue;
      const value = parseInteger(cell.raw);
      if (value !== null) return value;
    }
  }
  return null;
}

function countWord(count: number): string {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
  return words[count] ?? String(count);
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
