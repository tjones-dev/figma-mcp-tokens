import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build, init, sync } from "../src/commands.js";
import { figmaFileKey, loadConfig } from "../src/config.js";
import { alias, exportAll, runExport, type FakeFile } from "./fake-figma.js";
import { project, sampleFile, TIERED, tieredFile } from "./sample.js";

async function synced(file: FakeFile = sampleFile(), options: Record<string, unknown> = {}) {
  const { root, config } = project(options);
  await exportAll(file, config);
  const messages = sync(config);
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  return { root, config, messages, read, json: () => JSON.parse(read("tokens/tokens.json")) };
}

describe("config", () => {
  it("takes the file key from a design URL, a branch URL or a bare key", () => {
    expect(figmaFileKey("https://www.figma.com/design/AbC123/Name?node-id=1-2")).toBe("AbC123");
    expect(figmaFileKey("https://www.figma.com/design/AbC123/branch/Br4nch/Name")).toBe("Br4nch");
    expect(figmaFileKey("AbC123")).toBe("AbC123");
    expect(() => figmaFileKey("https://example.com")).toThrow(/Figma design URL/);
  });

  it("refuses unknown options", () => {
    expect(() => project({ output: {} })).toThrow(/unknown option output/);
    expect(() => project({ css: { selectr: ":root" } })).toThrow(/unknown option css.selectr/);
  });

  it("merges nothing by default", () => {
    expect(project().config.merge).toEqual({});
    expect(project(TIERED).config.merge).toEqual(TIERED.merge);
  });

  it("refuses a wrongly shaped merge", () => {
    const error = (merge: unknown) => () => project({ merge });
    expect(error([])).toThrow("figma-mcp-tokens.config.json: merge must be an object.");
    const list = "figma-mcp-tokens.config.json: merge.Element must be a list of collection names.";
    expect(error({ Element: "Element T1" })).toThrow(list);
    expect(error({ Element: [] })).toThrow(list);
    expect(error({ Element: ["Element T1", ""] })).toThrow(list);
    expect(error({ Element: ["Element T1", 2] })).toThrow(list);
    expect(error({ Element: ["Element T1"], Crop: null })).toThrow(
      "figma-mcp-tokens.config.json: merge.Crop must be a list of collection names.",
    );
  });

  it("refuses a collection listed in merge more than once", () => {
    const twice = "figma-mcp-tokens.config.json: Element T2 is listed in merge more than once.";
    expect(() => project({ merge: { Element: ["Element T1", "Element T2", "Element T2"] } })).toThrow(twice);
    expect(() => project({ merge: { Element: ["Element T1", "Element T2"], Crop: ["Element T2"] } })).toThrow(twice);
  });

  it("refuses a merge named like a style group", () => {
    expect(() => project({ merge: { text: ["Text T1", "Text T2"] } })).toThrow(
      "figma-mcp-tokens.config.json: merge.text is a reserved name; pick another.",
    );
    expect(() => project({ merge: { effect: ["Effect T1"] } })).toThrow(
      "figma-mcp-tokens.config.json: merge.effect is a reserved name; pick another.",
    );
  });
});

