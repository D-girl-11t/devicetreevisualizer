"use client";

import type { DtIndex } from "@/lib/dts/analyze";
import type { BringupLink } from "@/lib/dts/bringup";
import { compatibleOf, propertyByName, statusOf, stringValues, toJson } from "@/lib/dts/format";
import type { DtNode, DtRef } from "@/lib/dts/types";
import { ValueView } from "@/components/device-tree/value-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function Inspector({
  node,
  index,
  showDeleted,
  onSelect,
  onRef,
  onJump,
  link,
}: {
  node: DtNode | null;
  index: DtIndex;
  showDeleted: boolean;
  onSelect: (path: string) => void;
  onRef: (ref: DtRef) => void;
  onJump: (line: number) => void;
  link?: BringupLink | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
    } catch {
      setCopied("failed");
    }
  }

  if (!node) {
    return (
      <section className="flex h-full min-h-0 flex-col border-border lg:w-[clamp(280px,30vw,400px)] lg:shrink-0 lg:border-l">
        <div className="border-b px-3 py-2.5">
          <h2 className="text-sm font-medium">Node</h2>
        </div>
        <p className="px-4 py-8 text-sm leading-6 text-muted-foreground">
          Select a node to read its properties, labels, and the phandles that point at it.
        </p>
      </section>
    );
  }

  const status = statusOf(node);
  const compatible = compatibleOf(node);
  const model = stringValues(propertyByName(node, "model"));
  const children = node.children.filter((child) => showDeleted || !child.deleted);
  const referenced = incomingFor(node, index);
  const isKnown = (ref: DtRef) =>
    ref.kind === "label" ? index.byLabel.has(ref.label) : index.byPath.has(ref.path);

  return (
    <section className="flex h-full min-h-0 flex-col border-border lg:w-[clamp(280px,30vw,400px)] lg:shrink-0 lg:border-l">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{node.fullName}</h2>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{node.path}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => copy("path", node.path)}
        >
          {copied === "path" ? <Check /> : <Copy />}
          Path
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {link ? (
          <div className="mb-3 rounded-md border bg-muted/40 px-2.5 py-2">
            <p className="text-[10px] font-semibold tracking-wide text-[var(--dt-string)] uppercase">Userspace</p>
            <p className="mt-0.5 font-mono text-[12px] leading-5 break-words">{link.userspace}</p>
            <p className="mt-1 text-[11px] text-[var(--dt-symbol)]">
              {link.kernel.driver}
              {link.kernel.config ? <span className="text-muted-foreground"> · {link.kernel.config}</span> : null}
            </p>
          </div>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {status ? (
            <Badge variant={status === "disabled" ? "destructive" : "secondary"}>{status}</Badge>
          ) : (
            <Badge variant="outline">no status</Badge>
          )}
          {node.fromOverlay ? <Badge variant="outline">from overlay</Badge> : null}
          {node.modifiedByOverlay ? <Badge variant="outline">overlay edit</Badge> : null}
          {node.deleted ? <Badge variant="destructive">{node.omitted ? "omitted" : "deleted"}</Badge> : null}
          <button
            type="button"
            onClick={() => onJump(node.line)}
            className="ml-auto font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            line {node.line}
          </button>
        </div>

        {node.labels.length > 0 ? (
          <p className="mb-3 font-mono text-xs text-[var(--dt-ref)]">
            {node.labels.map((label) => `&${label}`).join("  ")}
          </p>
        ) : null}

        {node.omitted ? (
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            This node is marked <span className="font-mono">/omit-if-no-ref/</span> and nothing references its label, so a compiler would drop it.
          </p>
        ) : null}

        {model[0] ? (
          <p className="mb-3 text-sm leading-6">{model[0]}</p>
        ) : null}

        {compatible.length > 0 ? (
          <div className="mb-4">
            <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Compatible
            </h3>
            <ul className="space-y-0.5">
              {compatible.map((item) => (
                <li key={item} className="font-mono text-[12.5px] text-[var(--dt-string)]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Properties
          </h3>
          <button
            type="button"
            onClick={() => copy("json", JSON.stringify(toJson(node), null, 2))}
            className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            {copied === "json" ? <Check className="size-3" /> : <Copy className="size-3" />}
            JSON
          </button>
        </div>

        {node.properties.length === 0 ? (
          <p className="mb-4 text-sm text-muted-foreground">No properties.</p>
        ) : (
          <dl className="mb-4 space-y-2">
            {node.properties.map((property) => (
              <div key={`${property.name}-${property.line}`} className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-2">
                <dt
                  className={cn(
                    "font-mono text-[12px] leading-5 break-words text-muted-foreground",
                    property.deleted && "line-through",
                  )}
                >
                  <button type="button" onClick={() => onJump(property.line)} className="text-left hover:text-foreground">
                    {property.name}
                  </button>
                  {property.fromOverlay ? (
                    <span className="mt-0.5 block text-[10px] tracking-normal text-primary normal-case">
                      overlay
                    </span>
                  ) : null}
                  {property.deleted ? (
                    <span className="mt-0.5 block text-[10px] text-destructive normal-case">deleted</span>
                  ) : null}
                </dt>
                <dd className="min-w-0">
                  {property.boolean ? (
                    <span className="font-mono text-[12px] text-[var(--dt-ok)]">true</span>
                  ) : (
                    <ValueView
                      parts={property.parts}
                      boolean={property.boolean}
                      deleted={property.deleted}
                      onRef={onRef}
                      isKnown={isKnown}
                    />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {children.length > 0 ? (
          <div className="mb-4">
            <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Children
            </h3>
            <div className="flex flex-wrap gap-1">
              {children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onSelect(child.path)}
                  className={cn(
                    "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent",
                    child.deleted && "line-through opacity-60",
                  )}
                >
                  {child.fullName}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {referenced.length > 0 ? (
          <div>
            <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Referenced by
            </h3>
            <ul className="space-y-1">
              {referenced.map((site) => (
                <li key={`${site.from.id}-${site.property}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(site.from.path)}
                    className="text-left font-mono text-[12px] text-[var(--dt-ref)] hover:underline"
                  >
                    {site.from.path}
                    <span className="text-muted-foreground"> · {site.property}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {copied === "failed" ? (
          <p className="mt-3 text-xs text-destructive">Could not copy to the clipboard.</p>
        ) : null}
      </div>
    </section>
  );
}

function incomingFor(node: DtNode, index: DtIndex) {
  const sites = [
    ...node.labels.flatMap((label) => index.incoming.get(label) ?? []),
    ...(index.incoming.get(node.path) ?? []),
  ];
  const seen = new Set<string>();
  return sites.filter((site) => {
    const key = `${site.from.path}:${site.property}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return site.from.path !== node.path;
  });
}
