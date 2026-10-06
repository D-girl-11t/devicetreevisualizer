export const SAVED_LIMIT = 5;

export type SavedTree = {
  id: string;
  name: string;
  source: string;
  savedAt: number;
};

export function storeTree(existing: SavedTree[], entry: SavedTree): { trees: SavedTree[]; error: string | null } {
  const name = entry.name.trim();
  if (!name) return { trees: existing, error: "Give this tree a name before saving it." };
  const same = existing.find((tree) => tree.name === name);
  const next = { ...entry, name };
  if (same) {
    return {
      trees: existing.map((tree) => (tree.name === name ? { ...next, id: same.id } : tree)),
      error: null,
    };
  }
  if (existing.length >= SAVED_LIMIT) {
    return {
      trees: existing,
      error: `This page keeps ${SAVED_LIMIT} trees. Remove one before saving another.`,
    };
  }
  return { trees: [next, ...existing], error: null };
}

export function dropTree(existing: SavedTree[], id: string): SavedTree[] {
  return existing.filter((tree) => tree.id !== id);
}
