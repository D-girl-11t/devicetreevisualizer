"use client";

import { layoutDiagram, type BoardDiagram } from "@/lib/dts/diagram";
import { cn } from "cn";

export function BoardDiagramView({
  diagram,
  selectedPath,
  onSelect,
}: {
  diagram: BoardDiagram;
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const laid = layoutDiagram(diagram);
  if (laid.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This tree has no controllers or board parts to draw.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <svg
        viewBox={`0 0 ${laid.width} ${laid.height}`}
        role="img"
        aria-label="Block diagram of the chip and the parts on the board"
        className="h-auto w-full min-w-[680px] text-foreground"
      >
        <defs>
          <marker id="dt-arrow" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto">
            <path d="M0 0 L8 4 L0 8 Z" className="fill-foreground" />
          </marker>
          <marker id="dt-arrow-start" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="1" refY="4" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 Z" className="fill-foreground" />
          </marker>
        </defs>

        <rect
          x={laid.soc.x}
          y={laid.soc.y}
          width={laid.soc.w}
          height={laid.soc.h}
          rx={8}
          style={{
            fill: "color-mix(in oklch, var(--muted) 88%, var(--background))",
            stroke: "var(--foreground)",
          }}
          strokeWidth={1.4}
        />
        <text
          x={laid.soc.x + laid.soc.w - 12}
          y={laid.soc.y + laid.soc.h - 10}
          textAnchor="end"
          className="fill-foreground text-[13px]"
        >
          {laid.soc.label}
        </text>

        {laid.edges.map((edge) => (
          <line
            key={`${edge.from}-${edge.to}`}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            stroke="currentColor"
            strokeWidth={1.4}
            markerStart="url(#dt-arrow-start)"
            markerEnd="url(#dt-arrow)"
          />
        ))}

        {laid.nodes.map((node) => {
          const selected = node.path !== null && node.path === selectedPath;
          return (
            <g
              key={node.id}
              role={node.path ? "button" : undefined}
              tabIndex={node.path ? 0 : undefined}
              className={cn(node.path && "cursor-pointer")}
              onClick={() => {
                if (node.path) onSelect(node.path);
              }}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && node.path) {
                  event.preventDefault();
                  onSelect(node.path);
                }
              }}
            >
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx={4}
                strokeWidth={selected ? 2.5 : 1.4}
                strokeDasharray={node.enabled ? undefined : "5 3"}
                style={{
                  fill: fillFor(node.role, node.enabled),
                  stroke: selected ? "var(--primary)" : node.enabled ? strokeFor(node.role) : "var(--dt-off)",
                }}
              />
              <text
                x={node.x + node.w / 2}
                y={node.y + (node.subtitle ? 20 : 28)}
                textAnchor="middle"
                className="fill-foreground text-[12px] font-medium"
              >
                {node.title}
              </text>
              {node.subtitle ? (
                <text
                  x={node.x + node.w / 2}
                  y={node.y + 36}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {node.subtitle}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Yellow blocks sit on the chip. Green blocks are parts on the board. A dashed block is switched off. Click a block to open it.
      </p>
    </div>
  );
}

function fillFor(role: "cpu" | "soc" | "board", enabled: boolean): string {
  if (!enabled) return "color-mix(in oklch, var(--muted) 70%, var(--card))";
  if (role === "cpu") return "color-mix(in oklch, var(--dt-ref) 55%, var(--card))";
  if (role === "board") return "color-mix(in oklch, var(--dt-ok) 42%, var(--card))";
  return "color-mix(in oklch, var(--dt-string) 48%, var(--card))";
}

function strokeFor(role: "cpu" | "soc" | "board"): string {
  if (role === "cpu") return "var(--dt-ref)";
  if (role === "board") return "var(--dt-ok)";
  return "color-mix(in oklch, var(--dt-string) 80%, var(--foreground))";
}
