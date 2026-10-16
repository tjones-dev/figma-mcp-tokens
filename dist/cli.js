#!/usr/bin/env node
// figma-mcp-tokens init [<url>] | script [--chunk <n>] | sync | build, each with an optional --config <path>.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, init, script, sync } from "./commands.js";
import { CONFIG_FILE, loadConfig } from "./config.js";
const USAGE = `Usage: figma-mcp-tokens <command> [--config <path>]

Commands:
  init [<figma url>]    Write the config (if there's none) and the agent skill that explains syncing.
  script [--chunk <n>]  Print the export code to pass to the Figma MCP use_figma tool.
  sync                  Read the saved export, write tokens.json and every output.
  build                 Write every output from tokens.json.

Options:
  --config <path>       The config file (default: ./${CONFIG_FILE}).
  --help, --version

Syncing from Figma:
  1. Run \`script\` and pass its output, unchanged, as the code of the use_figma tool.
  2. Save the whole result as JSON at its saveAs path; the data is checksummed.
  3. If it says chunks > 1, repeat with \`script --chunk 2\` and so on.
  4. Run \`sync\`.`;
function main(args) {
    const options = new Map();
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (arg === "--help" || arg === "-h")
            options.set("help", "");
        else if (arg === "--version" || arg === "-v")
            options.set("version", "");
        else if (arg === "--config" || arg === "--chunk") {
            const value = args[++i];
            if (value === undefined)
                throw new Error(`${arg} needs a value.`);
            options.set(arg.slice(2), value);
        }
        else if (arg.startsWith("-"))
            throw new Error(`Unknown option ${arg}.\n\n${USAGE}`);
        else
            positional.push(arg);
    }
    if (options.has("version")) {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        console.log(pkg.version);
        return 0;
    }
    const [command, argument, extra] = positional;
    if (options.has("help") || !command) {
        console.log(USAGE);
        return command || options.has("help") ? 0 : 1;
    }
    const unexpected = command === "init" ? extra : argument;
    if (unexpected !== undefined)
        throw new Error(`Unexpected argument ${unexpected}.\n\n${USAGE}`);
    if (options.has("chunk") && command !== "script")
        throw new Error("--chunk only goes with script.");
    const configPath = options.get("config");
    if (command === "init") {
        console.log(init(process.cwd(), resolve(configPath ?? CONFIG_FILE), argument).join("\n"));
        return 0;
    }
    const config = loadConfig(configPath === undefined ? undefined : resolve(configPath));
    if (command === "script") {
        process.stdout.write(script(config, Number(options.get("chunk") ?? 1)));
    }
    else if (command === "sync") {
        console.log(sync(config).join("\n"));
    }
    else if (command === "build") {
        console.log(build(config).join("\n"));
    }
    else {
        throw new Error(`Unknown command ${command}.\n\n${USAGE}`);
    }
    return 0;
}
try {
    process.exitCode = main(process.argv.slice(2));
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
