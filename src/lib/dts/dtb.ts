const FDT_MAGIC = 0xd00dfeed;
const FDT_SWAPPED_MAGIC = 0xedfe0dd0;
const FDT_BEGIN_NODE = 0x1;
const FDT_END_NODE = 0x2;
const FDT_PROP = 0x3;
const FDT_NOP = 0x4;
const FDT_END = 0x9;
const MAX_DTB_BYTES = 5_000_000;

export function isDtb(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = readU32(bytes, 0);
  return magic === FDT_MAGIC || magic === FDT_SWAPPED_MAGIC;
}

export function decompileDtb(bytes: Uint8Array): string {
  if (bytes.length > MAX_DTB_BYTES) {
    throw new Error("Device tree blob is larger than 5 MB.");
  }
  if (bytes.length < 4) {
    throw new Error("File is too small to be a device tree blob.");
  }

  const magic = readU32(bytes, 0);
  if (magic === FDT_SWAPPED_MAGIC) {
    throw new Error(
      "This blob is byte-swapped (magic 0xedfe0dd0). Export a big-endian FDT instead.",
    );
  }
  if (bytes.length < 28) {
    throw new Error("File is too small to be a device tree blob.");
  }
  if (magic !== FDT_MAGIC) {
    throw new Error("Not a flattened device tree. The magic number is not 0xd00dfeed.");
  }

  const totalsize = readU32(bytes, 4);
  const offStruct = readU32(bytes, 8);
  const offStrings = readU32(bytes, 12);
  const offReserve = readU32(bytes, 16);
  if (totalsize < 28 || totalsize > bytes.length) {
    throw new Error("Header totalsize does not match the file.");
  }
  if (
    offStruct >= bytes.length ||
    offStrings >= bytes.length ||
    offReserve >= bytes.length
  ) {
    throw new Error("Header offsets point outside the file.");
  }

  let text = "/dts-v1/;\n";
  let reserve = offReserve;
  while (reserve + 16 <= bytes.length) {
    const address = readU64(bytes, reserve);
    const size = readU64(bytes, reserve + 8);
    reserve += 16;
    if (address === 0n && size === 0n) break;
    text += `/memreserve/ ${hexBig(address)} ${hexBig(size)};\n`;
  }
  text += "\n";

  let offset = offStruct;
  let depth = 0;
  while (offset + 4 <= bytes.length) {
    const token = readU32(bytes, offset);
    offset += 4;
    if (token === FDT_BEGIN_NODE) {
      const name = readCString(bytes, offset);
      offset = align4(name.next);
      const indent = "    ".repeat(depth);
      if (depth === 0) {
        text += "/ {\n";
        if (name.text && name.text !== "/") {
          text += `    /* blob root name: ${name.text} */\n`;
        }
      } else {
        text += `${indent}${name.text} {\n`;
      }
      depth += 1;
      continue;
    }
    if (token === FDT_END_NODE) {
      depth -= 1;
      if (depth < 0) throw new Error("Device tree blob closed a node that was not open.");
      text += `${"    ".repeat(depth)}};\n`;
      continue;
    }
    if (token === FDT_PROP) {
      if (offset + 8 > bytes.length) throw new Error("Truncated property header in the blob.");
      const length = readU32(bytes, offset);
      const nameOffset = readU32(bytes, offset + 4);
      offset += 8;
      if (length > bytes.length || offset + length > bytes.length) {
        throw new Error("Property value runs past the end of the blob.");
      }
      const data = bytes.subarray(offset, offset + length);
      offset = align4(offset + length);
      const nameStart = offStrings + nameOffset;
      if (nameStart < 0 || nameStart >= bytes.length) {
        throw new Error("Property name points outside the strings block.");
      }
      const name = readCString(bytes, nameStart).text;
      if (!name) throw new Error("Property name in the blob is empty.");
      text += `${"    ".repeat(depth)}${formatProperty(name, data)}\n`;
      continue;
    }
    if (token === FDT_NOP) continue;
    if (token === FDT_END) break;
    throw new Error(
      `Unknown structure token 0x${token.toString(16)} at byte ${offset - 4}.`,
    );
  }

  if (depth !== 0) {
    throw new Error("Device tree blob ended before the root node closed.");
  }
  return text;
}

function formatProperty(name: string, data: Uint8Array): string {
  if (data.length === 0) return `${name};`;
  if (looksLikeStrings(data)) {
    return `${name} = ${splitStrings(data).map(quoteDts).join(", ")};`;
  }
  if (data.length % 4 === 0) {
    const cells: string[] = [];
    for (let index = 0; index < data.length; index += 4) {
      cells.push(hex32(readU32(data, index)));
    }
    return `${name} = <${cells.join(" ")}>;`;
  }
  const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return `${name} = [${hex}];`;
}

function looksLikeStrings(data: Uint8Array): boolean {
  if (data.length === 0 || data[data.length - 1] !== 0) return false;
  let printable = false;
  for (const byte of data) {
    if (byte === 0) continue;
    if (byte < 0x20 || byte > 0x7e) return false;
    printable = true;
  }
  return printable;
}

function splitStrings(data: Uint8Array): string[] {
  const parts: string[] = [];
  let current = "";
  for (const byte of data) {
    if (byte === 0) {
      parts.push(current);
      current = "";
    } else {
      current += String.fromCharCode(byte);
    }
  }
  return parts;
}

function quoteDts(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

function readCString(bytes: Uint8Array, offset: number): { text: string; next: number } {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end >= bytes.length) throw new Error("Unterminated string in the device tree blob.");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(offset, end));
  return { text, next: end + 1 };
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error("Unexpected end of the device tree blob.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, false);
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new Error("Unexpected end of the device tree blob.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(offset, false);
}

function align4(offset: number): number {
  return (offset + 3) & ~3;
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}

function hexBig(value: bigint): string {
  return `0x${value.toString(16)}`;
}