describe("export", () => {
  it("returns one chunk that names where to save it", async () => {
    const { config } = project();
    const result = await runExport(sampleFile(), config);
    expect(result).toMatchObject({ chunk: 1, chunks: 1, saveAs: "tokens/figma-export/1.json" });
    expect(result.next).toMatch(/figma-mcp-tokens sync/);
  });

  it("refuses to run in a different file than the config's", async () => {
    const { config } = project();
    await expect(runExport({ ...sampleFile(), fileKey: "OTHER" }, config)).rejects.toThrow(
      /This is file OTHER; the config expects FILE/,
    );
    await expect(runExport({ ...sampleFile(), fileKey: null }, config)).resolves.toBeTruthy();
  });

  it("splits a large file into chunks that each fit in a tool result", async () => {
    const big: FakeFile = {
      collections: [
        {
          name: "primitive",
          modes: ["value"],
          variables: Array.from({ length: 1500 }, (_, i) => ({
            name: `color/"quoted"/${i}`,
            type: "COLOR" as const,
            values: [`#${(i * 99991).toString(16).padStart(6, "0").slice(-6)}`],
          })),
        },
      ],
    };
    const { root, config, json } = await synced(big);
    const results = await Promise.all([1, 2, 3].map((n) => runExport(big, config, n)));
    expect(results[0]!.chunks).toBeGreaterThan(2);
    for (const r of results) expect(JSON.stringify(r).length).toBeLessThan(18000);
    expect(results[0]!.next).toMatch(/--chunk 2/);
    expect(Object.keys(json().primitive.color['"quoted"'])).toHaveLength(1500);
    rmSync(root, { recursive: true });
  });
});

