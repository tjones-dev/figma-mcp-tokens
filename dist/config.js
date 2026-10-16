// Loads figma-mcp-tokens.config.json. Every path in it is relative to the config file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
export const CONFIG_FILE = "figma-mcp-tokens.config.json";
const UNITS = ["px", "ms", "none"];
const DEFAULTS = {
    dumpDir: "tokens/figma-export",
    tokens: "tokens/tokens.json",
    outputs: { css: "tokens/tokens.css", module: "tokens/tokens.ts" },
    primitives: ["primitive"],
    css: { prefix: "", selector: ":root", modeSelector: '[data-theme="{mode}"]' },
    units: {},
    strict: true,
};
/** The file key in a Figma design URL (the branch key for a branch), or a bare file key. */
export function figmaFileKey(figma) {
    const url = /figma\.com\/(?:design|file)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/.exec(figma);
    if (url)
        return url[2] ?? url[1] ?? "";
    if (/^[A-Za-z0-9]+$/.test(figma))
        return figma;
    throw new Error(`"figma" must be a Figma design URL or a file key; got ${figma}.`);
}
function fail(message) {
    throw new Error(`${CONFIG_FILE}: ${message}`);
}
function checkKeys(object, allowed, where) {
    for (const key of Object.keys(object)) {
        if (!allowed.includes(key))
            fail(`unknown option ${where}${key}.`);
    }
}
function string(value, name) {
    if (typeof value !== "string" || value === "")
        fail(`${name} must be a non-empty string.`);
    return value;
}
function object(value, name) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${name} must be an object.`);
    }
    return value;
}
/** Reads and checks the config; a missing option takes its default. */
export function loadConfig(path = resolve(CONFIG_FILE)) {
    if (!existsSync(path)) {
        throw new Error(`No ${CONFIG_FILE} at ${path}. Create one with at least { "figma": "<Figma file URL>" }.`);
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        fail(`isn't valid JSON (${error.message}).`);
    }
    const config = object(raw, "the config");
    checkKeys(config, ["$schema", "figma", ...Object.keys(DEFAULTS)], "");
    const outputs = object(config["outputs"] ?? {}, "outputs");
    checkKeys(outputs, Object.keys(DEFAULTS.outputs), "outputs.");
    const css = object(config["css"] ?? {}, "css");
    checkKeys(css, Object.keys(DEFAULTS.css), "css.");
    const units = object(config["units"] ?? {}, "units");
    for (const [pattern, unit] of Object.entries(units)) {
        if (!UNITS.includes(unit))
            fail(`units.${pattern} must be one of ${UNITS.join(", ")}.`);
    }
    const primitives = config["primitives"] ?? DEFAULTS.primitives;
    if (!Array.isArray(primitives) || !primitives.every((p) => typeof p === "string")) {
        fail("primitives must be a list of collection names.");
    }
    const strict = config["strict"] ?? DEFAULTS.strict;
    if (typeof strict !== "boolean")
        fail("strict must be true or false.");
    const root = dirname(path);
    const output = (name) => {
        const value = outputs[name] === undefined ? DEFAULTS.outputs[name] : outputs[name];
        return value === null ? null : resolve(root, string(value, `outputs.${name}`));
    };
    const cssOption = (name) => {
        const value = css[name] ?? DEFAULTS.css[name];
        if (typeof value !== "string")
            fail(`css.${name} must be a string.`);
        return value;
    };
    const prefix = cssOption("prefix");
    if (prefix && !/^[a-z0-9-]+$/i.test(prefix))
        fail("css.prefix may only hold letters, digits and -.");
    const modeSelector = cssOption("modeSelector");
    if (!modeSelector.includes("{mode}"))
        fail("css.modeSelector must contain {mode}.");
    const module = output("module");
    if (module && !/\.(ts|js|mjs)$/.test(module))
        fail("outputs.module must end in .ts, .js or .mjs.");
    return {
        root,
        fileKey: figmaFileKey(string(config["figma"], "figma")),
        dumpDir: resolve(root, string(config["dumpDir"] ?? DEFAULTS.dumpDir, "dumpDir")),
        tokens: resolve(root, string(config["tokens"] ?? DEFAULTS.tokens, "tokens")),
        outputs: { css: output("css"), module },
        primitives,
        css: { prefix, selector: string(cssOption("selector"), "css.selector"), modeSelector },
        units: units,
        strict,
    };
}
