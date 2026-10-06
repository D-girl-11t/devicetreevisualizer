import { describe, expect, test } from "vitest";
import { compileDtb } from "./compile";
import { decompileDtb } from "./dtb";
import { proposeEdits } from "./edits";
import { propertyByName, stringValues } from "./format";
import { parseDts } from "./parse";
import { storeTree, type SavedTree } from "./saved";
import type { DtNode } from "./types";
import { examples } from "./samples";

const halcyon = examples.find((item) => item.id === "halcyon");
if (!halcyon) throw new Error("halcyon");

describe("guided edits", () => {
  test("adds an external temperature sensor as one reviewable step", () => {
    const doc = parseDts(halcyon.source);
    const plan = proposeEdits("Add a temperature sensor connected externally", doc);
    expect(plan.note).toBeNull();
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0].title).toContain("ext-temp@49");
    expect(plan.edits[0].title).toContain("i2c1");

    const next = plan.edits[0].apply(halcyon.source);
    const parsed = parseDts(next);
    const sensor = findName(parsed.root, "ext-temp@49");
    expect(sensor).toBeTruthy();
    expect(next).toContain('compatible = "ti,tmp102"');
    expect(next).toContain("reg = <0x49>");
    expect(findName(parsed.root, "temp@48")).toBeTruthy();
  });

  test("enables uart0 through its alias", () => {
    const doc = parseDts(halcyon.source);
    const plan = proposeEdits("enable serial0", doc);
    expect(plan.edits).toHaveLength(1);
    const next = plan.edits[0].apply(halcyon.source);
    const uart = findName(parseDts(next).root, "serial@a40000");
    expect(stringValues(propertyByName(uart!, "status"))).toEqual(["okay"]);
  });
});

describe("saved trees", () => {
  test("keeps five and refuses a sixth new name", () => {
    let trees: SavedTree[] = [];
    for (let index = 0; index < 5; index += 1) {
      const stored = storeTree(trees, { id: String(index), name: `board ${index}`, source: "x", savedAt: index });
      expect(stored.error).toBeNull();
      trees = stored.trees;
    }
    const sixth = storeTree(trees, { id: "6", name: "another", source: "y", savedAt: 6 });
    expect(sixth.error).toMatch(/5/);
    expect(sixth.trees).toHaveLength(5);
    const updated = storeTree(trees, { id: "new", name: "board 0", source: "replaced", savedAt: 9 });
    expect(updated.error).toBeNull();
    expect(updated.trees).toHaveLength(5);
    expect(updated.trees.find((tree) => tree.name === "board 0")?.source).toBe("replaced");
  });
});

describe("dtb download", () => {
  test("compiles Halcyon and decompiles the model back", () => {
    const doc = parseDts(halcyon.source);
    const blob = compileDtb(doc);
    const text = decompileDtb(blob);
    expect(text).toContain("Halcyon HC1 Evaluation Board");
    expect(text).toContain("serial@a41000");
    expect(text).toContain("/memreserve/ 0x88000000 0x10000");
    const again = parseDts(text);
    expect(again.errors).toEqual([]);
  });

  test("refuses a symbolic cell", () => {
    expect(() => compileDtb(parseDts("/dts-v1/;\n\n/ {\n    flag = <GPIO_ACTIVE_LOW>;\n};\n"))).toThrow(/GPIO_ACTIVE_LOW/);
  });
});

function findName(node: DtNode | null, name: string): DtNode | null {
  if (!node || node.deleted) return null;
  if (node.fullName === name) return node;
  for (const child of node.children) {
    const found = findName(child, name);
    if (found) return found;
  }
  return null;
}
