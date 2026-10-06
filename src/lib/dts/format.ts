import type { DtCell, DtNode, DtProperty, DtRef, DtValuePart } from "./types";

export function formatRef(ref: DtRef): string {
  return ref.kind === "label" ? `&${ref.label}` : `&{${ref.path}}`;
}

export function formatCell(cell: DtCell): string {
  switch (cell.kind) {
    case "number":
      return cell.raw;
    case "symbol":
      return cell.name;
    case "expr":
      return cell.raw;
    case "ref":
      return formatRef(cell.ref);
  }
}

export function formatPart(part: DtValuePart): string {
  switch (part.kind) {
    case "string":
      return JSON.stringify(part.value);
    case "cells": {
      const bits = part.bits && part.bits !== 32 ? `/bits/ ${part.bits} ` : "";
      return `${bits}<${part.cells.map(formatCell).join(" ")}>`;
    }
    case "bytes": {
      const bits = part.bits && part.bits !== 32 ? `/bits/ ${part.bits} ` : "";
      const hex = part.bytes
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(" ");
      return `${bits}[${hex}]`;
    }
    case "phandle":
      return formatRef(part.ref);
    case "incbin":
      if (part.offset !== undefined) {
        return `/incbin/("${part.file}", ${part.offset}${part.size !== undefined ? `, ${part.size}` : ""})`;
      }
      return `/incbin/("${part.file}")`;
  }
}

export function formatPropertyValue(prop: DtProperty): string {
  if (prop.boolean) return "";
  if (prop.parts.length === 0) return "(empty)";
  return prop.parts.map(formatPart).join(", ");
}

export function propertyByName(
  node: DtNode,
  name: string,
): DtProperty | undefined {
  return node.properties.find((property) => property.name === name && !property.deleted);
}

export function stringValues(prop: DtProperty | undefined): string[] {
  if (!prop || prop.deleted) return [];
  return prop.parts.flatMap((part) => (part.kind === "string" ? [part.value] : []));
}

export function statusOf(node: DtNode): string | null {
  const values = stringValues(propertyByName(node, "status"));
  return values[0] ?? null;
}

export function compatibleOf(node: DtNode): string[] {
  return stringValues(propertyByName(node, "compatible"));
}

export function toJson(node: DtNode): unknown {
  const properties: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (prop.deleted) continue;
    if (prop.boolean) {
      properties[prop.name] = true;
      continue;
    }
    const strings = prop.parts.filter((part) => part.kind === "string");
    if (strings.length === prop.parts.length && strings.length === 1 && strings[0].kind === "string") {
      properties[prop.name] = strings[0].value;
    } else if (strings.length === prop.parts.length && strings.length > 1) {
      properties[prop.name] = strings.flatMap((part) =>
        part.kind === "string" ? [part.value] : [],
      );
    } else {
      properties[prop.name] = formatPropertyValue(prop);
    }
  }

  return {
    name: node.fullName,
    path: node.path,
    ...(node.labels.length ? { labels: node.labels } : {}),
    ...(node.fromOverlay ? { fromOverlay: true } : {}),
    properties,
    children: node.children.filter((child) => !child.deleted).map(toJson),
  };
}
