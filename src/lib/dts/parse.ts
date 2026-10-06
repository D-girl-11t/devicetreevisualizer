import { formatRef } from "./format";
import type {
  DtCell,
  DtDocument,
  DtIssue,
  DtMemreserve,
  DtNode,
  DtProperty,
  DtRef,
  DtValuePart,
} from "./types";

const MAX_SOURCE_CHARS = 2_000_000;

const PREPROCESSOR = new Set([
  "include",
  "define",
  "undef",
  "if",
  "ifdef",
  "ifndef",
  "elif",
  "else",
  "endif",
  "pragma",
  "error",
  "warning",
  "line",
]);

class ParseError extends Error {
  line: number;
  column: number;

  constructor(line: number, column: number, message: string) {
    super(message);
    this.name = "ParseError";
    this.line = line;
    this.column = column;
  }
}

type TopOp =
  | { kind: "fragment"; node: DtNode }
  | { kind: "delete-label"; label: string; line: number; column: number }
  | { kind: "delete-path"; path: string; line: number; column: number }
  | { kind: "delete-name"; name: string; line: number; column: number };

function isNameChar(char: string): boolean {
  return char.length === 1 && /[A-Za-z0-9,._+?#-]/.test(char);
}

function isIdentStart(char: string): boolean {
  return char.length === 1 && /[A-Za-z_]/.test(char);
}

function isIdentChar(char: string): boolean {
  return char.length === 1 && /[A-Za-z0-9_]/.test(char);
}

function isDigit(char: string): boolean {
  return char.length === 1 && char >= "0" && char <= "9";
}

export function findByPath(root: DtNode, path: string): DtNode | null {
  if (path === "/" || path === "") return root;
  const parts = path.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    const next = current.children.find((child) => !child.ref && child.fullName === part);
    if (!next) return null;
    current = next;
  }
  return current;
}

function assignPaths(node: DtNode, parentPath: string | null) {
  if (node.ref) {
    node.path = formatRef(node.ref);
  } else if (node.fullName === "/") {
    node.path = "/";
  } else if (!parentPath || parentPath === "/") {
    node.path = `/${node.fullName}`;
  } else {
    node.path = `${parentPath}/${node.fullName}`;
  }
  for (const child of node.children) assignPaths(child, node.path);
}

class Parser {
  private readonly src: string;
  private i = 0;
  private line = 1;
  private column = 1;
  private seq = 1;

  private plugin = false;
  private hasVersion = false;
  private memreserves: DtMemreserve[] = [];
  private root: DtNode | null = null;
  private strays: DtNode[] = [];
  private ops: TopOp[] = [];
  private unresolved: DtNode[] = [];
  private errors: DtIssue[] = [];
  private warnings: DtIssue[] = [];
  private labelMap = new Map<string, DtNode>();

  constructor(src: string) {
    this.src = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  }

  parseDocument(): DtDocument {
    if (this.src.length > MAX_SOURCE_CHARS) {
      return this.emptyDocument([
        {
          line: 1,
          column: 1,
          message: "Source is larger than 2 MB. Split the tree or paste a smaller excerpt.",
        },
      ]);
    }

    try {
      this.parseTop();
      this.finalize();
    } catch (error) {
      this.errors.push(this.asIssue(error));
    }

    if (!this.src.trim() && this.errors.length === 0) {
      this.errors.push({ line: 1, column: 1, message: "Device tree is empty." });
    } else if (!this.root && this.unresolved.length === 0 && this.errors.length === 0) {
      this.errors.push({ line: 1, column: 1, message: "No root node '/' found." });
    } else if (!this.root && this.unresolved.length > 0) {
      this.warnings.push({
        line: this.unresolved[0]?.line ?? 1,
        column: 1,
        message: "No root node. Unresolved overlay fragments are listed on their own.",
      });
    }

    return {
      plugin: this.plugin,
      hasVersion: this.hasVersion,
      memreserves: this.memreserves,
      root: this.root,
      unresolved: this.unresolved,
      errors: this.errors,
      warnings: this.warnings,
      decompiled: false,
    };
  }

  private emptyDocument(errors: DtIssue[]): DtDocument {
    return {
      plugin: false,
      hasVersion: false,
      memreserves: [],
      root: null,
      unresolved: [],
      errors,
      warnings: [],
      decompiled: false,
    };
  }

