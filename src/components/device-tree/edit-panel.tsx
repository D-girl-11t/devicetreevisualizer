"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BoardBrief } from "@/lib/dts/brief";
import { descriptionFile } from "@/lib/dts/brief";
import { compileDtb } from "@/lib/dts/compile";
import { changedLines, designChecklist, designNodes, fillGap, proposeEdits, proposeRemoval, type EditPlan, type TreeEdit } from "@/lib/dts/edits";
import { SAVED_LIMIT, dropTree, storeTree, type SavedTree } from "@/lib/dts/saved";
import type { DtDocument } from "@/lib/dts/types";
import { cn } from "cn";
import { useState } from "react";

const STORAGE_KEY = "dt-saved-trees";

export function loadSavedTrees(): SavedTree[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedTree[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, SAVED_LIMIT) : [];
  } catch {
    return [];
  }
}

export function writeSavedTrees(trees: SavedTree[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trees.slice(0, SAVED_LIMIT)));
}

export function EditPanel({
  source,
  doc,
  brief,
  fileBase,
  saved,
  onSaved,
  onSource,
}: {
  source: string;
  doc: DtDocument;
  brief: BoardBrief;
  fileBase: string;
  saved: SavedTree[];
  onSaved: (trees: SavedTree[]) => void;
  onSource: (source: string) => void;
}) {
  const [request, setRequest] = useState("serial@a01000");
  const [steps, setSteps] = useState<TreeEdit[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [proposed, setProposed] = useState(false);
  const [saveName, setSaveName] = useState(brief.title);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  function show(plan: EditPlan) {
    setSteps(plan.edits);
    setNote(plan.note);
    setProposed(true);
  }

  function propose() {
    show(proposeEdits(request, doc));
  }

  function approve(step: TreeEdit) {
    onSource(step.apply(source));
    setSteps((current) => current.filter((item) => item.id !== step.id));
  }

  function approveAll() {
    let next = source;
    for (const step of steps) next = step.apply(next);
    onSource(next);
    setSteps([]);
  }

  function save() {
    const result = storeTree(saved, {
      id: `${Date.now()}`,
      name: saveName.trim() || brief.title,
      source,
      savedAt: Date.now(),
    });
    setSaveError(result.error);
    if (!result.error) {
      onSaved(result.trees);
      writeSavedTrees(result.trees);
    }
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 px-3 py-3 sm:px-4">
        <div>
          <h2 className="text-sm font-medium">Edit</h2>
          <p className="text-xs text-muted-foreground">
            A board file needs /dts-v1/;, a root, model, compatible, address cells, one CPU, memory, and a console. Add what is missing, start from the template, remove a node, or type one line.
          </p>
        </div>

        {designChecklist(doc).some((item) => !item.met) ? (
          <ul className="flex flex-col gap-1.5">
            {designChecklist(doc)
              .filter((item) => !item.met)
              .map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="text-sm">{item.title}</p>
                    <p className="text-[11px] text-muted-foreground">{item.detail}</p>
                  </div>
                  <Button type="button" size="xs" variant="secondary" onClick={() => show(fillGap(item.id, doc))}>
                    Add
                  </Button>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--dt-ok)]">
            This file already has the version line, root, model, compatible, address cells, a CPU, memory, and a console.
          </p>
        )}
        <Button type="button" size="sm" variant="outline" onClick={() => show(proposeEdits("start from the template", doc))}>
          Start from the template
        </Button>

        <div className="flex flex-col gap-2">
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={2}
            aria-label="Describe the device tree change"
            placeholder="serial@a01000"
            className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={propose}>
              Show the edits
            </Button>
            {steps.length > 1 ? (
              <Button type="button" size="sm" variant="secondary" onClick={approveAll}>
                Approve all
              </Button>
            ) : null}
          </div>
          {proposed && note ? <p className="text-sm text-[var(--dt-string)]">{note}</p> : null}
          {proposed && steps.length === 0 && !note ? (
            <p className="text-sm text-muted-foreground">Nothing in this tree needs that change.</p>
          ) : null}
        </div>

        {steps.map((step, index) => (
          <EditCard
            key={step.id}
            index={index + 1}
            total={steps.length}
            step={step}
            source={source}
            onApprove={() => approve(step)}
            onSkip={() => setSteps((current) => current.filter((item) => item.id !== step.id))}
          />
        ))}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">In this file</h3>
          {designNodes(doc).length === 0 ? (
            <p className="text-xs text-muted-foreground">No nodes yet. Start from the template, then add a line.</p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {designNodes(doc).map((node) => (
                <li key={node.path} className="flex items-center gap-2 rounded-md border px-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={node.path}>
                    {node.title}
                  </span>
                  <Button type="button" size="xs" variant="ghost" onClick={() => show(proposeRemoval(doc, node.path))}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t pt-3">
          <div>
            <h3 className="text-sm font-medium">Keep this tree</h3>
            <p className="text-xs text-muted-foreground">
              Save up to {SAVED_LIMIT} trees in this browser, or download the source, the blob, and the description.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={saveName}
              onValueChange={setSaveName}
              aria-label="Name for the saved tree"
              placeholder="Board name"
            />
            <Button type="button" variant="secondary" onClick={save}>
              Save on this page
            </Button>
          </div>
          {saveError ? <p className="text-sm text-[var(--dt-string)]">{saveError}</p> : null}
          {saved.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {saved.map((tree) => (
                <li key={tree.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{tree.name}</span>
                  <Button type="button" size="xs" variant="ghost" onClick={() => onSource(tree.source)}>
                    Open
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const next = dropTree(saved, tree.id);
                      onSaved(next);
                      writeSavedTrees(next);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No trees saved on this page yet.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => downloadText(`${fileBase}.dts`, source, "text/plain")}>
              Download DTS
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  const bytes = compileDtb(doc);
                  downloadText(`${fileBase}.dtb`, bytes, "application/octet-stream");
                  setFileError(null);
                } catch (error) {
                  setFileError(error instanceof Error ? error.message : "Could not build the blob.");
                }
              }}
            >
              Download DTB
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadText(`${fileBase}.txt`, descriptionFile(brief), "text/plain")}
            >
              Download description
            </Button>
          </div>
          {fileError ? <p className="text-sm text-[var(--dt-string)]">{fileError}</p> : null}
        </div>
      </div>
    </section>
  );
}

function EditCard({
  index,
  total,
  step,
  source,
  onApprove,
  onSkip,
}: {
  index: number;
  total: number;
  step: TreeEdit;
  source: string;
  onApprove: () => void;
  onSkip: () => void;
}) {
  let lines: ReturnType<typeof changedLines> = [];
  let problem: string | null = null;
  try {
    lines = changedLines(source, step.apply(source));
  } catch (error) {
    problem = error instanceof Error ? error.message : "This edit no longer fits the tree.";
  }
  return (
    <article className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <div>
          <p className="text-[11px] text-muted-foreground">
            Edit {index} of {total}
          </p>
          <h3 className="text-sm font-medium">{step.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>
        </div>
        <div className="flex gap-1">
          <Button type="button" size="sm" onClick={onApprove} disabled={Boolean(problem)}>
            Approve
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onSkip}>
            Skip
          </Button>
        </div>
      </div>
      {problem ? (
        <p className="px-3 py-2 text-sm text-[var(--dt-string)]">{problem}</p>
      ) : (
        <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-5">
          {lines.map((line, lineIndex) => (
            <div
              key={`${line.kind}-${lineIndex}`}
              className={cn(
                line.kind === "add" && "bg-[color-mix(in_oklch,var(--dt-ok)_22%,transparent)] text-[var(--dt-ok)]",
                line.kind === "del" && "bg-[color-mix(in_oklch,var(--dt-off)_18%,transparent)] text-[var(--dt-off)]",
                line.kind === "ctx" && "text-muted-foreground",
              )}
            >
              {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </article>
  );
}

function downloadText(filename: string, data: string | Uint8Array, type: string) {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
