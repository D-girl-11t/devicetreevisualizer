"use client";

import type { BringupBoard, BringupLink } from "@/lib/dts/bringup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";
import { Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

type Focus = "all" | "warn" | "enabled" | "disabled";

const focuses: { id: Focus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "warn", label: "Needs a look" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
];

export function BringupPanel({
  board,
  selectedPath,
  onSelect,
  onInspect,
}: {
  board: BringupBoard;
  selectedPath: string;
  onSelect: (path: string) => void;
  onInspect: () => void;
}) {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Focus>("all");
  const warnings = board.links.reduce(
    (count, link) => count + link.notes.filter((note) => note.tone === "warn").length,
    0,
  );

  const links = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return board.links.filter((link) => {
      if (focus === "warn" && !link.notes.some((note) => note.tone === "warn")) return false;
      if (focus === "enabled" && (link.deleted || link.status === "disabled")) return false;
      if (focus === "disabled" && link.status !== "disabled") return false;
      if (!needle) return true;
      const haystack = [
        link.title,
        link.path,
        link.label ?? "",
        link.userspace,
        link.kernel.driver,
        link.kernel.config ?? "",
        link.kernel.subsystem,
        ...link.compatible,
        ...link.aliases,
        ...link.pins,
        ...link.supplies,
        ...link.notes.map((note) => note.message),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [board.links, focus, query]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium">Pin to program</h2>
            <p className="text-xs text-muted-foreground">
              Predicted from this tree. A live board still has to show the same devices in dmesg and /dev.
            </p>
          </div>
          <span className="shrink-0 font-mono text-[11px] text-[var(--dt-string)]">
            {warnings} {warnings === 1 ? "gap" : "gaps"}
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onValueChange={setQuery}
            placeholder="Filter by pin, driver, alias, or /dev node"
            aria-label="Filter the bring-up path"
            className="pl-7"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {focuses.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="xs"
              variant={focus === item.id ? "secondary" : "ghost"}
              onClick={() => setFocus(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <BoardSummary board={board} />
        {links.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            Nothing in this tree matches that filter.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {links.map((link) => (
              <li key={`${link.path}-${link.deleted ? "gone" : "live"}`}>
                <BringupCard
                  link={link}
                  selected={link.path === selectedPath}
                  onSelect={() => onSelect(link.path)}
                  onInspect={onInspect}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function BoardSummary({ board }: { board: BringupBoard }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">BSP contract</p>
      <p className="mt-1 text-sm font-medium">{board.model ?? "Untitled board"}</p>
      <dl className="mt-2 space-y-1 font-mono text-[11px] leading-4 text-muted-foreground">
        {board.stdout ? (
          <div>
            <span className="text-[var(--dt-string)]">stdout</span> {board.stdout}
          </div>
        ) : null}
        {board.bootargs ? <div className="break-words">{board.bootargs}</div> : null}
        {board.memory.map((line) => (
          <div key={line}>
            <span className="text-[var(--dt-num)]">memory</span> {line}
          </div>
        ))}
        {board.reserved.map((line) => (
          <div key={line}>
            <span className="text-[var(--dt-symbol)]">reserved</span> {line}
          </div>
        ))}
        {board.cpus > 0 ? <div>{board.cpus} cpus</div> : null}
      </dl>
      {board.aliases.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {board.aliases.map((alias) => (
            <span
              key={alias.name}
              className={cn(
                "rounded-md bg-background px-1.5 py-0.5 font-mono text-[10px]",
                alias.missing || alias.status === "disabled" ? "text-[var(--dt-off)]" : "text-foreground",
              )}
            >
              {alias.name}
              {alias.title ? ` → ${alias.title}` : " missing"}
              {alias.status === "disabled" ? " disabled" : ""}
            </span>
          ))}
        </div>
      ) : null}
      {board.unresolved.length > 0 ? (
        <p className="mt-2 text-xs text-[var(--dt-string)]">
          Unresolved overlay {board.unresolved.join(", ")}. Those fragments never merged.
        </p>
      ) : null}
    </div>
  );
}

function BringupCard({
  link,
  selected,
  onSelect,
  onInspect,
}: {
  link: BringupLink;
  selected: boolean;
  onSelect: () => void;
  onInspect: () => void;
}) {
  const warn = link.notes.some((note) => note.tone === "warn");
  return (
    <article
      className={cn(
        "rounded-lg border px-2.5 py-2",
        selected ? "border-primary/40 bg-primary/10" : "bg-card/40",
        warn && "border-l-[3px] border-l-[var(--dt-string)]",
        link.deleted && "opacity-70",
      )}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-2 text-left">
        <span
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            link.deleted
              ? "bg-muted-foreground/40"
              : link.status === "disabled"
                ? "bg-[var(--dt-off)]"
                : "bg-[var(--dt-ok)]",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={cn("font-medium", link.deleted && "line-through")}>{link.title}</span>
            {link.label ? <span className="font-mono text-[11px] text-[var(--dt-ref)]">&{link.label}</span> : null}
            {link.aliases.map((alias) => (
              <span key={alias} className="font-mono text-[11px] text-muted-foreground">
                {alias}
              </span>
            ))}
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
              {link.deleted ? "removed" : link.status ?? "okay"}
            </span>
          </span>
        </span>
      </button>

      <div className="mt-2 space-y-1.5 pl-3.5">
        <Stage label="Pins" tone="text-[var(--dt-ok)]">
          {link.pins.length > 0 ? link.pins.join("  ·  ") : "—"}
          {link.supplies.length > 0 ? <span className="text-muted-foreground"> · {link.supplies.join(", ")}</span> : null}
        </Stage>
        <Stage label="Tree" tone="text-[var(--dt-ref)]">
          <span className="font-mono text-[12px]">
            {link.compatible.length > 0 ? link.compatible.join(", ") : link.path}
          </span>
          <span className="text-muted-foreground">
            {[link.reg ? `reg ${link.reg}` : null, link.interrupt ? `irq ${link.interrupt}` : null, link.clocks.length ? `clk ${link.clocks.join(", ")}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </Stage>
        <Stage label="Kernel" tone="text-[var(--dt-symbol)]">
          <span>{link.kernel.driver}</span>
          {link.kernel.config ? (
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">{link.kernel.config}</span>
          ) : null}
        </Stage>
        <Stage label="Userspace" tone="text-[var(--dt-string)]">
          <span className="font-mono text-[12px]">{link.userspace}</span>
        </Stage>
        {link.notes.map((note) => (
          <p
            key={note.message}
            className={cn("text-xs leading-4", note.tone === "warn" ? "text-[var(--dt-string)]" : "text-muted-foreground")}
          >
            {note.message}
          </p>
        ))}
      </div>
      <div className="mt-2 flex justify-end lg:hidden">
        <Button type="button" size="xs" variant="secondary" onClick={onInspect}>
          Inspect
        </Button>
      </div>
    </article>
  );
}

function Stage({
  label,
  tone,
  children,
}: {
  label: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4.6rem_minmax(0,1fr)] gap-2">
      <div className={cn("pt-0.5 text-[10px] font-semibold tracking-wide uppercase", tone)}>{label}</div>
      <div className="min-w-0 text-[12.5px] leading-5 break-words">{children}</div>
    </div>
  );
}
