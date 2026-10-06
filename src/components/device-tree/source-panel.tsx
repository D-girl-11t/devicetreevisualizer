"use client";

import type { Example } from "@/lib/dts/samples";
import type { DtIssue } from "@/lib/dts/types";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { TriangleAlert, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const LINE_HEIGHT = 20;

export function SourcePanel({
  source,
  onSource,
  examples,
  activeExampleId,
  onExample,
  fileLabel,
  originNote,
  loadError,
  errors,
  warnings,
  activeLine,
  activeEnd,
  dragging,
  onDrag,
  onFile,
  onJump,
}: {
  source: string;
  onSource: (value: string) => void;
  examples: Example[];
  activeExampleId: string | null;
  onExample: (example: Example) => void;
  fileLabel: string | null;
  originNote: string | null;
  loadError: string | null;
  errors: DtIssue[];
  warnings: DtIssue[];
  activeLine: number | null;
  activeEnd: number | null;
  dragging: boolean;
  onDrag: (active: boolean) => void;
  onFile: (file: File) => void;
  onJump: (line: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [issuesOpen, setIssuesOpen] = useState(errors.length > 0);
  const [seenErrorCount, setSeenErrorCount] = useState(errors.length);
  if (errors.length !== seenErrorCount) {
    setSeenErrorCount(errors.length);
    if (errors.length > 0) setIssuesOpen(true);
  }
  const lines = source.split("\n");
  let widthCh = 34;
  for (const line of lines) widthCh = Math.max(widthCh, line.length + 2);
  const rangeEnd =
    activeLine && activeEnd ? Math.min(activeEnd, activeLine + 80) : activeLine;

  useEffect(() => {
    const el = scroller.current;
    if (!el || !activeLine) return;
    const top = (activeLine - 1) * LINE_HEIGHT;
    const bottom = top + LINE_HEIGHT;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    if (top < viewTop + 12 || bottom > viewBottom - 12) {
      el.scrollTop = Math.max(0, top - el.clientHeight * 0.35);
    }
  }, [activeLine]);

  const issueCount = errors.length + warnings.length;

  return (
    <section
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col border-border lg:w-[clamp(300px,32vw,440px)] lg:shrink-0 lg:border-r",
        dragging && "bg-primary/5",
      )}
      onDragEnter={(event) => {
        event.preventDefault();
        onDrag(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        onDrag(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        onDrag(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrag(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Source</h2>
            <p className="truncate text-xs text-muted-foreground">
              {fileLabel ?? "Paste .dts, or drop a .dts / .dtb"}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload />
            Open
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".dts,.dtsi,.dtb,.dtbo,.txt"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onFile(file);
            }}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {examples.map((example) => (
            <Button
              key={example.id}
              type="button"
              size="xs"
              variant={example.id === activeExampleId ? "secondary" : "ghost"}
              onClick={() => onExample(example)}
              title={example.detail}
            >
              {example.name}
            </Button>
          ))}
        </div>
      </div>

      {originNote ? (
        <p className="shrink-0 border-b bg-primary/10 px-3 py-1.5 text-xs leading-5 text-foreground">
          {originNote}
        </p>
      ) : null}
      {loadError ? (
        <p className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-xs leading-5 text-destructive">
          {loadError}
        </p>
      ) : null}

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-w-full" style={{ width: `max(100%, ${widthCh + 6}ch)` }}>
          <div
            aria-hidden
            className="sticky left-0 z-10 w-11 shrink-0 select-none border-r border-border/80 bg-background pt-2 text-right font-mono text-[12px] text-muted-foreground"
            style={{ lineHeight: `${LINE_HEIGHT}px` }}
          >
            {lines.map((_, index) => {
              const line = index + 1;
              const start = line === activeLine;
              const inside = activeLine !== null && rangeEnd !== null && line >= activeLine && line <= rangeEnd;
              return (
                <div
                  key={line}
                  className={cn(
                    "pr-2",
                    inside && "bg-primary/10",
                    start && "bg-primary/20 font-medium text-foreground",
                  )}
                >
                  {line}
                </div>
              );
            })}
          </div>
          <textarea
            value={source}
            onChange={(event) => onSource(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label="Device tree source"
            className="min-w-0 flex-1 resize-none bg-transparent py-2 pr-3 pl-3 font-mono text-[12.5px] leading-5 text-foreground outline-none"
            style={{
              height: Math.max(lines.length, 16) * LINE_HEIGHT + 16,
              tabSize: 4,
              lineHeight: `${LINE_HEIGHT}px`,
            }}
          />
        </div>
      </div>

      {issueCount > 0 ? (
        <details
          className="max-h-40 shrink-0 overflow-auto border-t"
          open={issuesOpen}
          onToggle={(event) => setIssuesOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-muted-foreground">
            <TriangleAlert className="mr-1 inline size-3.5 align-[-2px] text-[var(--dt-string)]" />
            {errors.length} {errors.length === 1 ? "error" : "errors"}
            {" · "}
            {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
          </summary>
          <ul className="space-y-1 px-3 pb-2">
            {[...errors.map((issue) => ({ ...issue, severity: "error" as const })), ...warnings.map((issue) => ({ ...issue, severity: "warning" as const }))].map(
              (issue, index) => (
                <li key={`${issue.severity}-${issue.line}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onJump(issue.line)}
                    className={cn(
                      "w-full rounded-md px-1.5 py-1 text-left font-mono text-[11px] leading-4 hover:bg-muted",
                      issue.severity === "error" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {issue.line}:{issue.column} {issue.message}
                  </button>
                </li>
              ),
            )}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