  private parseTop() {
    while (!this.eof()) {
      this.skipWs();
      if (this.eof()) break;
      if (this.tryPreprocessor()) continue;

      try {
        const directive = this.trySlashDirective();
        if (directive) {
          this.parseTopDirective(directive);
          continue;
        }
        const node = this.parseNode();
        if (node.ref) this.ops.push({ kind: "fragment", node });
        else if (node.fullName === "/") this.absorbRoot(node);
        else this.strays.push(node);
      } catch (error) {
        this.errors.push(this.asIssue(error));
        this.recover();
      }
    }
  }

  private parseTopDirective(directive: string) {
    const at = this.mark();
    switch (directive) {
      case "dts-v1":
        this.hasVersion = true;
        this.expectChar(";");
        return;
      case "plugin":
        this.plugin = true;
        this.expectChar(";");
        return;
      case "memreserve": {
        const address = this.readNumber();
        const size = this.readNumber();
        this.expectChar(";");
        this.memreserves.push({ address, size, line: at.line });
        return;
      }
      case "include":
        this.parseInclude(at);
        return;
      case "delete-node":
        this.parseTopDelete(at);
        return;
      case "delete-property":
        throw this.fail("/delete-property/ must appear inside a node.");
      case "omit-if-no-ref": {
        const node = this.parseNode();
        node.omitIfNoRef = true;
        if (node.ref) this.ops.push({ kind: "fragment", node });
        else if (node.fullName === "/") this.absorbRoot(node);
        else this.strays.push(node);
        return;
      }
      default:
        throw this.fail(`Unknown directive /${directive}/.`);
    }
  }

  private parseTopDelete(at: { line: number; column: number }) {
    this.skipWs();
    if (this.peek() === "&") {
      const ref = this.readRef();
      this.expectChar(";");
      if (ref.kind === "label") {
        this.ops.push({ kind: "delete-label", label: ref.label, line: at.line, column: at.column });
      } else {
        this.ops.push({ kind: "delete-path", path: ref.path, line: at.line, column: at.column });
      }
      return;
    }
    const named = this.readName();
    this.expectChar(";");
    this.ops.push({
      kind: "delete-name",
      name: named.unit ? `${named.name}@${named.unit}` : named.name,
      line: at.line,
      column: at.column,
    });
  }

  private absorbRoot(node: DtNode) {
    if (!this.root) this.root = node;
    else this.unionInto(this.root, node);
  }

  private parseNode(): DtNode {
    const labels: string[] = [];
    let omit = false;
    this.skipWs();

    while (true) {
      const label = this.tryReadLabel();
      if (!label) break;
      labels.push(label);
      this.skipWs();
      const directive = this.trySlashDirective();
      if (directive === "omit-if-no-ref") {
        omit = true;
        this.skipWs();
        continue;
      }
      if (directive) throw this.fail(`Unexpected /${directive}/ after a label.`);
    }

    this.skipWs();
    const directive = this.trySlashDirective();
    if (directive === "omit-if-no-ref") {
      omit = true;
      this.skipWs();
    } else if (directive) {
      throw this.fail(`Unexpected /${directive}/ where a node name was expected.`);
    }

    const at = this.mark();
    this.skipWs();

    if (this.peek() === "&") {
      const ref = this.readRef();
      const node = this.makeNode(formatRef(ref), undefined, at.line, at.column);
      node.ref = ref;
      node.labels = labels;
      node.omitIfNoRef = omit;
      this.openBody(node);
      return node;
    }

    if (this.peek() === "/") {
      this.advance();
      const node = this.makeNode("/", undefined, at.line, at.column);
      node.labels = labels;
      node.omitIfNoRef = omit;
      this.openBody(node);
      return node;
    }

    if (!isNameChar(this.peek())) {
      throw this.fail(`Expected a node name, found '${this.preview()}'.`);
    }

    const named = this.readName();
    const node = this.makeNode(named.name, named.unit, at.line, at.column);
    node.labels = labels;
    node.omitIfNoRef = omit;
    this.openBody(node);
    return node;
  }

  private openBody(node: DtNode) {
    this.skipWs();
    if (this.peek() !== "{") throw this.fail(`Expected '{' to open '${node.fullName}'.`);
    this.advance();
    this.parseBody(node);
  }

  private parseBody(node: DtNode) {
    while (!this.eof()) {
      this.skipWs();
      if (this.peek() === "}") {
        node.endLine = this.line;
        this.advance();
        break;
      }
      if (this.eof()) break;
      try {
        this.parseBodyItem(node);
      } catch (error) {
        this.errors.push(this.asIssue(error));
        this.recover();
      }
    }

    this.skipWs();
    if (this.peek() === ";") this.advance();
    else this.errors.push({ ...this.mark(), message: `Expected ';' after '${node.fullName}'.` });
  }