describe("dump folder", () => {
  it("refuses a chunk that was changed on the way to disk", async () => {
    const { root, config } = project();
    await exportAll(sampleFile(), config);
    const path = join(root, "tokens/figma-export/1.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("#3f6b34", "#3f6b35"));
    expect(() => sync(config)).toThrow(/checksum doesn't match/);
  });

  it("asks for missing chunks, and ignores chunks left over from an earlier export", async () => {
    const { root, config } = project();
    const dir = join(root, "tokens/figma-export");
    await exportAll(sampleFile(), config);
    const leftover = JSON.parse(readFileSync(join(dir, "1.json"), "utf8"));
    writeFileSync(join(dir, "7.json"), JSON.stringify({ ...leftover, chunk: 7, chunks: 9 }));
    expect(sync(config)).toContain("Wrote tokens/tokens.json");

    rmSync(join(dir, "1.json"));
    expect(() => sync(config)).toThrow(/Missing chunk 1, 2, 3, 4, 5, 6, 8, 9 of 9/);
    rmSync(dir, { recursive: true });
    expect(() => sync(config)).toThrow(/No export in tokens\/figma-export/);
  });
});

describe("sync", () => {
  it("writes tokens.json with aliases as references and modes in $extensions", async () => {
    const { json } = await synced();
    const tokens = json();
    expect(tokens.$extensions["figma-mcp-tokens"].source).toBe("https://www.figma.com/design/FILE");
    expect(tokens.semantic.$extensions["figma-mcp-tokens"].modes).toEqual(["light", "dark"]);
    expect(tokens.semantic.color.surface.page).toEqual({
      $type: "color",
      $value: "{primitive.color.paper.50}",
      $extensions: {
        "com.figma": { codeSyntax: { WEB: "var(--color-surface-page)" } },
        "figma-mcp-tokens": { modes: { dark: "{primitive.color.ink.900}" } },
      },
    });
    expect(tokens.primitive.space["0_5"]).toEqual({ $type: "dimension", $value: "2px" });
  });

  it("writes CSS without primitives, with the other modes under the mode selector", async () => {
    const { read } = await synced();
    const css = read("tokens/tokens.css");
    expect(css).not.toMatch(/moss|scale|--primitive/);
    expect(css).toContain(":root {\n  --color-surface-page: #fffbf2;");
    expect(css).toContain("--card-radius: 14px;");
    expect(css).toContain("--space-hair: 2px;");
    expect(css).toContain("--motion-duration-base: 250ms;");
    expect(css).toContain("--motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);");
    expect(css).toContain("--feature-flag: true;");
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    expect(dark).toBe(
      [
        '[data-theme="dark"] {',
        "  --color-surface-page: #2b2620;",
        "  --color-ink-strong: #fffbf2;",
        "  --opacity-disabled: 0.5;",
        "  --feature-flag: false;",
        "  --card-background: #2b2620;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("works out number units from names and scopes, with config overrides", async () => {
    const { read } = await synced(sampleFile(), { units: { "semantic/font/weight/*": "px" } });
    const css = read("tokens/tokens.css");
    expect(css).toContain("--opacity-disabled: 0.4;");
    expect(css).toContain("--font-line-tight: 1.2;");
    expect(css).toContain("--font-size-md: 16px;");
    expect(css).toContain("--font-weight-strong: 700px;");
  });

  it("writes text styles as font shorthands with their other properties", async () => {
    const { read } = await synced();
    const css = read("tokens/tokens.css");
    expect(css).toContain('--text-body-md: 600 16px/1.4 "Nunito Sans";');
    expect(css).not.toContain("--text-body-md-letter-spacing");
    expect(css).not.toContain("--text-body-md-text-transform");
    expect(css).toContain("--text-label-caps: italic 700 16px/16px Inter;");
    expect(css).toContain("--text-label-caps-letter-spacing: 0.04em;");
    expect(css).toContain("--text-label-caps-text-transform: uppercase;");
    expect(css).toContain("--text-label-caps-text-decoration: underline;");
    expect(css).toContain("--text-body-auto: 400 14px/normal Inter;");
  });

  it("writes shadows, leaving out hidden ones", async () => {
    const { read } = await synced();
    const css = read("tokens/tokens.css");
    expect(css).toContain("--shadow-card: 0px 1px 2px 0px #2b26201a;");
    expect(css).toContain("--shadow-lift: inset 0px 4px 8px 0px #2b26201f;");
  });

  it("writes a typed module with numbers and the other modes in $modes", async () => {
    const { read } = await synced();
    const ts = read("tokens/tokens.ts");
    const tokens = JSON.parse(ts.slice(ts.indexOf("{"), ts.lastIndexOf("}") + 1));
    expect(ts).toMatch(/as const;\n$/);
    expect(tokens.card).toEqual({ radius: 14, background: "#fffbf2" });
    expect(tokens.motion.duration.base).toBe(250);
    expect(tokens.text.label.caps).toMatchObject({ fontWeight: 700, fontStyle: "italic", fontSize: 16 });
    expect(tokens.shadow.lift).toBe("inset 0px 4px 8px 0px #2b26201f");
    expect(tokens.$modes.dark).toEqual({
      color: { surface: { page: "#2b2620" }, ink: { strong: "#fffbf2" } },
      opacity: { disabled: 0.5 },
      feature: { flag: false },
      card: { background: "#2b2620" },
    });
  });

  it("writes .js and .d.ts for a .js module path, and nothing when nothing changed", async () => {
    const { config, read } = await synced(sampleFile(), { outputs: { css: null, module: "src/tokens.js" } });
    expect(read("src/tokens.js")).toMatch(/^export const tokens = \{/m);
    expect(read("src/tokens.d.ts")).toMatch(/^export declare const tokens: \{/m);
    expect(sync(config)).toEqual(["No changes."]);
  });

  it("applies a prefix and selectors from the config", async () => {
    const { read } = await synced(sampleFile(), {
      css: { prefix: "ds", selector: ".theme", modeSelector: ".theme-{mode}" },
    });
    const css = read("tokens/tokens.css");
    expect(css).toContain(".theme {\n  --ds-color-surface-page: #fffbf2;");
    expect(css).toContain(".theme-dark {");
  });
});

describe("strictness", () => {
  const withLibraryAlias = () => {
    const file = sampleFile();
    file.collections[1]!.variables.push({ name: "color/brand", type: "COLOR", values: [alias("Brand/blue"), "#000000"] });
    file.effectStyles!.push({ name: "blur/glass", effects: [{ type: "BACKGROUND_BLUR" }] });
    file.textStyles!.push({ name: "caps/small", family: "Inter", style: "Regular", size: 12, lineHeight: { unit: "AUTO" }, textCase: "SMALL_CAPS" });
    return file;
  };

  it("fails on anything it can't express, listing all of it", async () => {
    await expect(synced(withLibraryAlias())).rejects.toThrow(
      /3 problems:[\s\S]*semantic\/color\/brand aliases Brand\/blue from a library[\s\S]*SMALL_CAPS[\s\S]*BACKGROUND_BLUR/,
    );
  });

  it("skips it with a warning when strict is off", async () => {
    const { messages, read } = await synced(withLibraryAlias(), { strict: false });
    expect(messages.filter((m) => m.startsWith("Warning:"))).toHaveLength(3);
    expect(read("tokens/tokens.css")).not.toMatch(/color-brand|caps-small|blur-glass/);
  });

  it("refuses an opacity aliasing a number that isn't one", async () => {
    const file = sampleFile();
    file.collections[1]!.variables.push({
      name: "opacity/muted",
      type: "FLOAT",
      scopes: ["OPACITY"],
      values: [alias("primitive/scale/14"), 50],
    });
    await expect(synced(file)).rejects.toThrow(/only one of them is an opacity/);
  });

  it("refuses two tokens with the same CSS name", async () => {
    const file = sampleFile();
    file.collections[2]!.variables.push({ name: "radius", type: "FLOAT", web: "var(--radius-lg)", values: [3] });
    await expect(synced(file)).rejects.toThrow(/--radius-lg is also semantic.radius.lg's/);
  });
});

describe("merge", () => {
  const moduleTokens = (ts: string) => JSON.parse(ts.slice(ts.indexOf("{"), ts.lastIndexOf("}") + 1));

  it("can't export tier collections without merging them", async () => {
    await expect(synced(tieredFile(), { primitives: TIERED.primitives })).rejects.toThrow(
      /--element-lo is also Element T1.element.lo's/,
    );
  });

  it("writes one group for the tiers, with every tier's modes and the first as default", async () => {
    const { json } = await synced(tieredFile(), TIERED);
    const tokens = json();
    expect(tokens["Element T1"]).toBeUndefined();
    expect(tokens["Element T2"]).toBeUndefined();
    expect(tokens.Element).toEqual({
      $extensions: {
        "figma-mcp-tokens": { modes: ["fire", "water", "electric", "strength"], merged: ["Element T1", "Element T2"] },
      },
      element: {
        lo: {
          $type: "color",
          $value: "#ff4400",
          $extensions: {
            "com.figma": { codeSyntax: { WEB: "var(--element-lo)" } },
            "figma-mcp-tokens": { modes: { water: "#0066ff", electric: "#ffee00", strength: "#8b0000" } },
          },
        },
        hi: { $type: "color", $value: "#ffaa00", $extensions: { "figma-mcp-tokens": { modes: { strength: "#ffffff" } } } },
        accent: { $type: "color", $value: "{Element.element.hi}" },
        duration: {
          pulse: {
            $type: "duration",
            $value: "200ms",
            $extensions: { "figma-mcp-tokens": { modes: { water: "300ms", electric: "100ms", strength: "400ms" } } },
          },
        },
        opacity: {
          glow: { $type: "number", $value: 0.8, $extensions: { "figma-mcp-tokens": { modes: { water: 0.6, strength: 0.9 } } } },
        },
        size: { $type: "dimension", $value: "12px", $extensions: { "figma-mcp-tokens": { modes: { electric: "16px" } } } },
      },
    });
  });

  it("rewrites aliases into the tiers to the merged group", async () => {
    const { json } = await synced(tieredFile(), TIERED);
    const tokens = json();
    expect(tokens.Router.element.lo).toEqual({ $type: "color", $value: "{Element.element.lo}" });
    expect(tokens.Router.element.size).toEqual({ $type: "dimension", $value: "{Element.element.size}" });
    expect(tokens.component.badge.fill).toEqual({ $type: "color", $value: "{Router.element.lo}" });
    expect(tokens.text.element.label.$value.fontSize).toBe("{Element.element.size}");
    expect(tokens.effect.shadow.element.$value[0].color).toBe("{Element.element.hi}");
  });

  it("writes one CSS property and module key per variable, with every other mode as a theme", async () => {
    const { read } = await synced(tieredFile(), TIERED);
    const css = read("tokens/tokens.css");
    expect(css.match(/--element-lo:/g)).toHaveLength(4);
    expect(css).toContain(":root {\n  --color-surface-page: #fffbf2;");
    const root = css.slice(css.indexOf(":root"), css.indexOf("}"));
    expect(root).toContain("--element-lo: #ff4400;");
    expect(root).toContain("--element-duration-pulse: 200ms;");
    expect(root).toContain("--badge-fill: #ff4400;");
    expect(root).toContain("--text-element-label: 700 12px/normal Inter;");
    const electric = css.slice(css.indexOf('[data-theme="electric"]'));
    expect(electric.slice(0, electric.indexOf("}") + 1)).toBe(
      [
        '[data-theme="electric"] {',
        "  --badge-fill: #ffee00;",
        "  --badge-size: 16px;",
        "  --element-lo: #ffee00;",
        "  --element-duration-pulse: 100ms;",
        "  --element-size: 16px;",
        "  --text-element-label: 700 16px/normal Inter;",
        "}",
      ].join("\n"),
    );
    expect(css).toContain('[data-theme="water"]');
    expect(css).toMatch(/\[data-theme="strength"\] \{[^}]*--element-lo: #8b0000;/);
    expect(css).not.toMatch(/router|-t1|-t2|"t1"|"t2"/i);

    const tokens = moduleTokens(read("tokens/tokens.ts"));
    expect(tokens.element.lo).toBe("#ff4400");
    expect(tokens.element.duration.pulse).toBe(200);
    expect(tokens.badge).toEqual({ fill: "#ff4400", size: 12 });
    expect(tokens.$modes.electric.element.lo).toBe("#ffee00");
    expect(tokens.$modes.electric.badge).toEqual({ fill: "#ffee00", size: 16 });
    expect(tokens.$modes.strength.badge).toEqual({ fill: "#8b0000" });
    expect(Object.keys(tokens.$modes)).toEqual(["dark", "water", "electric", "strength"]);
  });

  it("matches units globs against the merged name, not the tier names", async () => {
    const merged = await synced(tieredFile(), { ...TIERED, units: { "Element/element/size": "none" } });
    expect(merged.json().Element.element.size).toEqual({
      $type: "number",
      $value: 12,
      $extensions: { "figma-mcp-tokens": { modes: { electric: 16 } } },
    });
    const tier = await synced(tieredFile(), { ...TIERED, units: { "Element T1/element/size": "none" } });
    expect(tier.json().Element.element.size.$value).toBe("12px");
  });

  it("checks an opacity alias against the merged token's unit", async () => {
    const file = tieredFile();
    file.collections[2]!.variables.push({
      name: "badge/alpha",
      type: "FLOAT",
      scopes: ["OPACITY"],
      values: [alias("Element T2/element/opacity/glow")],
    });
    const { json } = await synced(file, TIERED);
    expect(json().component.badge.alpha).toEqual({ $type: "number", $value: "{Element.element.opacity.glow}" });
    await expect(synced(file, { ...TIERED, units: { "Element T2/element/opacity/*": "none" } })).resolves.toBeTruthy();
    await expect(synced(file, { ...TIERED, units: { "Element/element/opacity/*": "none" } })).rejects.toThrow(
      /component\/badge\/alpha aliases Element T2\/element\/opacity\/glow, but only one of them is an opacity/,
    );
  });

  it("keeps the router in tokens.json but out of the outputs when it's a primitive", async () => {
    const { json, read } = await synced(tieredFile(), TIERED);
    expect(json().Router.$extensions["figma-mcp-tokens"].modes).toEqual(["T1", "T2"]);
    expect(read("tokens/tokens.css")).not.toMatch(/router/i);
    expect(moduleTokens(read("tokens/tokens.ts")).$modes.T1).toBeUndefined();
  });
});

describe("build", () => {
  it("rebuilds the outputs from a hand-edited tokens.json", async () => {
    const { root, config, read } = await synced();
    const path = join(root, "tokens/tokens.json");
    const tokens = JSON.parse(read("tokens/tokens.json"));
    tokens.component.card.radius = { $type: "dimension", $value: "{primitive.scale.16}" };
    writeFileSync(path, JSON.stringify(tokens));
    expect(build(config)).toEqual(["Wrote tokens/tokens.css", "Wrote tokens/tokens.ts"]);
    expect(read("tokens/tokens.css")).toContain("--card-radius: 16px;");
    expect(build(config)).toEqual(["No changes."]);

    tokens.component.card.radius.$value = "{primitive.scale.99}";
    writeFileSync(path, JSON.stringify(tokens));
    expect(() => build(config)).toThrow(/\{primitive.scale.99\} points at no token/);
  });
});

describe("init", () => {
  const URL = "https://www.figma.com/design/AbC123/Name";
  const SKILL = ".claude/skills/figma-mcp-tokens/SKILL.md";

  it("writes the config and the skill, and nothing more when run again", () => {
    const root = mkdtempSync(join(tmpdir(), "figma-mcp-tokens-init-"));
    const config = join(root, "figma-mcp-tokens.config.json");
    expect(() => init(root, config)).toThrow(/Pass the Figma file URL/);
    expect(() => init(root, config, "https://example.com")).toThrow(/Figma design URL/);

    expect(init(root, config, URL)).toEqual(["Wrote figma-mcp-tokens.config.json", `Wrote ${SKILL}`]);
    expect(loadConfig(config).fileKey).toBe("AbC123");
    const skill = readFileSync(join(root, SKILL), "utf8");
    expect(skill).toMatch(/^---\nname: figma-mcp-tokens\ndescription: /);
    expect(skill).toContain("Run `npx figma-mcp-tokens script`.");
    expect(skill).not.toMatch(/__CLI__|__CONFIG__/);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);

    expect(init(root, config)).toEqual(["No changes."]);
    expect(init(root, config, "https://www.figma.com/design/Other/Name")).toEqual([
      "figma-mcp-tokens.config.json already exists; left it as is.",
      "No changes.",
    ]);
    rmSync(root, { recursive: true });
  });

  it("names a config outside the default in the skill's commands", () => {
    const root = mkdtempSync(join(tmpdir(), "figma-mcp-tokens-init-"));
    init(root, join(root, "design/tokens.config.json"), URL);
    const skill = readFileSync(join(root, SKILL), "utf8");
    expect(skill).toContain("Run `npx figma-mcp-tokens --config design/tokens.config.json script`.");
    expect(skill).toContain("named in\n`design/tokens.config.json`.");
    rmSync(root, { recursive: true });
  });

  it("adds a pointer to an existing AGENTS.md, and replaces it on the next run", () => {
    const root = mkdtempSync(join(tmpdir(), "figma-mcp-tokens-init-"));
    const agents = join(root, "AGENTS.md");
    writeFileSync(agents, "# Agents\n\nUse pnpm.\n");
    init(root, join(root, "figma-mcp-tokens.config.json"), URL);
    const first = readFileSync(agents, "utf8");
    expect(first).toMatch(/^# Agents\n\nUse pnpm\.\n\n<!-- figma-mcp-tokens:start -->\n## Design tokens\n/);
    expect(first).toContain(`Follow ${SKILL} to sync them;`);
    expect(first).toMatch(/<!-- figma-mcp-tokens:end -->\n$/);

    writeFileSync(agents, first.replace("## Design tokens", "## Old") + "\nMore notes.\n");
    expect(init(root, join(root, "figma-mcp-tokens.config.json"))).toEqual(["Wrote AGENTS.md"]);
    expect(readFileSync(agents, "utf8")).toBe(first + "\nMore notes.\n");
    rmSync(root, { recursive: true });
  });
});
