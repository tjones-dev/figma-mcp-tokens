import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build, sync } from "../src/commands.js";
import { figmaFileKey } from "../src/config.js";
import { alias, exportAll, runExport, type FakeFile } from "./fake-figma.js";
import { project, sampleFile } from "./sample.js";

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
