// Reads the chunks src/figma/export.js returns, as saved in the dump folder, and puts the
// dump back together. Every chunk is checked against its own checksum and the export's, so
// a chunk that was cut off, copied wrongly or left over from another export is refused.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const FORMAT = "figma-mcp-tokens/1";

/** An alias is "{collection:name}", or "{?name}" for a variable outside the file. */
export type DumpValue = string | number | boolean;
/** [name, type, web code syntax, scopes (numbers only), one value per mode] */
export type DumpVariable = [
  string,
  "c" | "n" | "s" | "b",
  string | null,
  string[] | null,
  ...DumpValue[],
];
export type DumpCollection = { modes: string[]; variables: DumpVariable[] };
/** Style or effect field → alias, for the fields bound to variables. */
export type DumpBound = Record<string, string> | null;
/** [name, family, style, size, lineHeight, letterSpacing, textCase, textDecoration, bound] */
export type DumpTextStyle = [string, string, string, number, string, string, string, string, DumpBound];
/** [type, color, x, y, blur, spread, visible, bound], or [type] for an effect that isn't a shadow */
export type DumpEffect = [string, string?, number?, number?, number?, number?, boolean?, DumpBound?];
export type DumpEffectStyle = [string, DumpEffect[]];

export type FigmaDump = {
  file: string | null;
  collections: Record<string, DumpCollection>;
  textStyles: DumpTextStyle[];
  effectStyles: DumpEffectStyle[];
};

export type Chunk = {
  format: string;
  chunk: number;
  chunks: number;
  export: string;
  checksum: string;
  data: string;
};

/** FNV-1a over a string's UTF-16 code units, as export.js computes it. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Reads one saved chunk and checks it against its own checksum. */
export function parseChunk(text: string, where: string): Chunk {
  let chunk: Partial<Chunk>;
  try {
    chunk = JSON.parse(text) as Partial<Chunk>;
  } catch {
    throw new Error(`${where} isn't valid JSON; save use_figma's result exactly as returned.`);
  }
  if (
    chunk.format !== FORMAT ||
    typeof chunk.chunk !== "number" ||
    typeof chunk.chunks !== "number" ||
    typeof chunk.export !== "string" ||
    typeof chunk.checksum !== "string" ||
    typeof chunk.data !== "string"
  ) {
    throw new Error(`${where} isn't a ${FORMAT} export chunk; save use_figma's result exactly as returned.`);
  }
  if (fnv1a(chunk.data) !== chunk.checksum) {
    throw new Error(
      `Chunk ${chunk.chunk}'s checksum doesn't match (${where}): it was cut off or copied wrongly. Export that chunk again.`,
    );
  }
  return chunk as Chunk;
}

/** Puts a complete set of chunks back together into the dump. */
export function joinChunks(chunks: Chunk[]): FigmaDump {
  const sorted = [...chunks].sort((a, b) => a.chunk - b.chunk);
  const text = sorted.map((c) => c.data).join("");
  if (fnv1a(text) !== sorted[0]?.export) {
    throw new Error("The joined chunks don't match their export's checksum. Delete the dump folder and export again.");
  }
  return JSON.parse(text) as FigmaDump;
}

/**
 * Reads the dump folder. Files left over from an earlier export are ignored as long as one
 * export is complete.
 */
export function readDump(dir: string, root: string): FigmaDump {
  const shown = relative(root, dir) || ".";
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  if (files.length === 0) {
    throw new Error(
      `No export in ${shown}. Run \`figma-mcp-tokens script\`, pass its output to the Figma MCP use_figma tool, and save the result there.`,
    );
  }
  const exports = new Map<string, Map<number, Chunk>>();
  for (const file of files.sort()) {
    const chunk = parseChunk(readFileSync(join(dir, file), "utf8"), join(shown, file));
    const key = `${chunk.export}/${chunk.chunks}`;
    const set = exports.get(key) ?? new Map<number, Chunk>();
    set.set(chunk.chunk, chunk);
    exports.set(key, set);
  }
  const complete = [...exports.values()].filter((set) => {
    const [first] = set.values();
    return first !== undefined && set.size === first.chunks;
  });
  if (complete.length === 1 && complete[0]) return joinChunks([...complete[0].values()]);
  if (complete.length > 1) {
    throw new Error(`${shown} holds more than one complete export. Delete it and export again.`);
  }
  if (exports.size > 1) {
    throw new Error(
      `The chunks in ${shown} come from different exports (the Figma file changed in between). Delete the folder and export every chunk again.`,
    );
  }
  const [set] = exports.values();
  const [first] = set?.values() ?? [];
  const missing = Array.from({ length: first?.chunks ?? 0 }, (_, i) => i + 1).filter((n) => !set?.has(n));
  throw new Error(
    `Missing chunk ${missing.join(", ")} of ${first?.chunks} in ${shown}. Run \`figma-mcp-tokens script --chunk ${missing[0]}\` and save its result.`,
  );
}
