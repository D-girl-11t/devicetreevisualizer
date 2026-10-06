export type DtRef =
  | { kind: "label"; label: string }
  | { kind: "path"; path: string };

export type DtCell =
  | { kind: "number"; raw: string }
  | { kind: "symbol"; name: string }
  | { kind: "expr"; raw: string }
  | { kind: "ref"; ref: DtRef };

export type DtValuePart =
  | { kind: "string"; value: string }
  | { kind: "cells"; bits?: number; cells: DtCell[] }
  | { kind: "bytes"; bits?: number; bytes: number[] }
  | { kind: "phandle"; ref: DtRef }
  | { kind: "incbin"; file: string; offset?: string; size?: string };

export type DtProperty = {
  name: string;
  parts: DtValuePart[];
  /** True when the property was written as `name;` with no value. */
  boolean: boolean;
  deleted: boolean;
  fromOverlay: boolean;
  line: number;
  column: number;
};

export type DtNode = {
  id: string;
  name: string;
  unitAddress?: string;
  fullName: string;
  labels: string[];
  path: string;
  properties: DtProperty[];
  children: DtNode[];
  line: number;
  endLine: number;
  column: number;
  ref?: DtRef;
  omitIfNoRef: boolean;
  deleted: boolean;
  /** Dropped because nothing referenced an `/omit-if-no-ref/` node. */
  omitted: boolean;
  fromOverlay: boolean;
  modifiedByOverlay: boolean;
  /**
   * Child names a delete directive could not match locally.
   * Applied to the merge target for overlay fragments.
   */
  deletedChildren: string[];
  deletedLabels: string[];
  deletedPaths: string[];
};

export type DtIssue = {
  line: number;
  column: number;
  message: string;
};

export type DtMemreserve = {
  address: string;
  size: string;
  line: number;
};

export type DtDocument = {
  plugin: boolean;
  hasVersion: boolean;
  memreserves: DtMemreserve[];
  root: DtNode | null;
  unresolved: DtNode[];
  errors: DtIssue[];
  warnings: DtIssue[];
  decompiled: boolean;
};
