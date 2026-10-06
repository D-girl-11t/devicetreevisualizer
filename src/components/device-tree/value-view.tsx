import { formatRef } from "@/lib/dts/format";
import type { DtRef, DtValuePart } from "@/lib/dts/types";
import { cn } from "cn";

export function ValueView({
  parts,
  boolean,
  deleted,
  onRef,
  isKnown,
}: {
  parts: DtValuePart[];
  boolean: boolean;
  deleted?: boolean;
  onRef: (ref: DtRef) => void;
  isKnown: (ref: DtRef) => boolean;
}) {
  if (boolean) return null;
  if (parts.length === 0) {
    return <span className="text-muted-foreground">(empty)</span>;
  }

  return (
    <span className={cn("font-mono text-[12.5px] leading-5 break-all", deleted && "line-through")}>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? <span className="text-muted-foreground">, </span> : null}
          <PartView part={part} onRef={onRef} isKnown={isKnown} />
        </span>
      ))}
    </span>
  );
}

function PartView({
  part,
  onRef,
  isKnown,
}: {
  part: DtValuePart;
  onRef: (ref: DtRef) => void;
  isKnown: (ref: DtRef) => boolean;
}) {
  if (part.kind === "string") {
    return <span className="text-[var(--dt-string)]">{JSON.stringify(part.value)}</span>;
  }
  if (part.kind === "phandle") {
    return <RefButton dtRef={part.ref} onRef={onRef} known={isKnown(part.ref)} />;
  }
  if (part.kind === "incbin") {
    const args = [JSON.stringify(part.file), part.offset, part.size].filter(Boolean).join(", ");
    return <span className="text-[var(--dt-symbol)]">/incbin/({args})</span>;
  }
  if (part.kind === "bytes") {
    const hex = part.bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    return (
      <span>
        {part.bits && part.bits !== 32 ? (
          <span className="text-muted-foreground">/bits/ {part.bits} </span>
        ) : null}
        <span className="text-[var(--dt-num)]">[{hex}]</span>
      </span>
    );
  }

  return (
    <span>
      {part.bits && part.bits !== 32 ? (
        <span className="text-muted-foreground">/bits/ {part.bits} </span>
      ) : null}
      <span className="text-muted-foreground">&lt;</span>
      {part.cells.map((cell, index) => (
        <span key={index}>
          {index > 0 ? " " : null}
          {cell.kind === "number" ? (
            <span className="text-[var(--dt-num)]">{cell.raw}</span>
          ) : null}
          {cell.kind === "symbol" ? (
            <span className="text-[var(--dt-symbol)]">{cell.name}</span>
          ) : null}
          {cell.kind === "expr" ? (
            <span className="text-[var(--dt-symbol)]">{cell.raw}</span>
          ) : null}
          {cell.kind === "ref" ? (
            <RefButton dtRef={cell.ref} onRef={onRef} known={isKnown(cell.ref)} />
          ) : null}
        </span>
      ))}
      <span className="text-muted-foreground">&gt;</span>
    </span>
  );
}

function RefButton({
  dtRef,
  known,
  onRef,
}: {
  dtRef: DtRef;
  known: boolean;
  onRef: (ref: DtRef) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onRef(dtRef)}
      className={cn(
        "rounded-sm px-0.5 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        known ? "text-[var(--dt-ref)]" : "text-destructive",
      )}
      title={known ? `Show ${formatRef(dtRef)}` : `${formatRef(dtRef)} does not match a node`}
    >
      {formatRef(dtRef)}
    </button>
  );
}
