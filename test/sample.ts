import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { alias, type FakeFile } from "./fake-figma.js";

/** A small design system: primitives, light/dark semantics, components and styles. */
export function sampleFile(): FakeFile {
  return {
    collections: [
      {
        name: "primitive",
        modes: ["value"],
        variables: [
          { name: "color/moss/700", type: "COLOR", values: ["#3f6b34"] },
          { name: "color/ink/900", type: "COLOR", values: ["#2b2620"] },
          { name: "color/paper/50", type: "COLOR", values: ["#fffbf2"] },
          { name: "scale/14", type: "FLOAT", values: [14] },
          { name: "scale/16", type: "FLOAT", values: [16] },
          { name: "duration/250", type: "FLOAT", values: [250] },
          { name: "space/0.5", type: "FLOAT", values: [2] },
        ],
      },
      {
        name: "semantic",
        modes: ["light", "dark"],
        variables: [
          {
            name: "color/surface/page",
            type: "COLOR",
            web: "var(--color-surface-page)",
            values: [alias("primitive/color/paper/50"), alias("primitive/color/ink/900")],
          },
          {
            name: "color/ink/strong",
            type: "COLOR",
            values: [alias("primitive/color/ink/900"), alias("primitive/color/paper/50")],
          },
          { name: "radius/lg", type: "FLOAT", web: "var(--radius-lg)", values: [alias("primitive/scale/14"), alias("primitive/scale/14")] },
          { name: "space/hair", type: "FLOAT", values: [alias("primitive/space/0.5"), alias("primitive/space/0.5")] },
          { name: "motion/duration/base", type: "FLOAT", values: [alias("primitive/duration/250"), alias("primitive/duration/250")] },
          { name: "motion/easing/standard", type: "STRING", values: ["cubic-bezier(0.2, 0, 0, 1)", "cubic-bezier(0.2, 0, 0, 1)"] },
          { name: "opacity/disabled", type: "FLOAT", scopes: ["OPACITY"], values: [40, 50] },
          { name: "font/weight/strong", type: "FLOAT", scopes: ["FONT_WEIGHT"], values: [700, 700] },
          { name: "font/size/md", type: "FLOAT", scopes: ["FONT_SIZE"], values: [alias("primitive/scale/16"), alias("primitive/scale/16")] },
          { name: "font/line/tight", type: "FLOAT", scopes: ["LINE_HEIGHT"], values: [1.2, 1.2] },
          { name: "feature/flag", type: "BOOLEAN", values: [true, false] },
        ],
      },
      {
        name: "component",
        modes: ["default"],
        variables: [
          { name: "card/radius", type: "FLOAT", web: "var(--card-radius)", values: [alias("semantic/radius/lg")] },
          { name: "card/background", type: "COLOR", values: [alias("semantic/color/surface/page")] },
        ],
      },
    ],
    textStyles: [
      {
        name: "body/md",
        family: "Nunito Sans",
        style: "Semi Bold",
        size: 16,
        lineHeight: { unit: "PERCENT", value: 140 },
      },
      {
        name: "label/caps",
        family: "Inter",
        style: "Bold Italic",
        size: 12,
        lineHeight: { unit: "PIXELS", value: 16 },
        letterSpacing: { unit: "PERCENT", value: 4 },
        textCase: "UPPER",
        textDecoration: "UNDERLINE",
        bound: { fontSize: alias("semantic/font/size/md") },
      },
      { name: "body/auto", family: "Inter", style: "Regular", size: 14, lineHeight: { unit: "AUTO" } },
    ],
    effectStyles: [
      {
        name: "shadow/card",
        effects: [
          { type: "DROP_SHADOW", color: "#2b26201a", y: 1, blur: 2 },
          { type: "DROP_SHADOW", color: "#000000", y: 9, blur: 9, visible: false },
        ],
      },
      { name: "shadow/lift", effects: [{ type: "INNER_SHADOW", color: "#2b26201f", y: 4, blur: 8 }] },
    ],
  };
}

/**
 * The sample plus one collection split into tier collections because of Figma's mode limit:
 * `Element T1` (fire, water) and `Element T2` (electric, strength) hold the same variables, a
 * `Router` collection (T1, T2) aliases each tier, and components and styles use them.
 */
export function tieredFile(): FakeFile {
  const file = sampleFile();
  const tier = (n: 1 | 2, modes: string[], values: Record<string, (string | number)[]>): FakeFile["collections"][number] => ({
    name: `Element T${n}`,
    modes,
    variables: [
      { name: "element/lo", type: "COLOR", web: "var(--element-lo)", values: values["lo"]! },
      { name: "element/hi", type: "COLOR", values: values["hi"]! },
      { name: "element/accent", type: "COLOR", values: modes.map(() => alias(`Element T${n}/element/hi`)) },
      { name: "element/duration/pulse", type: "FLOAT", values: values["pulse"]! },
      { name: "element/opacity/glow", type: "FLOAT", values: values["glow"]! },
      { name: "element/size", type: "FLOAT", values: values["size"]! },
    ],
  });
  file.collections.push(
    tier(1, ["fire", "water"], {
      lo: ["#ff4400", "#0066ff"],
      hi: ["#ffaa00", "#ffaa00"],
      pulse: [200, 300],
      glow: [80, 60],
      size: [12, 12],
    }),
    tier(2, ["electric", "strength"], {
      lo: ["#ffee00", "#8b0000"],
      hi: ["#ffaa00", "#ffffff"],
      pulse: [100, 400],
      glow: [80, 90],
      size: [16, 12],
    }),
    {
      name: "Router",
      modes: ["T1", "T2"],
      variables: ["lo", "size", "opacity/glow"].map((name) => ({
        name: `element/${name}`,
        type: name === "lo" ? ("COLOR" as const) : ("FLOAT" as const),
        values: [alias(`Element T1/element/${name}`), alias(`Element T2/element/${name}`)],
      })),
    },
  );
  file.collections[2]!.variables.push(
    { name: "badge/fill", type: "COLOR", values: [alias("Router/element/lo")] },
    { name: "badge/size", type: "FLOAT", values: [alias("Router/element/size")] },
  );
  file.textStyles!.push({
    name: "element/label",
    family: "Inter",
    style: "Bold",
    size: 12,
    lineHeight: { unit: "AUTO" },
    bound: { fontSize: alias("Element T2/element/size") },
  });
  file.effectStyles!.push({
    name: "shadow/element",
    effects: [{ type: "DROP_SHADOW", color: "#000000", y: 2, blur: 4, bound: { color: alias("Element T1/element/hi") } }],
  });
  return file;
}

/** The config options that merge the tiers in `tieredFile()` and keep the router out of the outputs. */
export const TIERED = {
  merge: { Element: ["Element T1", "Element T2"] },
  primitives: ["primitive", "Router"],
};

/** A project folder with a config holding `options`, and its loaded config. */
export function project(options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "fmt-test-"));
  const path = join(root, "figma-mcp-tokens.config.json");
  writeFileSync(path, JSON.stringify({ figma: "https://www.figma.com/design/FILE/Design-System", ...options }));
  return { root, config: loadConfig(path) };
}
