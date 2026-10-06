"use client";

import { nodeMatches, type NodeFilter } from "@/lib/dts/analyze";
import { compatibleOf, statusOf } from "@/lib/dts/format";
import type { DtDocument, DtNode } from "@/lib/dts/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";
import { ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

type Row = {
  node: DtNode;
  depth: number;
  hit: boolean;
  hasChildren: boolean;
};

const filters: { id: NodeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "compatible", label: "Compatible" },
];

export function TreePanel({
  doc,
  selectedPath,
  expanded,
  query,
  filter,
  showDeleted,
  onQuery,
  onFilter,
  onToggleDeleted,
  onToggle,
  onSelect,
  onInspect,
}: {
  doc: DtDocument;
  selectedPath: string;
  expanded: Set<string>;
  query: string;
  filter: NodeFilter;
  showDeleted: boolean;
  onQuery: (value: string) => void;
  onFilter: (filter: NodeFilter) => void;
  onToggleDeleted: () => void;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onInspect: () => void;
}) {
  const filtering = query.trim().length > 0 || filter !== "all";
  const rows = useMemo(() => {
    const forest = [...(doc.root ? [doc.root] : []), ...doc.unresolved];
    return forest.flatMap((node) =>
      flatten(node, 0, { expanded, query, filter, showDeleted, filtering }),
    );
  }, [doc, expanded, query, filter, showDeleted, filtering]);

  const hits = filtering ? rows.filter((row) => row.hit).length : 0;
  const selectedVisible = rows.some((row) => row.node.path === selectedPath);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.getElementById("dt-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = rows.findIndex((row) => row.node.path === selectedPath);
    const current = rows[index];
    if (event.key === "ArrowDown" && rows.length > 0) {
      event.preventDefault();
      onSelect(rows[Math.min(rows.length - 1, Math.max(0, index) + (index === -1 ? 0 : 1))].node.path);
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      onSelect(rows[index - 1].node.path);
    } else if (event.key === "ArrowRight" && current) {
      event.preventDefault();
      if (current.hasChildren && !isOpen(current, expanded, filtering)) onToggle(current.node.path);
      else if (rows[index + 1] && rows[index + 1].depth > current.depth) onSelect(rows[index + 1].node.path);
    } else if (event.key === "ArrowLeft" && current) {
      event.preventDefault();
      if (current.hasChildren && isOpen(current, expanded, filtering)) onToggle(current.node.path);
      else {
        const parent = parentPath(current.node.path);
        if (parent) onSelect(parent);
      }
    }
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onValueChange={onQuery}
              placeholder="Search name, label, compatible, property"
              aria-label="Search the device tree"
              className="pl-7"
            />
            {query ? (
              <button
                type="button"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Clear search"
                onClick={() => onQuery("")}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {filtering ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{hits}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {filters.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="xs"
              variant={filter === item.id ? "secondary" : "ghost"}
              onClick={() => onFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
          <Button
            type="button"
            size="xs"
            variant={showDeleted ? "secondary" : "ghost"}
            onClick={onToggleDeleted}
          >
            Deleted
          </Button>
          {doc.plugin ? (
            <Badge variant="outline" className="ml-auto">
              Plugin
            </Badge>
          ) : null}
        </div>
        {doc.memreserves.length > 0 ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            memreserve{" "}
            {doc.memreserves.map((reserve) => `${reserve.address} + ${reserve.size}`).join("  ·  ")}
          </p>
        ) : null}
      </div>

      <div
        ref={treeRef}
        role="tree"
        tabIndex={0}
        aria-label="Device tree"
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          const target = event.target;
          if (target instanceof Element && target.closest("input, textarea, button, a, select")) return;
          treeRef.current?.focus({ preventScroll: true });
        }}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {rows.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            {doc.root || doc.unresolved.length > 0
              ? "No nodes match this search."
              : "Nothing to draw yet. Add a root node or open an example."}
          </p>
        ) : (
          rows.map((row, index) => {
            const previous = rows[index - 1];
            const showUnresolved = row.node.ref && row.depth === 0 && !previous?.node.ref;
            return (
              <div key={row.node.id}>
                {showUnresolved ? (
                  <p className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Unresolved fragments
                  </p>
                ) : null}
                <TreeRow
                  row={row}
                  selected={row.node.path === selectedPath}
                  open={isOpen(row, expanded, filtering)}
                  dim={filtering && !row.hit}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              </div>
            );
          })
        )}
        {selectedPath && !selectedVisible && rows.length > 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            The selected node is hidden by this filter.
          </p>
        ) : null}
      </div>
      {selectedPath ? (
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2 lg:hidden">
          <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{selectedPath}</p>
          <Button type="button" size="xs" variant="secondary" onClick={onInspect}>
            Inspect
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function TreeRow({
  row,
  selected,
  open,
  dim,
  onSelect,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  open: boolean;
  dim: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const { node } = row;
  const status = statusOf(node);
  const compatible = compatibleOf(node)[0];
  const label = node.labels[0];

  return (
    <div
      id={selected ? "dt-selected" : undefined}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={row.hasChildren ? open : undefined}
      aria-level={row.depth + 1}
      title={node.path}
      onClick={() => onSelect(node.path)}
      onDoubleClick={() => {
        if (row.hasChildren) onToggle(node.path);
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm",
        selected ? "bg-primary/15 text-foreground" : "hover:bg-muted/80",
        dim && "opacity-60",
        node.deleted && "opacity-55",
      )}
      style={{ paddingLeft: 6 + row.depth * 14 }}
    >
      {row.hasChildren ? (
        <span
          role="presentation"
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/80"
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.path);
          }}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </span>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span className={cn("size-1.5 shrink-0 rounded-full", dotClass(node, status))} />
      <span className={cn("truncate", node.deleted && "line-through")}>
        <span className="font-medium">{node.name === "/" ? "/" : node.name}</span>
        {node.unitAddress ? (
          <span className="text-muted-foreground">@{node.unitAddress}</span>
        ) : null}
      </span>
      {label ? (
        <span className="shrink-0 font-mono text-[11px] text-[var(--dt-ref)]">&{label}</span>
      ) : null}
      {node.fromOverlay ? (
        <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          overlay
        </span>
      ) : null}
      {node.omitted ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">omitted</span>
      ) : null}
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {compatible ? (
          <span className="hidden truncate font-mono text-[11px] text-muted-foreground xl:inline">
            {compatible}
          </span>
        ) : null}
        {status && status !== "okay" ? (
          <span
            className={cn(
              "shrink-0 font-mono text-[10px] uppercase",
              status === "disabled" ? "text-[var(--dt-off)]" : "text-[var(--dt-string)]",
            )}
          >
            {status}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function dotClass(node: DtNode, status: string | null): string {
  if (node.deleted) return "bg-muted-foreground/40";
  if (status === "disabled") return "bg-[var(--dt-off)]";
  if (status === "okay") return "bg-[var(--dt-ok)]";
  if (status) return "bg-[var(--dt-string)]";
  return "bg-muted-foreground/35";
}

function isOpen(row: Row, expanded: Set<string>, filtering: boolean): boolean {
  return filtering || expanded.has(row.node.path);
}

export function parentPath(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  if (cut < 0) return null;
  if (cut === 0) return "/";
  return path.slice(0, cut);
}

function flatten(
  node: DtNode,
  depth: number,
  options: {
    expanded: Set<string>;
    query: string;
    filter: NodeFilter;
    showDeleted: boolean;
    filtering: boolean;
  },
): Row[] {
  const childList = node.children.filter(
    (child) => options.showDeleted || !child.deleted || options.filtering,
  );
  const hit = nodeMatches(node, options.query, options.filter);
  const keptChildren = node.children.filter((child) => options.showDeleted || !child.deleted);
  if (!options.filtering && !options.expanded.has(node.path)) {
    if (node.deleted && !options.showDeleted) return [];
    return [{ node, depth, hit: false, hasChildren: keptChildren.length > 0 }];
  }
  const children = childList.flatMap((child) => flatten(child, depth + 1, options));
  if (node.deleted && !options.showDeleted && !hit && children.length === 0) return [];
  if (options.filtering && !hit && children.length === 0) return [];
  return [{ node, depth, hit, hasChildren: keptChildren.length > 0 }, ...children];
}
