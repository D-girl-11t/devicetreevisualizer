"use client";

import { defaultExpanded, indexDocument, type NodeFilter } from "@/lib/dts/analyze";
import { summarizeBoard } from "@/lib/dts/brief";
import { buildBoardDiagram } from "@/lib/dts/diagram";
import { analyzeBringup } from "@/lib/dts/bringup";
import { analyzeMemoryMap } from "@/lib/dts/memory-map";
import { decompileDtb, isDtb } from "@/lib/dts/dtb";
import { toJson } from "@/lib/dts/format";
import { parseDts } from "@/lib/dts/parse";
import { defaultExample, examples, type Example } from "@/lib/dts/samples";
import type { SavedTree } from "@/lib/dts/saved";
import type { DtRef } from "@/lib/dts/types";
import { BoardPanel } from "@/components/device-tree/board-panel";
import { EditPanel, loadSavedTrees } from "@/components/device-tree/edit-panel";
import { BringupPanel } from "@/components/device-tree/bringup-panel";
import { Inspector } from "@/components/device-tree/inspector";
import { parentPath, TreePanel } from "@/components/device-tree/tree-panel";
import { SourcePanel } from "@/components/device-tree/source-panel";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { Download, FoldVertical, Moon, Sun, UnfoldVertical } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Tab = "source" | "tree" | "path" | "board" | "edit" | "node";
type Center = "tree" | "path" | "board" | "edit";

