// A stand-in for the Figma plugin API's `figma` global, enough to run src/figma/export.js.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { script } from "../src/commands.js";
import type { Config } from "../src/config.js";

type Alias = { alias: string };
type FakeVariable = {
  name: string;
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  web?: string;
  scopes?: string[];
  /** One per mode: a number, string, boolean, "#rrggbb[aa]" for a color, or an alias. */
  values: (number | string | boolean | Alias)[];
};
type FakeBound = Record<string, Alias>;
export type FakeFile = {
  fileKey?: string | null;
  collections: { name: string; modes: string[]; variables: FakeVariable[] }[];
  textStyles?: {
    name: string;
    family: string;
    style: string;
    size: number;
    lineHeight: { unit: "PERCENT" | "PIXELS" | "AUTO"; value?: number };
    letterSpacing?: { unit: "PERCENT" | "PIXELS"; value: number };
    textCase?: string;
    textDecoration?: string;
    bound?: FakeBound;
  }[];
  effectStyles?: {
    name: string;
    effects: {
      type: string;
      color?: string;
      x?: number;
      y?: number;
      blur?: number;
      spread?: number;
      visible?: boolean;
      bound?: FakeBound;
    }[];
  }[];
};

export const alias = (path: string): Alias => ({ alias: path });

export function rgba(hex: string) {
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(1), g: n(3), b: n(5), a: hex.length > 7 ? n(7) : 1 };
}

export function fakeFigma(file: FakeFile) {
  const ids = new Map<string, string>();
  file.collections.forEach((c, ci) => c.variables.forEach((v, vi) => ids.set(`${c.name}/${v.name}`, `V:${ci}:${vi}`)));
  const ref = (a: Alias) => ({ type: "VARIABLE_ALIAS", id: ids.get(a.alias) ?? `lib:${a.alias}` });
  const raw = (type: FakeVariable["type"], v: FakeVariable["values"][number]) => {
    if (typeof v === "object") return ref(v);
    return type === "COLOR" ? rgba(String(v)) : v;
  };
  const bound = (b?: FakeBound) =>
    b ? Object.fromEntries(Object.entries(b).map(([field, a]) => [field, ref(a)])) : {};

  const collections = file.collections.map((c, ci) => ({
    id: `C:${ci}`,
    name: c.name,
    modes: c.modes.map((name, mi) => ({ modeId: `M:${ci}:${mi}`, name })),
    variableIds: c.variables.map((_, vi) => `V:${ci}:${vi}`),
  }));
  const variables = file.collections.flatMap((c, ci) =>
    c.variables.map((v, vi) => ({
      id: `V:${ci}:${vi}`,
      name: v.name,
      variableCollectionId: `C:${ci}`,
      resolvedType: v.type,
      codeSyntax: v.web ? { WEB: v.web } : {},
      scopes: v.scopes ?? ["ALL_SCOPES"],
      valuesByMode: Object.fromEntries(v.values.map((value, mi) => [`M:${ci}:${mi}`, raw(v.type, value)])),
    })),
  );

  return {
    fileKey: file.fileKey === undefined ? "FILE" : file.fileKey,
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async () => variables,
      getVariableByIdAsync: async (id: string) =>
        id.startsWith("lib:") ? { name: id.slice("lib:".length) } : null,
    },
    getLocalTextStylesAsync: async () =>
      (file.textStyles ?? []).map((s) => ({
        name: s.name,
        fontName: { family: s.family, style: s.style },
        fontSize: s.size,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing ?? { unit: "PERCENT", value: 0 },
        textCase: s.textCase ?? "ORIGINAL",
        textDecoration: s.textDecoration ?? "NONE",
        boundVariables: bound(s.bound),
      })),
    getLocalEffectStylesAsync: async () =>
      (file.effectStyles ?? []).map((s) => ({
        name: s.name,
        effects: s.effects.map((e) => ({
          type: e.type,
          color: rgba(e.color ?? "#000000"),
          offset: { x: e.x ?? 0, y: e.y ?? 0 },
          radius: e.blur ?? 0,
          spread: e.spread ?? 0,
          visible: e.visible ?? true,
          boundVariables: bound(e.bound),
        })),
      })),
  };
}

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

/** Runs the printed export script against a fake file, as use_figma would. */
export async function runExport(file: FakeFile, config: Config, chunk = 1) {
  return (await new AsyncFunction("figma", script(config, chunk))(fakeFigma(file))) as {
    saveAs: string;
    next: string;
    chunk: number;
    chunks: number;
    export: string;
    checksum: string;
    data: string;
  };
}

/** Exports every chunk and saves each where it says, as an MCP client would. */
export async function exportAll(file: FakeFile, config: Config) {
  const first = await runExport(file, config, 1);
  const results = [first];
  for (let n = 2; n <= first.chunks; n++) results.push(await runExport(file, config, n));
  for (const result of results) {
    const path = join(config.root, result.saveAs);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(result));
  }
  return results;
}
