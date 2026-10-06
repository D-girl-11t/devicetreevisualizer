import { compatibleOf, formatPropertyValue, statusOf } from "./format";
import type { DtDocument, DtNode, DtRef } from "./types";

export type RefSite = {
  from: DtNode;
  property: string;
};

export type DtIndex = {
  nodes: DtNode[];
  byPath: Map<string, DtNode>;
  byLabel: Map<string, DtNode>;
  incoming: Map<string, RefSite[]>;
  stats: {
    nodes: number;
    deleted: number;
    disabled: number;
    labels: number;
    overlayNodes: number;
    unresolved: number;
  };
};

export function indexDocument(doc: DtDocument): DtIndex {
  const nodes: DtNode[] = [];
  const byPath = new Map<string, DtNode>();
  const byLabel = new Map<string, DtNode>();
  const incoming = new Map<string, RefSite[]>();
  const stats = {
    nodes: 0,
    deleted: 0,
    disabled: 0,
    labels: 0,
    overlayNodes: 0,
    unresolved: doc.unresolved.length,
  };

  const visit = (node: DtNode, ancestorDeleted: boolean) => {
    nodes.push(node);
    if (node.path) byPath.set(node.path, node);
    for (const label of node.labels) byLabel.set(label, node);
    const gone = ancestorDeleted || node.deleted;
    if (gone) stats.deleted += 1;
    else {
      stats.nodes += 1;
      if (statusOf(node) === "disabled") stats.disabled += 1;
      if (node.fromOverlay) stats.overlayNodes += 1;
    }
    stats.labels += node.labels.length;
    if (!node.deleted) {
      for (const property of node.properties) {
        if (property.deleted) continue;
        for (const ref of refsInProperty(property.parts)) {
          const key = ref.kind === "label" ? ref.label : ref.path;
          const list = incoming.get(key) ?? [];
          list.push({ from: node, property: property.name });
          incoming.set(key, list);
        }
      }
    }
    for (const child of node.children) visit(child, gone);
  };

  if (doc.root) visit(doc.root, false);
  for (const fragment of doc.unresolved) visit(fragment, false);
  return { nodes, byPath, byLabel, incoming, stats };
}

function refsInProperty(parts: DtNode["properties"][number]["parts"]): DtRef[] {
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

export type NodeFilter = "all" | "enabled" | "disabled" | "compatible";

export function nodeMatches(node: DtNode, query: string, filter: NodeFilter): boolean {
  if (filter === "disabled" && statusOf(node) !== "disabled") return false;
  if (filter === "enabled" && statusOf(node) === "disabled") return false;
  if (filter === "compatible" && compatibleOf(node).length === 0) return false;
  if (!query) return true;
  const haystack = [
    node.fullName,
    node.path,
    ...node.labels,
    ...node.properties.flatMap((property) => [
      property.name,
      formatPropertyValue(property),
    ]),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

export function defaultExpanded(root: DtNode | null): Set<string> {
  const open = new Set<string>();
  const walk = (node: DtNode, depth: number) => {
    if (depth < 2) open.add(node.path);
    for (const child of node.children) walk(child, depth + 1);
  };
  if (root) walk(root, 0);
  return open;
}
