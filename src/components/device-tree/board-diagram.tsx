"use client";

import { layoutDiagram, type BoardDiagram } from "@/lib/dts/diagram";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

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
  const scroller = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const pan = useRef({ x: 0, y: 0, left: 0, top: 0, moved: false });
  const panned = useRef(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = zoomRef.current;
      const next = clampZoom(current + (event.deltaY < 0 ? 0.15 : -0.15));
      if (next === current) return;
      const rect = el.getBoundingClientRect();
      const anchorX = event.clientX - rect.left + el.scrollLeft;
      const anchorY = event.clientY - rect.top + el.scrollTop;
      const ratio = next / current;
      zoomRef.current = next;
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = anchorX * ratio - (event.clientX - rect.left);
        el.scrollTop = anchorY * ratio - (event.clientY - rect.top);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [laid.nodes.length]);

  if (laid.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This tree has no controllers or board parts to draw.
      </p>
    );
  }

  function zoomBy(delta: number) {
    const el = scroller.current;
    const current = zoomRef.current;
    const next = clampZoom(current + delta);
    if (next === current) return;
    if (el) {
      const anchorX = el.scrollLeft + el.clientWidth / 2;
      const anchorY = el.scrollTop + el.clientHeight / 2;
      const ratio = next / current;
      requestAnimationFrame(() => {
        el.scrollLeft = anchorX * ratio - el.clientWidth / 2;
        el.scrollTop = anchorY * ratio - el.clientHeight / 2;
      });
    }
    zoomRef.current = next;
    setZoom(next);
  }

  function resetView() {
    zoomRef.current = 1;
    setZoom(1);
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5">
        <p className="text-[11px] text-muted-foreground">
          Scroll left, right, up, and down. Ctrl and the wheel zooms.
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomBy(-0.25)}
          >
            <Minus />
          </Button>
          <Button type="button" variant="ghost" size="xs" aria-label="Reset zoom" onClick={resetView}>
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomBy(0.25)}
          >
            <Plus />
          </Button>
        </div>
      </div>

      <div
        ref={scroller}
        tabIndex={0}
        aria-label="Block diagram viewer"
        className="h-72 cursor-grab overflow-auto overscroll-contain outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing sm:h-80 lg:h-96"
        onKeyDown={(event) => {
          if (event.target !== scroller.current) return;
          const el = scroller.current;
          if (!el) return;
          const step = event.shiftKey ? 120 : 48;
          if (event.key === "ArrowLeft") el.scrollLeft -= step;
          else if (event.key === "ArrowRight") el.scrollLeft += step;
          else if (event.key === "ArrowUp") el.scrollTop -= step;
          else if (event.key === "ArrowDown") el.scrollTop += step;
          else if (event.key === "+" || event.key === "=") zoomBy(0.25);
          else if (event.key === "-" || event.key === "_") zoomBy(-0.25);
          else if (event.key === "0") resetView();
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest("[role=button]")) return;
          const el = scroller.current;
          if (!el) return;
          panned.current = false;
          pan.current = {
            x: event.clientX,
            y: event.clientY,
            left: el.scrollLeft,
            top: el.scrollTop,
            moved: false,
          };
          el.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const el = scroller.current;
          if (!el || !el.hasPointerCapture(event.pointerId)) return;
          const dx = event.clientX - pan.current.x;
          const dy = event.clientY - pan.current.y;
          if (!pan.current.moved && Math.hypot(dx, dy) < 4) return;
          pan.current.moved = true;
          el.scrollLeft = pan.current.left - dx;
          el.scrollTop = pan.current.top - dy;
        }}
        onPointerUp={(event) => {
          const el = scroller.current;
          if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
          if (pan.current.moved) panned.current = true;
          pan.current.moved = false;
        }}
        onClickCapture={(event) => {
          if (!panned.current) return;
          panned.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="relative" style={{ width: laid.width * zoom, height: laid.height * zoom }}>
          <svg
            viewBox={`0 0 ${laid.width} ${laid.height}`}
            width={laid.width}
            height={laid.height}
            role="img"
            aria-label="Block diagram of the chip and the parts on the board"
            className="absolute top-0 left-0 origin-top-left text-foreground"
            style={{ transform: `scale(${zoom})` }}
          >
            <defs>
              <marker id="dt-arrow" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="7" refY="4" orient="auto">
                <path d="M0 0 L8 4 L0 8 Z" className="fill-foreground" />
              </marker>
              <marker
                id="dt-arrow-start"
                viewBox="0 0 8 8"
                markerWidth="7"
                markerHeight="7"
                refX="1"
                refY="4"
                orient="auto-start-reverse"
              >
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
        </div>
      </div>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Yellow blocks sit on the chip. Green blocks are parts on the board. A dashed block is switched off. Click a block to open it.
      </p>
    </div>
  );
}

function clampZoom(value: number): number {
  const stepped = Math.round(value * 100) / 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stepped));
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