  private parseBodyItem(node: DtNode) {
    if (this.tryPreprocessor()) return;

    const at = this.mark();
    const directive = this.trySlashDirective();
    if (directive === "delete-node") {
      this.parseInnerDelete(node, at);
      return;
    }
    if (directive === "delete-property") {
      this.parseDeleteProperty(node);
      return;
    }
    if (directive === "include") {
      this.parseInclude(at);
      return;
    }
    if (directive === "omit-if-no-ref") {
      const child = this.parseNode();
      child.omitIfNoRef = true;
      this.attachChild(node, child);
      return;
    }
    if (directive) throw this.fail(`Unexpected /${directive}/ inside '${node.fullName}'.`);

    const labels: string[] = [];
    while (true) {
      const label = this.tryReadLabel();
      if (!label) break;
      labels.push(label);
      this.skipWs();
    }

    this.skipWs();
    const afterLabel = this.trySlashDirective();
    if (afterLabel === "omit-if-no-ref") {
      const child = this.parseNode();
      child.labels = [...labels, ...child.labels];
      child.omitIfNoRef = true;
      this.attachChild(node, child);
      return;
    }
    if (afterLabel) throw this.fail(`Unexpected /${afterLabel}/ after a label.`);

    if (this.peek() === "&") {
      const ref = this.readRef();
      const child = this.makeNode(formatRef(ref), undefined, this.line, this.column);
      child.ref = ref;
      child.labels = labels;
      this.openBody(child);
      this.attachChild(node, child);
      return;
    }

    if (!isNameChar(this.peek())) {
      throw this.fail(`Expected a property or node name, found '${this.preview()}'.`);
    }

    const named = this.readName();
    this.skipWs();
    if (named.unit !== undefined || this.peek() === "{") {
      const child = this.makeNode(named.name, named.unit, at.line, at.column);
      child.labels = labels;
      this.openBody(child);
      this.attachChild(node, child);
      return;
    }

    if (labels.length > 0) {
      throw this.fail("Labels can only be attached to nodes, not properties.");
    }
    node.properties = upsertProperty(node.properties, this.parsePropertyRest(named.name, at));
  }

  private parsePropertyRest(
    name: string,
    at: { line: number; column: number },
  ): DtProperty {
    this.skipWs();
    if (this.peek() === ";") {
      this.advance();
      return {
        name,
        parts: [],
        boolean: true,
        deleted: false,
        fromOverlay: false,
        line: at.line,
        column: at.column,
      };
    }
    if (this.peek() !== "=") {
      throw this.fail(`Expected '=' or ';' after property '${name}'.`);
    }
    this.advance();
    const parts = this.parseValue();
    return {
      name,
      parts,
      boolean: false,
      deleted: false,
      fromOverlay: false,
      line: at.line,
      column: at.column,
    };
  }

  private parseValue(): DtValuePart[] {
    const parts: DtValuePart[] = [];
    let pending: string | null = null;
    const flush = () => {
      if (pending !== null) {
        parts.push({ kind: "string", value: pending });
        pending = null;
      }
    };

    while (!this.eof()) {
      this.skipWs();
      const char = this.peek();
      if (char === ";") {
        this.advance();
        flush();
        return parts;
      }
      if (char === ",") {
        this.advance();
        flush();
        continue;
      }
      if (char === '"') {
        const text = this.readString();
        pending = pending === null ? text : pending + text;
        continue;
      }
      flush();
      if (char === "<") {
        parts.push({ kind: "cells", cells: this.readCells() });
        continue;
      }
      if (char === "[") {
        parts.push({ kind: "bytes", bytes: this.readBytes() });
        continue;
      }
      if (char === "&") {
        parts.push({ kind: "phandle", ref: this.readRef() });
        continue;
      }
      const directive = this.trySlashDirective();
      if (directive === "bits") {
        const bits = Number(this.readNumber().replace(/[uUlL]+$/, ""));
        this.skipWs();
        if (this.peek() === "<") parts.push({ kind: "cells", bits, cells: this.readCells() });
        else if (this.peek() === "[") parts.push({ kind: "bytes", bits, bytes: this.readBytes() });
        else throw this.fail("Expected '<' or '[' after /bits/.");
        continue;
      }
      if (directive === "incbin") {
        parts.push(this.parseIncbin());
        continue;
      }
      if (directive) throw this.fail(`/${directive}/ is not valid in a property value.`);
      throw this.fail(`Unexpected '${this.preview()}' in a property value.`);
    }
    throw this.fail("Unterminated property value.");
  }

