import { createHash } from "node:crypto";

/**
 * How a sheet row is recognised again (WB2-025). Sheets gives rows no lasting id, so a row is known by the value in a
 * chosen column, or, without one, by what the identity columns hold. Neither depends on where the row is.
 */
export type SheetIdentity =
  /** Header positions in the file being read. */
  { kind: "id"; header: number } | { kind: "content"; headers: number[] };

export interface RowIdentity {
  /** Null when an ID column is used and the row has nothing in it. */
  key: string | null;
  /** An earlier row of this read has the same ID. */
  repeated: boolean;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Given every row of one read in order, answers each row's identity. */
export function identifier(identity: SheetIdentity): (values: string[]) => RowIdentity {
  const seen = new Map<string, number>();
  return (values) => {
    if (identity.kind === "id") {
      const id = (values[identity.header] ?? "").trim();
      if (!id) return { key: null, repeated: false };
      const key = `id:${hash(id)}`;
      const repeated = seen.has(key);
      seen.set(key, 1);
      return { key, repeated };
    }
    const content = hash(identity.headers.map((h) => (values[h] ?? "").trim()));
    // Rows that hold the same are told apart by how many came before, so each is added once.
    const nth = (seen.get(content) ?? 0) + 1;
    seen.set(content, nth);
    return { key: `row:${content}:${nth}`, repeated: false };
  };
}
