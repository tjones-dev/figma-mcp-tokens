// The CLI's commands. Each returns the lines to print; warnings are prefixed "Warning:".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { buildOutputs, type OutputFile } from "./build.js";
import { CONFIG_FILE, figmaFileKey, type Config } from "./config.js";
import { EXT, toDtcg, tokenKey, type Group } from "./dtcg.js";
import { readDump } from "./dump.js";
import { Issues } from "./issues.js";

const EXPORT_SCRIPT = new URL("./figma/export.js", import.meta.url);
const SKILL = new URL("./agent/SKILL.md", import.meta.url);
const SKILL_PATH = ".claude/skills/figma-mcp-tokens/SKILL.md";
const AGENTS_START = "<!-- figma-mcp-tokens:start -->";
const AGENTS_END = "<!-- figma-mcp-tokens:end -->";

/** The code to pass to use_figma for one chunk of the export. */
export function script(config: Config, chunk = 1): string {
  if (!Number.isInteger(chunk) || chunk < 1) throw new Error("--chunk must be a whole number from 1.");
  const saveDir = relative(config.root, config.dumpDir).split(sep).join("/") || ".";
  return readFileSync(EXPORT_SCRIPT, "utf8")
    .replace("__CHUNK__", String(chunk))
    .replace("__FILE_KEY__", JSON.stringify(config.fileKey))
    .replace("__SAVE_DIR__", JSON.stringify(saveDir));
}

/** JSON on one line with spaces, as in a formatted file. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const items = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return items.length === 0 ? "{}" : `{ ${items.join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** JSON with every object or array that fits in 100 columns on one line, so diffs stay short. */
export function formatJson(value: unknown, indent = 0, lead = 0): string {
  const one = inline(value);
  if (typeof value !== "object" || value === null || indent + lead + one.length <= 100) return one;
  const pad = " ".repeat(indent + 2);
  const items = Array.isArray(value)
    ? value.map((v) => pad + formatJson(v, indent + 2))
    : Object.entries(value).map(([k, v]) => {
        const key = `${JSON.stringify(k)}: `;
        return pad + key + formatJson(v, indent + 2, key.length);
      });
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")}\n${" ".repeat(indent)}${close}`;
}

/** Writes the files whose content changed; returns their paths relative to the project. */
function writeChanged(files: OutputFile[], root: string): string[] {
  const written: string[] = [];
  for (const { path, content } of files) {
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(relative(root, path));
  }
  return written;
}

function report(written: string[], warnings: string[]): string[] {
  return [
    ...warnings.map((w) => `Warning: ${w}`),
    ...(written.length === 0 ? ["No changes."] : written.map((path) => `Wrote ${path}`)),
  ];
}

function readTokens(config: Config): Group {
  if (!existsSync(config.tokens)) {
    throw new Error(`No ${relative(config.root, config.tokens)} yet. Export from Figma and run \`figma-mcp-tokens sync\`.`);
  }
  try {
    return JSON.parse(readFileSync(config.tokens, "utf8")) as Group;
  } catch (error) {
    throw new Error(`${relative(config.root, config.tokens)} isn't valid JSON: ${(error as Error).message}`);
  }
}

/** The dump folder → tokens.json → every output; writes only what changed. */
export function sync(config: Config): string[] {
  const dump = readDump(config.dumpDir, config.root);
  if (dump.file && dump.file !== config.fileKey) {
    throw new Error(`The export is from file ${dump.file}; the config expects ${config.fileKey}. Export from the right file.`);
  }
  const issues = new Issues(config.strict);
  const tokens: Group = {
    $extensions: {
      [EXT]: {
        source: `https://www.figma.com/design/${config.fileKey}`,
        note: "Written by `figma-mcp-tokens sync`; change tokens in Figma and sync again, or edits here are lost.",
      },
    },
    ...toDtcg(dump, config, issues),
  };
  let outputs: OutputFile[];
  try {
    outputs = buildOutputs(tokens, config, issues);
  } catch (error) {
    // A token left out for a problem breaks the aliases to it; with strict, report the problem.
    issues.settle();
    throw error;
  }
  const warnings = issues.settle();
  const written = writeChanged(
    [{ path: config.tokens, content: `${formatJson(tokens)}\n` }, ...outputs],
    config.root,
  );
  return report(written, warnings);
}