  private parseIncbin(): DtValuePart {
    this.skipWs();
    this.expectChar("(");
    this.skipWs();
    const file = this.readString();
    let offset: string | undefined;
    let size: string | undefined;
    this.skipWs();
    if (this.peek() === ",") {
      this.advance();
      offset = this.readNumber();
      this.skipWs();
      if (this.peek() === ",") {
        this.advance();
        size = this.readNumber();
      }
    }
    this.skipWs();
    this.expectChar(")");
    return { kind: "incbin", file, offset, size };
  }

  private readCells(): DtCell[] {
    this.expectChar("<");
    const cells: DtCell[] = [];
    while (!this.eof()) {
      this.skipWs();
      const char = this.peek();
      if (char === ">") {
        this.advance();
        return cells;
      }
      if (char === "(") {
        cells.push({ kind: "expr", raw: this.readParen() });
        continue;
      }
      if (char === "&") {
        cells.push({ kind: "ref", ref: this.readRef() });
        continue;
      }
      if (char === "+" || char === "-") {
        const checkpoint = this.checkpoint();
        const sign = char;
        this.advance();
        if (isDigit(this.peek())) {
          cells.push({ kind: "number", raw: sign + this.readNumber() });
          continue;
        }
        this.restore(checkpoint);
      }
      if (isDigit(char)) {
        cells.push({ kind: "number", raw: this.readNumber() });
        continue;
      }
      if (isIdentStart(char)) {
        cells.push({ kind: "symbol", name: this.readIdent() });
        continue;
      }
      throw this.fail(`Unexpected '${this.preview()}' in a cell list.`);
    }
    throw this.fail("Unterminated cell list.");
  }

