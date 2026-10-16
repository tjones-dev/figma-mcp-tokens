// The CLI's commands. Each returns the lines to print; warnings are prefixed "Warning:".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { buildOutputs } from "./build.js";
import { EXT, toDtcg } from "./dtcg.js";
import { readDump } from "./dump.js";
import { Issues } from "./issues.js";
const EXPORT_SCRIPT = new URL("./figma/export.js", import.meta.url);
/** The code to pass to use_figma for one chunk of the export. */
export function script(config, chunk = 1) {
    if (!Number.isInteger(chunk) || chunk < 1)
        throw new Error("--chunk must be a whole number from 1.");
    const saveDir = relative(config.root, config.dumpDir).split(sep).join("/") || ".";
    return readFileSync(EXPORT_SCRIPT, "utf8")
        .replace("__CHUNK__", String(chunk))
        .replace("__FILE_KEY__", JSON.stringify(config.fileKey))
        .replace("__SAVE_DIR__", JSON.stringify(saveDir));
}
/** JSON on one line with spaces, as in a formatted file. */
function inline(value) {
    if (Array.isArray(value))
        return `[${value.map(inline).join(", ")}]`;
    if (typeof value === "object" && value !== null) {
        const items = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
        return items.length === 0 ? "{}" : `{ ${items.join(", ")} }`;
    }
    return JSON.stringify(value);
}
/** JSON with every object or array that fits in 100 columns on one line, so diffs stay short. */
export function formatJson(value, indent = 0, lead = 0) {
    const one = inline(value);
    if (typeof value !== "object" || value === null || indent + lead + one.length <= 100)
        return one;
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
function writeChanged(files, root) {
    const written = [];
    for (const { path, content } of files) {
        if (existsSync(path) && readFileSync(path, "utf8") === content)
            continue;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        written.push(relative(root, path));
    }
    return written;
}
function report(written, warnings) {
    return [
        ...warnings.map((w) => `Warning: ${w}`),
        ...(written.length === 0 ? ["No changes."] : written.map((path) => `Wrote ${path}`)),
    ];
}
function readTokens(config) {
    if (!existsSync(config.tokens)) {
        throw new Error(`No ${relative(config.root, config.tokens)} yet. Export from Figma and run \`figma-mcp-tokens sync\`.`);
    }
    try {
        return JSON.parse(readFileSync(config.tokens, "utf8"));
    }
    catch (error) {
        throw new Error(`${relative(config.root, config.tokens)} isn't valid JSON: ${error.message}`);
    }
}
/** The dump folder → tokens.json → every output; writes only what changed. */
export function sync(config) {
    const dump = readDump(config.dumpDir, config.root);
    if (dump.file && dump.file !== config.fileKey) {
        throw new Error(`The export is from file ${dump.file}; the config expects ${config.fileKey}. Export from the right file.`);
    }
    const issues = new Issues(config.strict);
    const tokens = {
        $extensions: {
            [EXT]: {
                source: `https://www.figma.com/design/${config.fileKey}`,
                note: "Written by `figma-mcp-tokens sync`; change tokens in Figma and sync again, or edits here are lost.",
            },
        },
        ...toDtcg(dump, config, issues),
    };
    const outputs = buildOutputs(tokens, config, issues);
    const warnings = issues.settle();
    const written = writeChanged([{ path: config.tokens, content: `${formatJson(tokens)}\n` }, ...outputs], config.root);
    return report(written, warnings);
}
/** tokens.json → every output; writes only what changed. */
export function build(config) {
    const issues = new Issues(config.strict);
    const outputs = buildOutputs(readTokens(config), config, issues);
    const warnings = issues.settle();
    return report(writeChanged(outputs, config.root), warnings);
}
