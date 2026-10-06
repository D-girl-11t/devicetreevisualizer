"use client";

import { BoardDiagramView } from "@/components/device-tree/board-diagram";
import type { BoardBrief } from "@/lib/dts/brief";
import type { BoardDiagram } from "@/lib/dts/diagram";
import { formatAddress, formatSize, type MapRegion, type MemoryMap } from "@/lib/dts/memory-map";
import { cn } from "cn";

export function BoardPanel({
  brief,
  diagram,
  map,
  selectedPath,
  onSelect,
}: {
  brief: BoardBrief;
  diagram: BoardDiagram;
  map: MemoryMap;
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const ram = map.regions.filter((region) => region.kind === "ram" && placed(region));
  const carried = map.regions.filter(
    (region) => (region.kind === "reserved" || region.kind === "memreserve" || region.kind === "pool") && placed(region),
  );
  const floating = map.regions.filter((region) => region.kind === "pool" && region.start === null);
  const mmio = map.regions.filter((region) => region.kind === "mmio" && placed(region));
  const devices = cluster(mmio);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 px-3 py-3 sm:px-4">
        <div>
          <h2 className="text-sm font-medium">Board</h2>
          <p className="text-xs text-muted-foreground">
            The chip in the middle, the parts wired to it, then what is on, off, and worth building.
          </p>
        </div>

        <BoardDiagramView diagram={diagram} selectedPath={selectedPath} onSelect={onSelect} />

        <BriefBlock label="The board" text={brief.board} />
        <BriefBlock label="Pins" text={brief.pins} />
        <BriefBlock label="Not activated" text={brief.inactive} />
        <BriefBlock label="What you can build" text={brief.scope} />

        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Memory map</h3>
            <p className="font-mono text-[11px] text-muted-foreground">
              {ram.length} RAM · {mmio.length} register windows
            </p>
          </div>
          <Legend />
          {ram.length === 0 && mmio.length === 0 && floating.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No memory node and no sized register window. An I2C chip address is not a place in this map.
            </p>
          ) : null}
          {ram.map((host) => (
            <Bar
              key={host.id}
              label="RAM"
              spanStart={host.start!}
              spanEnd={host.start! + host.size!}
              regions={[host, ...carried.filter((region) => contains(host, region))]}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {floating.map((region) => (
            <p key={region.id} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{region.title}</span> reserves{" "}
              {region.size !== null ? formatSize(region.size) : "an unknown size"} with no fixed address.
              {region.detail ? ` ${region.detail}.` : ""}
            </p>
          ))}
          {devices.map((group, index) => (
            <Bar
              key={`mmio-${index}`}
              label={devices.length > 1 ? `Devices ${index + 1}` : "Devices"}
              spanStart={group.start}
              spanEnd={group.end}
              regions={group.regions}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
          {map.notes.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-[var(--dt-string)]">
              {map.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          <RegionTable regions={map.regions} selectedPath={selectedPath} onSelect={onSelect} />
        </div>
      </div>
    </section>
  );
}

function BriefBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>
      <p className="mt-1 text-sm leading-relaxed">{text}</p>
    </div>
  );
}

function Legend() {
  const items: { kind: string; label: string; className: string }[] = [
    { kind: "ram", label: "RAM", className: "bg-[var(--dt-ref)]" },
    { kind: "reserved", label: "Reserved", className: "bg-[var(--dt-string)]" },
    { kind: "on", label: "On", className: "bg-[var(--dt-ok)]" },
    { kind: "off", label: "Off", className: "bg-[var(--dt-off)]" },
  ];
  return (
    <ul className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      {items.map((item) => (
        <li key={item.kind} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-sm", item.className)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Bar({
  label,
  spanStart,
  spanEnd,
  regions,
  selectedPath,
  onSelect,
}: {
  label: string;
  spanStart: bigint;
  spanEnd: bigint;
  regions: MapRegion[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const span = spanEnd > spanStart ? spanEnd - spanStart : 1n;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 font-mono text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span>
          {formatAddress(spanStart)} – {formatAddress(spanEnd - 1n)}
        </span>
      </div>
      <div className="relative h-11 overflow-hidden rounded-md bg-muted">
        {regions.map((region) => {
          const start = region.start ?? spanStart;
          const size = region.size ?? 0n;
          const left = percent(start - spanStart, span);
          const width = Math.max(percent(size, span), 1.2);
          const selected = region.path !== null && region.path === selectedPath;
          return (
            <button
              key={region.id}
              type="button"
              title={`${region.title} ${region.start !== null ? formatAddress(region.start) : ""} ${region.size !== null ? formatSize(region.size) : ""}`}
              disabled={region.path === null}
              onClick={() => {
                if (region.path) onSelect(region.path);
              }}
              className={cn(
                "absolute top-1 bottom-1 rounded-sm border border-background/40 text-left",
                swatch(region),
                region.path === null && "cursor-default",
                selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
              )}
              style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

function RegionTable({
  regions,
  selectedPath,
  onSelect,
}: {
  regions: MapRegion[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  if (regions.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b text-[11px] text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">Address</th>
            <th className="py-1.5 pr-3 font-medium">Size</th>
            <th className="py-1.5 pr-3 font-medium">Node</th>
            <th className="py-1.5 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {regions.map((region) => {
            const selected = region.path !== null && region.path === selectedPath;
            return (
              <tr key={region.id} className={cn("border-b border-border/70", selected && "bg-primary/10")}>
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                  {region.start !== null ? formatAddress(region.start) : "—"}
                </td>
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">
                  {region.size !== null ? formatSize(region.size) : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  {region.path ? (
                    <button type="button" className="text-left hover:underline" onClick={() => onSelect(region.path!)}>
                      {region.title}
                    </button>
                  ) : (
                    region.title
                  )}
                  {region.detail ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{region.detail}</span> : null}
                  {region.overlaps.length > 0 ? (
                    <span className="mt-0.5 block text-[11px] text-[var(--dt-string)]">
                      Overlaps {region.overlaps.join(", ")}
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 whitespace-nowrap">{stateLabel(region)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function stateLabel(region: MapRegion): string {
  if (region.kind === "ram") return "RAM";
  if (region.kind === "memreserve" || region.kind === "reserved") return "Reserved";
  if (region.kind === "pool") return "Pool";
  return region.enabled ? "On" : "Off";
}

function swatch(region: MapRegion): string {
  if (region.kind === "ram") return "bg-[var(--dt-ref)]/80";
  if (region.kind === "reserved" || region.kind === "memreserve") return "z-[1] bg-[var(--dt-string)]";
  if (region.kind === "pool") return "z-[1] bg-[var(--dt-symbol)]";
  if (!region.enabled) return "bg-[var(--dt-off)]/80";
  return "bg-[var(--dt-ok)]/85";
}

function placed(region: MapRegion): region is MapRegion & { start: bigint; size: bigint } {
  return region.start !== null && region.size !== null && region.size > 0n;
}

function contains(host: MapRegion, region: MapRegion): boolean {
  if (!placed(host) || !placed(region)) return false;
  return region.start >= host.start && region.start < host.start + host.size;
}

function cluster(regions: MapRegion[]): { start: bigint; end: bigint; regions: MapRegion[] }[] {
  const sorted = [...regions].sort((a, b) => (a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : 0));
  const groups: { start: bigint; end: bigint; regions: MapRegion[] }[] = [];
  for (const region of sorted) {
    const end = region.start! + region.size!;
    const last = groups[groups.length - 1];
    if (!last) {
      groups.push({ start: region.start!, end, regions: [region] });
      continue;
    }
    const span = last.end - last.start;
    const gap = region.start! - last.end;
    if (gap > 0n && gap > span * 4n && gap > 0x10000n) {
      groups.push({ start: region.start!, end, regions: [region] });
    } else {
      if (end > last.end) last.end = end;
      last.regions.push(region);
    }
  }
  return groups;
}

function percent(part: bigint, whole: bigint): number {
  if (part <= 0n || whole <= 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}