  private readBytes(): number[] {
    this.expectChar("[");
    const bytes: number[] = [];
    while (!this.eof()) {
      this.skipWs();
      if (this.peek() === "]") {
        this.advance();
        return bytes;
      }
      if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
        this.advance();
        this.advance();
      }
      let hex = "";
      while (hex.length < 2 && /[0-9a-fA-F]/.test(this.peek())) {
        hex += this.peek();
        this.advance();
      }
      if (!hex) throw this.fail("Expected a hex byte.");
      bytes.push(Number.parseInt(hex, 16));
    }
    throw this.fail("Unterminated byte array.");
  }

  private readParen(): string {
    const start = this.i;
    const startLine = this.line;
    let depth = 0;
    while (!this.eof()) {
      const char = this.peek();
      if (char === '"') {
        this.readString();
        continue;
      }
      if (char === "/" && (this.peek(1) === "/" || this.peek(1) === "*")) {
        this.skipWs();
        continue;
      }
      this.advance();
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) return this.src.slice(start, this.i);
      }
    }
    throw this.fail(`Unterminated expression starting at line ${startLine}.`);
  }

  private parseInnerDelete(node: DtNode, at: { line: number; column: number }) {
    this.skipWs();
    if (this.peek() === "&") {
      const ref = this.readRef();
      this.expectChar(";");
      if (ref.kind === "label") node.deletedLabels.push(ref.label);
      else node.deletedPaths.push(ref.path);
      return;
    }
    const named = this.readName();
    const fullName = named.unit ? `${named.name}@${named.unit}` : named.name;
    this.expectChar(";");
    const existing = node.children.find((child) => !child.ref && child.fullName === fullName);
    if (existing) existing.deleted = true;
    else if (!node.deletedChildren.includes(fullName)) node.deletedChildren.push(fullName);
    void at;
  }

  private parseDeleteProperty(node: DtNode) {
    const at = this.mark();
    const named = this.readName();
    if (named.unit) throw this.fail("Property names cannot include a unit address.");
    this.expectChar(";");
    const existing = node.properties.find((property) => property.name === named.name);
    if (existing) {
      existing.deleted = true;
      existing.line = at.line;
      existing.column = at.column;
      return;
    }
    node.properties.push({
      name: named.name,
      parts: [],
      boolean: false,
      deleted: true,
      fromOverlay: false,
      line: at.line,
      column: at.column,
    });
  }

  private parseInclude(at: { line: number; column: number }) {
    this.skipWs();
    if (this.peek() !== '"') throw this.fail("Expected a filename string after /include/.");
    const file = this.readString();
    this.skipWs();
    if (this.peek() === ";") this.advance();
    this.warnings.push({
      line: at.line,
      column: at.column,
      message: `Skipped /include/ "${file}". Paste one file, or run the source through the preprocessor first.`,
    });
  }

  private attachChild(parent: DtNode, child: DtNode) {
    if (child.ref) {
      parent.children.push(child);
      return;
    }
    const existing = parent.children.find((item) => !item.ref && item.fullName === child.fullName);
    if (!existing) {
      if (parent.deletedChildren.includes(child.fullName)) child.deleted = true;
      parent.children.push(child);
      return;
    }
    this.unionInto(existing, child);
  }

  private unionInto(target: DtNode, source: DtNode) {
    for (const label of source.labels) {
      if (!target.labels.includes(label)) target.labels.push(label);
    }
    if (source.omitIfNoRef) target.omitIfNoRef = true;
    if (source.deleted) target.deleted = true;
    for (const property of source.properties) {
      target.properties = upsertProperty(target.properties, property);
    }
    for (const name of source.deletedChildren) {
      const child = target.children.find((item) => item.fullName === name);
      if (child) child.deleted = true;
      else if (!target.deletedChildren.includes(name)) target.deletedChildren.push(name);
    }
    target.deletedLabels.push(...source.deletedLabels);
    target.deletedPaths.push(...source.deletedPaths);
    for (const child of source.children) this.attachChild(target, child);
  }

  private finalize() {
    if (!this.root && this.strays.length > 0) {
      this.root = this.makeNode("/", undefined, this.strays[0].line, this.strays[0].column);
    }
    if (this.root) {
      for (const stray of this.strays) {
        this.warnings.push({
          line: stray.line,
          column: stray.column,
          message: `Lifted top-level node '${stray.fullName}' into the root.`,
        });
        this.attachChild(this.root, stray);
      }
      assignPaths(this.root, null);
      this.indexAll(this.root);
      this.applyStoredDeletes(this.root);
    } else if (this.strays.length === 0) {
      /* overlays may still be unresolved */
    }

    for (const op of this.ops) {
      if (!this.root && op.kind !== "fragment") {
        this.warnings.push({
          line: op.line,
          column: op.column,
          message: "Ignored a delete directive because there is no root node.",
        });
        continue;
      }
      if (op.kind === "fragment") {
        const target = op.node.ref ? this.resolveRef(op.node.ref) : null;
        if (!target || !this.root) {
          assignPaths(op.node, null);
          this.unresolved.push(op.node);
          this.warnings.push({
            line: op.node.line,
            column: op.node.column,
            message: `No node matches ${formatRef(op.node.ref!)}.`,
          });
          continue;
        }
        this.mergeStructure(target, op.node, true);
        continue;
      }
      if (!this.root) continue;
      if (op.kind === "delete-label") this.deleteLabel(op.label, op.line, op.column);
      else if (op.kind === "delete-path") this.deletePath(op.path, op.line, op.column);
      else this.deleteRootChild(op.name, op.line, op.column);
    }

    this.applyOmitIfNoRef();
  }

  private applyStoredDeletes(node: DtNode) {
    for (const label of node.deletedLabels) this.deleteLabel(label, node.line, node.column);
    for (const path of node.deletedPaths) this.deletePath(path, node.line, node.column);
    for (const child of node.children) this.applyStoredDeletes(child);
  }

  private deleteLabel(label: string, line: number, column: number) {
    const node = this.labelMap.get(label);
    if (!node) {
      this.warnings.push({
        line,
        column,
        message: `Cannot delete unknown label &${label}.`,
      });
      return;
    }
    node.deleted = true;
  }

  private deletePath(path: string, line: number, column: number) {
    if (!this.root) return;
    const node = findByPath(this.root, path);
    if (!node) {
      this.warnings.push({
        line,
        column,
        message: `Cannot delete unknown path ${path}.`,
      });
      return;
    }
    node.deleted = true;
  }

  private deleteRootChild(name: string, line: number, column: number) {
    if (!this.root) return;
    const child = this.root.children.find((item) => item.fullName === name);
    if (!child) {
      this.warnings.push({
        line,
        column,
        message: `Cannot delete unknown root child '${name}'.`,
      });
      return;
    }
    child.deleted = true;
  }

  private mergeStructure(target: DtNode, source: DtNode, overlay: boolean) {
    if (overlay) target.modifiedByOverlay = true;

    for (const name of source.deletedChildren) {
      const child = target.children.find((item) => !item.ref && item.fullName === name);
      if (child) {
        child.deleted = true;
        if (overlay) child.modifiedByOverlay = true;
      } else {
        this.warnings.push({
          line: source.line,
          column: source.column,
          message: `Nothing named '${name}' to delete under ${target.path || target.fullName}.`,
        });
      }
    }
    for (const label of source.deletedLabels) this.deleteLabel(label, source.line, source.column);
    for (const path of source.deletedPaths) this.deletePath(path, source.line, source.column);

    for (const property of source.properties) {
      target.properties = upsertProperty(target.properties, {
        ...property,
        fromOverlay: overlay || property.fromOverlay,
      });
    }

    for (const child of source.children) {
      if (child.deleted && !child.ref) {
        const existing = target.children.find((item) => item.fullName === child.fullName);
        if (existing) {
          existing.deleted = true;
          if (overlay) existing.modifiedByOverlay = true;
        }
        continue;
      }
      if (child.ref) {
        const dest = this.resolveRef(child.ref);
        if (!dest) {
          assignPaths(child, null);
          this.unresolved.push(child);
          this.warnings.push({
            line: child.line,
            column: child.column,
            message: `No node matches ${formatRef(child.ref)}.`,
          });
        } else {
          this.mergeStructure(dest, child, true);
        }
        continue;
      }
      const existing = target.children.find((item) => !item.ref && item.fullName === child.fullName);
      if (existing) {
        for (const label of child.labels) {
          if (!existing.labels.includes(label)) existing.labels.push(label);
        }
        this.mergeStructure(existing, child, overlay);
        this.indexAll(existing);
      } else this.adopt(target, child, overlay);
    }
  }

  private adopt(parent: DtNode, child: DtNode, overlay: boolean) {
    const copy = cloneTree(child, () => this.freshId());
    if (overlay) stampOverlay(copy);
    assignPaths(copy, parent.path);
    if (parent.deletedChildren.includes(copy.fullName)) copy.deleted = true;
    parent.children.push(copy);
    this.indexAll(copy);
  }

  private resolveRef(ref: DtRef): DtNode | null {
    if (!this.root) return null;
    if (ref.kind === "label") return this.labelMap.get(ref.label) ?? null;
    return findByPath(this.root, ref.path);
  }

  private indexAll(node: DtNode) {
    for (const label of node.labels) {
      const previous = this.labelMap.get(label);
      if (previous && previous !== node) {
        this.warnings.push({
          line: node.line,
          column: node.column,
          message: `Label '${label}' is already used by ${previous.path || previous.fullName}. Later references use ${node.path || node.fullName}.`,
        });
      }
      this.labelMap.set(label, node);
    }
    for (const child of node.children) this.indexAll(child);
  }

  private applyOmitIfNoRef() {
    const candidates: DtNode[] = [];
    const visit = (node: DtNode) => {
      if (node.omitIfNoRef) candidates.push(node);
      for (const child of node.children) visit(child);
    };
    if (this.root) visit(this.root);
    for (const fragment of this.unresolved) visit(fragment);
    if (candidates.length === 0) return;

    const omitted = new Set(candidates);
    let changed = true;
    while (changed) {
      changed = false;
      const referenced = new Set<string>();
      const collect = (node: DtNode) => {
        if (omitted.has(node) || node.deleted) return;
        collectLabelRefs(node, referenced);
        for (const child of node.children) collect(child);
      };
      if (this.root) collect(this.root);
      for (const fragment of this.unresolved) collect(fragment);
      for (const node of omitted) {
        if (node.labels.some((label) => referenced.has(label))) {
          omitted.delete(node);
          changed = true;
        }
      }
    }
    for (const node of omitted) {
      node.omitted = true;
      node.deleted = true;
    }
  }

  private freshId(): string {
    this.seq += 1;
    return `n${this.seq}`;
  }

  private makeNode(name: string, unit: string | undefined, line: number, column: number): DtNode {
    const fullName = name === "/" ? "/" : unit ? `${name}@${unit}` : name;
    this.seq += 1;
    return {
      id: `n${this.seq}`,
      name,
      unitAddress: unit,
      fullName,
      labels: [],
      path: "",
      properties: [],
      children: [],
      line,
      endLine: line,
      column,
      omitIfNoRef: false,
      deleted: false,
      omitted: false,
      fromOverlay: false,
      modifiedByOverlay: false,
      deletedChildren: [],
      deletedLabels: [],
      deletedPaths: [],
    };
  }

  private tryPreprocessor(): boolean {
    if (this.peek() !== "#") return false;
    const checkpoint = this.checkpoint();
    const at = this.mark();
    this.advance();
    let word = "";
    while (/[A-Za-z]/.test(this.peek())) {
      word += this.peek();
      this.advance();
    }
    if (!PREPROCESSOR.has(word)) {
      this.restore(checkpoint);
      return false;
    }
    this.skipPreprocessorTail();
    const notable = word === "include" || word === "define" || word === "if" || word === "ifdef" || word === "ifndef";
    if (notable) {
      this.warnings.push({
        line: at.line,
        column: at.column,
        message:
          word === "include"
            ? "Skipped #include. Includes are not expanded; paste the preprocessed source."
            : word === "define"
              ? "Skipped #define. Macros are left as symbols in cell values."
              : `Skipped #${word}. Conditional branches are not evaluated, so both sides may appear.`,
      });
    }
    return true;
  }

  private skipPreprocessorTail() {
    while (!this.eof()) {
      const char = this.peek();
      if (char === "\n") {
        this.advance();
        return;
      }
      if (char === "\\" && (this.peek(1) === "\n" || this.peek(1) === "\r")) {
        this.advance();
        if (this.peek() === "\r") this.advance();
        if (this.peek() === "\n") this.advance();
        continue;
      }
      if (char === '"') {
        try {
          this.readString();
        } catch {
          while (!this.eof() && this.peek() !== "\n") this.advance();
        }
        continue;
      }
      this.advance();
    }
  }

  private trySlashDirective(): string | null {
    if (this.peek() !== "/") return null;
    const checkpoint = this.checkpoint();
    this.advance();
    const start = this.i;
    while (/[A-Za-z0-9-]/.test(this.peek())) this.advance();
    const word = this.src.slice(start, this.i);
    if (word && this.peek() === "/") {
      this.advance();
      return word;
    }
    this.restore(checkpoint);
    return null;
  }

  private tryReadLabel(): string | null {
    if (!isIdentStart(this.peek())) return null;
    const checkpoint = this.checkpoint();
    const ident = this.readIdent();
    this.skipWs();
    if (this.peek() === ":") {
      this.advance();
      return ident;
    }
    this.restore(checkpoint);
    return null;
  }

  private readName(): { name: string; unit?: string } {
    this.skipWs();
    const start = this.i;
    if (!isNameChar(this.peek())) throw this.fail(`Expected a name, found '${this.preview()}'.`);
    while (isNameChar(this.peek())) this.advance();
    const name = this.src.slice(start, this.i);
    if (this.peek() !== "@") return { name };
    this.advance();
    const unitStart = this.i;
    while (isNameChar(this.peek())) this.advance();
    const unit = this.src.slice(unitStart, this.i);
    if (!unit) throw this.fail(`Expected a unit address after '${name}@'.`);
    return { name, unit };
  }

  private readIdent(): string {
    if (!isIdentStart(this.peek())) throw this.fail(`Expected an identifier, found '${this.preview()}'.`);
    const start = this.i;
    this.advance();
    while (isIdentChar(this.peek())) this.advance();
    return this.src.slice(start, this.i);
  }

  private readNumber(): string {
    this.skipWs();
    const start = this.i;
    if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
      this.advance();
      this.advance();
      const hexStart = this.i;
      while (/[0-9a-fA-F]/.test(this.peek())) this.advance();
      if (this.i === hexStart) throw this.fail("Expected hexadecimal digits.");
    } else if (this.peek() === "0" && (this.peek(1) === "b" || this.peek(1) === "B")) {
      this.advance();
      this.advance();
      const binStart = this.i;
      while (this.peek() === "0" || this.peek() === "1") this.advance();
      if (this.i === binStart) throw this.fail("Expected binary digits.");
    } else {
      if (!isDigit(this.peek())) throw this.fail(`Expected a number, found '${this.preview()}'.`);
      while (isDigit(this.peek())) this.advance();
    }
    while (/[uUlL]/.test(this.peek())) this.advance();
    return this.src.slice(start, this.i);
  }

  private readRef(): DtRef {
    if (this.peek() !== "&") throw this.fail("Expected '&'.");
    this.advance();
    if (this.peek() === "{") {
      this.advance();
      const start = this.i;
      while (!this.eof() && this.peek() !== "}") this.advance();
      if (this.peek() !== "}") throw this.fail("Unterminated path reference.");
      const path = this.src.slice(start, this.i).trim();
      this.advance();
      if (!path) throw this.fail("Empty path reference.");
      return { kind: "path", path };
    }
    return { kind: "label", label: this.readIdent() };
  }

  private readString(): string {
    if (this.peek() !== '"') throw this.fail("Expected a string.");
    const startLine = this.line;
    this.advance();
    let out = "";
    while (!this.eof()) {
      const char = this.peek();
      if (char === '"') {
        this.advance();
        return out;
      }
      if (char === "\n" || char === "\r") {
        throw this.fail(`Unterminated string starting at line ${startLine}.`);
      }
      if (char === "\\") {
        this.advance();
        if (this.eof()) throw this.fail("Unterminated string escape.");
        const escaped = this.peek();
        this.advance();
        const simple: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          "\\": "\\",
          '"': '"',
          b: "\b",
          f: "\f",
          v: "\v",
        };
        if (escaped in simple) {
          out += simple[escaped];
          continue;
        }
        if (/[0-7]/.test(escaped)) {
          let octal = escaped;
          for (let extra = 0; extra < 2; extra += 1) {
            if (/[0-7]/.test(this.peek())) {
              octal += this.peek();
              this.advance();
            }
          }
          out += String.fromCharCode(Number.parseInt(octal, 8));
          continue;
        }
        out += escaped;
        continue;
      }
      out += char;
      this.advance();
    }
    throw this.fail(`Unterminated string starting at line ${startLine}.`);
  }

  private expectChar(char: string) {
    this.skipWs();
    if (this.peek() !== char) throw this.fail(`Expected '${char}', found '${this.preview()}'.`);
    this.advance();
  }

  private recover() {
    let depth = 0;
    while (!this.eof()) {
      const char = this.peek();
      if (char === '"') {
        try {
          this.readString();
        } catch {
          this.advance();
        }
        continue;
      }
      if (char === "{") {
        depth += 1;
        this.advance();
        continue;
      }
      if (char === "}") {
        if (depth === 0) return;
        depth -= 1;
        this.advance();
        continue;
      }
      if (char === ";" && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private skipWs() {
    while (!this.eof()) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f") {
        this.advance();
        continue;
      }
      if (char === "/" && this.peek(1) === "/") {
        while (!this.eof() && this.peek() !== "\n") this.advance();
        continue;
      }
      if (char === "/" && this.peek(1) === "*") {
        const at = this.mark();
        this.advance();
        this.advance();
        while (!this.eof() && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
        if (this.eof()) {
          this.errors.push({ ...at, message: "Unterminated comment." });
          return;
        }
        this.advance();
        this.advance();
        continue;
      }
      break;
    }
  }

  private peek(offset = 0): string {
    return this.src[this.i + offset] ?? "";
  }

  private eof(): boolean {
    return this.i >= this.src.length;
  }

  private advance() {
    const char = this.src[this.i];
    if (char === undefined) return;
    this.i += 1;
    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
  }

  private checkpoint() {
    return { i: this.i, line: this.line, column: this.column };
  }

  private restore(checkpoint: { i: number; line: number; column: number }) {
    this.i = checkpoint.i;
    this.line = checkpoint.line;
    this.column = checkpoint.column;
  }

  private mark() {
    return { line: this.line, column: this.column };
  }

  private preview(): string {
    const raw = this.src.slice(this.i, this.i + 18).replace(/\s+/g, " ");
    return raw || "end of file";
  }

  private fail(message: string): ParseError {
    return new ParseError(this.line, this.column, message);
  }

  private asIssue(error: unknown): DtIssue {
    if (error instanceof ParseError) {
      return { line: error.line, column: error.column, message: error.message };
    }
    return {
      line: this.line,
      column: this.column,
      message: error instanceof Error ? error.message : "Could not parse the device tree.",
    };
  }
}

function upsertProperty(properties: DtProperty[], property: DtProperty): DtProperty[] {
  const index = properties.findIndex((item) => item.name === property.name);
  if (index === -1) return [...properties, property];
  const existing = properties[index];
  const next = properties.slice();
  if (property.deleted) {
    next[index] = {
      ...existing,
      deleted: true,
      fromOverlay: property.fromOverlay || existing.fromOverlay,
      line: property.line,
      column: property.column,
    };
    return next;
  }
  next[index] = {
    ...property,
    fromOverlay: property.fromOverlay || existing.fromOverlay,
  };
  return next;
}

function cloneTree(node: DtNode, nextId: () => string): DtNode {
  const copy = structuredClone(node);
  const walk = (current: DtNode) => {
    current.id = nextId();
    for (const child of current.children) walk(child);
  };
  walk(copy);
  return copy;
}

function stampOverlay(node: DtNode) {
  node.fromOverlay = true;
  for (const property of node.properties) property.fromOverlay = true;
  for (const child of node.children) stampOverlay(child);
}

function collectLabelRefs(node: DtNode, into: Set<string>) {
  for (const property of node.properties) {
    if (property.deleted) continue;
    for (const part of property.parts) {
      if (part.kind === "phandle" && part.ref.kind === "label") into.add(part.ref.label);
      if (part.kind === "cells") {
        for (const cell of part.cells) {
          if (cell.kind === "ref" && cell.ref.kind === "label") into.add(cell.ref.label);
        }
      }
    }
  }
}

export function parseDts(input: string): DtDocument {
  return new Parser(input).parseDocument();
}
