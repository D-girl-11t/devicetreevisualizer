# Device Tree Visualizer

Browse a device tree the way you read a board schematic. Paste source, open a `.dts` / `.dtsi` file, or drop a compiled `.dtb`. The tree on the right is the parsed node hierarchy; the inspector lists properties, labels, and the phandles that point at the node you select.

Three boards are built in: a Halcyon HC1 evaluation board, a cape overlay that merges fragments into that tree, and a minimal example.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

```bash
npm test
npm run lint
```

## What it understands

- Nodes, unit addresses, and labels
- Boolean, string, cell, and byte-array properties
- Phandle references (`&label` and `&{/path}`)
- `/bits/`, `/incbin/`, `/memreserve/`, and `/plugin/`
- Overlay fragments merged onto the base tree, including `/delete-node/` and `/delete-property/`
- `/omit-if-no-ref/`
- Flattened device tree blobs (magic `0xd00dfeed`), decompiled with a string-versus-cell heuristic

`#include`, `#define`, and `#if` are reported and skipped. They are not expanded. For a macro-heavy board, preprocess first (for example `cpp -nostdinc -I include -undef -x assembler-with-cpp board.dts`) and paste the result. `/include/` directives are skipped the same way.

Cell expressions such as `(1 << 5)` are kept as text and are not evaluated. Symbolic cell values left behind by an unexpanded `#define` stay as names, so `GPIO_ACTIVE_LOW` is visible even when its number is not.

## Limits

- Binary blobs are big-endian FDT only. A byte-swapped magic (`0xedfe0dd0`) is rejected with an explanation.
- Decompiled properties are guessed: null-terminated printable data becomes strings, 4-byte-aligned data becomes cells, and everything else becomes a byte array.
- Sources larger than 2 MB, and blobs larger than 5 MB, are refused.