export function Visualizer() {
  const [source, setSource] = useState(defaultExample.source);
  const [exampleId, setExampleId] = useState<string | null>(defaultExample.id);
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [originNote, setOriginNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState("/");
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(parseDts(defaultExample.source).root));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<NodeFilter>("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [tab, setTab] = useState<Tab>("tree");
  const [center, setCenter] = useState<Center>("tree");
  const [pinnedLine, setPinnedLine] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<SavedTree[]>(() => (typeof window === "undefined" ? [] : loadSavedTrees()));

  const doc = useMemo(() => parseDts(source), [source]);
  const index = useMemo(() => indexDocument(doc), [doc]);
  const board = useMemo(() => analyzeBringup(doc, index), [doc, index]);
  const memoryMap = useMemo(() => analyzeMemoryMap(doc), [doc]);
  const brief = useMemo(() => summarizeBoard(doc, board, memoryMap), [doc, board, memoryMap]);
  const diagram = useMemo(() => buildBoardDiagram(doc, board, memoryMap), [doc, board, memoryMap]);
  const fileBase =
    (brief.title || "device-tree")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "device-tree";
  const resolvedPath =
    selectedPath && index.byPath.has(selectedPath)
      ? selectedPath
      : (doc.root?.path ?? doc.unresolved[0]?.path ?? "");
  const selected = resolvedPath ? (index.byPath.get(resolvedPath) ?? null) : null;
  const selectedLink =
    board.links.find((link) => link.path === selected?.path && !link.deleted) ??
    board.links.find((link) => link.path === selected?.path) ??
    null;
  const activeLine = pinnedLine ?? selected?.line ?? null;
  const activeEnd = pinnedLine ?? selected?.endLine ?? null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      document.querySelector<HTMLInputElement>('[aria-label="Search the device tree"]')?.focus();
      setTab("tree");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function reveal(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      let cursor = parentPath(path);
      while (cursor) {
        next.add(cursor);
        cursor = parentPath(cursor);
      }
      return next;
    });
    setSelectedPath(path);
    setPinnedLine(null);
  }

  function loadExample(example: Example) {
    setSource(example.source);
    setExampleId(example.id);
    setFileLabel(null);
    setOriginNote(null);
    setLoadError(null);
    setQuery("");
    setPinnedLine(null);
    const parsed = parseDts(example.source);
    setExpanded(defaultExpanded(parsed.root));
    setSelectedPath(parsed.root?.path ?? "/");
    setTab("tree");
  }

  async function loadFile(file: File) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isDtb(bytes)) {
        const text = decompileDtb(bytes);
        const parsed = parseDts(text);
        setSource(text);
        setExampleId(null);
        setFileLabel(file.name);
        setOriginNote(
          `Decompiled from ${file.name}. String and cell detection is heuristic — check properties that look wrong.`,
        );
        setLoadError(null);
        setQuery("");
        setPinnedLine(null);
        setExpanded(defaultExpanded(parsed.root));
        setSelectedPath(parsed.root?.path ?? "");
        setTab("tree");
        return;
      }
      if (bytes.includes(0)) {
        setLoadError(`${file.name} is not device tree source or a flattened blob.`);
        return;
      }
      const text = new TextDecoder().decode(bytes);
      const parsed = parseDts(text);
      setSource(text);
      setExampleId(null);
      setFileLabel(file.name);
      setOriginNote(null);
      setLoadError(null);
      setQuery("");
      setPinnedLine(null);
      setExpanded(defaultExpanded(parsed.root));
      setSelectedPath(parsed.root?.path ?? parsed.unresolved[0]?.path ?? "");
      setTab("tree");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not read that file.");
    }
  }

  function follow(ref: DtRef) {
    const node = ref.kind === "label" ? index.byLabel.get(ref.label) : index.byPath.get(ref.path);
    if (!node) return;
    reveal(node.path);
    setTab("node");
  }

  function download() {
    const payload = {
      ...(doc.root ? { root: toJson(doc.root) } : {}),
      ...(doc.unresolved.length ? { unresolved: doc.unresolved.map((node) => toJson(node)) } : {}),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const base = (fileLabel ?? examples.find((item) => item.id === exampleId)?.name ?? "device-tree")
      .replace(/\.[^.]+$/, "")
      .replace(/\s+/g, "-")
      .toLowerCase();
    anchor.href = url;
    anchor.download = `${base}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function toggleTheme() {
    const nextDark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", nextDark);
    try {
      localStorage.setItem("dt-theme", nextDark ? "dark" : "light");
    } catch {
      /* private mode */
    }
  }

  const model = doc.root?.properties.find((property) => property.name === "model" && !property.deleted);
  const modelText = model?.parts.find((part) => part.kind === "string");

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="h-1 shrink-0 bg-[linear-gradient(90deg,var(--dt-ok),var(--dt-ref),var(--dt-string),var(--dt-symbol))]"
      />
      <header className="flex shrink-0 items-center gap-3 border-b bg-[linear-gradient(90deg,color-mix(in_oklch,var(--primary)_14%,var(--background)),color-mix(in_oklch,var(--dt-symbol)_12%,var(--background))_42%,var(--background))] px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <TreeMark />
          <div className="min-w-0">
            <p className="text-sm leading-none font-semibold tracking-tight">Device Tree</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {modelText && modelText.kind === "string" ? modelText.value : "Visualizer"}
            </p>
          </div>
        </div>
        <p className="ml-auto hidden items-center gap-2 font-mono text-[11px] text-muted-foreground md:flex">
          <span>{index.stats.nodes} nodes</span>
          <span className="text-border">/</span>
          <span>{index.stats.disabled} disabled</span>
          <span className="text-border">/</span>
          <span>{index.stats.labels} labels</span>
          {index.stats.unresolved > 0 ? (
            <>
              <span className="text-border">/</span>
              <span className="text-[var(--dt-string)]">{index.stats.unresolved} unresolved</span>
            </>
          ) : null}
          {doc.errors.length > 0 ? (
            <>
              <span className="text-border">/</span>
              <button type="button" className="text-destructive hover:underline" onClick={() => setTab("source")}>
                {doc.errors.length} errors
              </button>
            </>
          ) : null}
        </p>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Expand all"
            onClick={() =>
              setExpanded(new Set(index.nodes.filter((node) => node.children.length > 0).map((node) => node.path)))
            }
          >
            <UnfoldVertical />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Collapse all" onClick={() => setExpanded(new Set())}>
            <FoldVertical />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Download JSON" onClick={download}>
            <Download />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Toggle color theme" onClick={toggleTheme}>
            <Sun className="hidden dark:block" />
            <Moon className="block dark:hidden" />
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5 lg:hidden">
        {(
          [
            ["source", "Source"],
            ["tree", "Tree"],
            ["path", "Path"],
            ["board", "Board"],
            ["edit", "Edit"],
            ["node", "Node"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id);
              if (id === "tree" || id === "path" || id === "board" || id === "edit") setCenter(id);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm",
              tab === id ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className={cn("min-h-0 flex-1 flex-col lg:flex-none", tab === "source" ? "flex" : "hidden lg:flex")}>
          <SourcePanel
            source={source}
            onSource={(value) => {
              setSource(value);
              setExampleId(null);
              setOriginNote(null);
            }}
            examples={examples}
            activeExampleId={exampleId}
            onExample={loadExample}
            fileLabel={fileLabel}
            originNote={originNote}
            loadError={loadError}
            errors={doc.errors}
            warnings={doc.warnings}
            activeLine={activeLine}
            activeEnd={activeEnd}
            dragging={dragging}
            onDrag={setDragging}
            onFile={(file) => void loadFile(file)}
            onJump={(line) => {
              setPinnedLine(line);
              setTab("source");
            }}
          />
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col",
            tab === "tree" || tab === "path" || tab === "board" || tab === "edit" ? "flex" : "hidden lg:flex",
          )}
        >
          <div className="hidden shrink-0 items-center gap-1 border-b px-3 py-1.5 lg:flex">
            {(
              [
                ["tree", "Tree"],
                ["path", "Path"],
                ["board", "Board"],
                ["edit", "Edit"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setCenter(id);
                  setTab(id);
                }}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm",
                  center === id ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {center === "path"
                ? "pins · tree · kernel · userspace"
                : center === "board"
                  ? "diagram · brief · memory map"
                  : center === "edit"
                    ? "template · line · approve"
                    : "nodes and labels"}
            </span>
          </div>
          <div className="min-h-0 flex-1">
          {center === "edit" ? (
          <EditPanel
            source={source}
            doc={doc}
            brief={brief}
            fileBase={fileBase}
            saved={saved}
            onSaved={setSaved}
            onSource={(value) => {
              setSource(value);
              setExampleId(null);
              setOriginNote(null);
            }}
          />
          ) : center === "board" ? (
          <BoardPanel brief={brief} diagram={diagram} map={memoryMap} selectedPath={resolvedPath} onSelect={reveal} />
          ) : center === "tree" ? (
          <TreePanel
            doc={doc}
            selectedPath={resolvedPath}
            expanded={expanded}
            query={query}
            filter={filter}
            showDeleted={showDeleted}
            onQuery={setQuery}
            onFilter={setFilter}
            onToggleDeleted={() => setShowDeleted((value) => !value)}
            onToggle={(path) =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onSelect={reveal}
            onInspect={() => setTab("node")}
          />
          ) : (
          <BringupPanel
            board={board}
            selectedPath={resolvedPath}
            onSelect={reveal}
            onInspect={() => setTab("node")}
          />
          )}
          </div>
        </div>
        <div className={cn("min-h-0 flex-1 flex-col lg:flex-none", tab === "node" ? "flex" : "hidden lg:flex")}>
          <Inspector
            node={selected}
            index={index}
            showDeleted={showDeleted}
            onSelect={(path) => {
              reveal(path);
              setTab("node");
            }}
            onRef={follow}
            onJump={(line) => {
              setPinnedLine(line);
              setTab("source");
            }}
            link={selectedLink}
          />
        </div>
      </div>
    </div>
  );
}

function TreeMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="8" className="fill-primary/15" />
      <path
        d="M16 6.5v5.5M16 12c-5.2 1.6-7.2 5-7.2 8.8M16 14.2c5.2 1.6 7.2 5 7.2 8.8M16 18.5V25"
        fill="none"
        className="stroke-primary"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="16" cy="12" r="1.3" className="fill-[var(--dt-string)]" />
      <circle cx="8.8" cy="20.8" r="1.3" className="fill-[var(--dt-ok)]" />
      <circle cx="23.2" cy="23" r="1.3" className="fill-[var(--dt-ref)]" />
    </svg>
  );
}