/**
 * The merges that differ between the config and the merged groups in tokens.json: a key on one
 * side only, or a key whose tiers differ. Config keys come first, in config order.
 */
function mergeMismatches(config: Config, tokens: Group): string[] {
  const synced = new Map<string, string[]>();
  for (const [key, group] of Object.entries(tokens)) {
    const record = (group as Group | null)?.["$extensions"] as Record<string, Group> | undefined;
    const tiers = record?.[EXT]?.["merged"];
    if (Array.isArray(tiers)) synced.set(key, tiers as string[]);
  }
  const mismatched: string[] = [];
  for (const [name, tiers] of Object.entries(config.merge)) {
    const key = tokenKey(name);
    const syncedTiers = synced.get(key);
    synced.delete(key);
    if (syncedTiers === undefined || syncedTiers.join("\n") !== tiers.join("\n")) mismatched.push(name);
  }
  return [...mismatched, ...synced.keys()];
}

/**
 * tokens.json → every output; writes only what changed. Warns, without failing, when the config's
 * merge doesn't match tokens.json: build doesn't merge, so a changed merge needs a fresh sync.
 */
export function build(config: Config): string[] {
  const tokens = readTokens(config);
  const issues = new Issues(config.strict);
  const outputs = buildOutputs(tokens, config, issues);
  const warnings = [...issues.settle()];
  const mismatched = mergeMismatches(config, tokens);
  if (mismatched.length > 0) {
    warnings.push(
      `merge in the config doesn't match tokens.json (${mismatched.join(", ")}); export from Figma and run figma-mcp-tokens sync.`,
    );
  }
  return report(writeChanged(outputs, config.root), warnings);
}

/**
 * Sets a project up from its root: writes the config if there's none (from the Figma URL), the
 * Claude Code skill that tells an agent how to sync, and a pointer to it in AGENTS.md if the
 * project has one. Run again after upgrading to refresh the skill.
 */
export function init(root: string, configPath: string, figma?: string): string[] {
  const files: OutputFile[] = [];
  const messages: string[] = [];
  const configName = relative(root, configPath).split(sep).join("/");
  if (existsSync(configPath)) {
    if (figma !== undefined) messages.push(`${configName} already exists; left it as is.`);
  } else {
    if (figma === undefined) {
      throw new Error(`No ${configName} yet. Pass the Figma file URL: figma-mcp-tokens init <url>`);
    }
    figmaFileKey(figma);
    files.push({ path: configPath, content: `${formatJson({ figma })}\n` });
  }

  const cli = `npx figma-mcp-tokens${configName === CONFIG_FILE ? "" : ` --config ${configName}`}`;
  const skill = readFileSync(SKILL, "utf8").replaceAll("__CLI__", cli).replaceAll("__CONFIG__", configName);
  files.push({ path: join(root, SKILL_PATH), content: skill });

  const agentsPath = join(root, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const block = [
      AGENTS_START,
      "## Design tokens",
      "",
      `Design tokens are synced from Figma with figma-mcp-tokens. Follow ${SKILL_PATH} to sync them;`,
      "don't edit the generated token files by hand.",
      AGENTS_END,
    ].join("\n");
    const agents = readFileSync(agentsPath, "utf8");
    const start = agents.indexOf(AGENTS_START);
    const end = agents.indexOf(AGENTS_END);
    const content =
      start !== -1 && end > start
        ? agents.slice(0, start) + block + agents.slice(end + AGENTS_END.length)
        : `${agents.trimEnd()}\n\n${block}\n`;
    files.push({ path: agentsPath, content });
  }
  return [...messages, ...report(writeChanged(files, root), [])];
}
