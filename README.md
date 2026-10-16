# figma-mcp-tokens

Turns the variables and styles in a Figma file into design tokens for code: a
[DTCG](https://www.designtokens.org/) `tokens.json`, CSS custom properties, and a typed
JS/TS module. The export runs inside Figma through the Figma MCP server's `use_figma`
tool; everything after that is a plain CLI with no runtime dependencies. `init` installs a
Claude Code skill in the project, so an agent knows how to run the export without being told.

> **v0.x:** the config and output formats may still change between minor versions.

- [How it works](#how-it-works)
- [Using it in a project](#using-it-in-a-project)
- [Configuration](#configuration)
- [What gets exported](#what-gets-exported)
- [Maintaining this repo](#maintaining-this-repo)
- [Troubleshooting](#troubleshooting)

## How it works

```
Figma file ──(use_figma + export script)──▶ dump folder ──(sync)──▶ tokens.json ──▶ tokens.css
                                            (JSON chunks)          (DTCG)        └─▶ tokens.ts
```

1. **Export.** `figma-mcp-tokens script` prints a read-only Figma Plugin API script.
   Whatever MCP client you use (Claude Code, Cursor, …) passes that script to the Figma MCP
   `use_figma` tool. The tool returns the file's variables, text styles and effect styles as
   JSON. The script can't write files because it runs in Figma's sandbox, so the MCP client
   saves each result into the dump folder.
2. **Sync.** `figma-mcp-tokens sync` checks the dump, converts it to `tokens.json`, and
   generates the outputs. If nothing changed, it prints `No changes.` and writes nothing.
3. **Build.** `figma-mcp-tokens build` regenerates the outputs from `tokens.json` without
   touching Figma. Use it after changing the config, editing `tokens.json` by hand, or
   upgrading this package.

### Why the export comes in chunks

MCP tool results longer than about 20 KB get cut off before they reach the client. The
export script splits the dump into numbered chunks that each stay under 18 KB. Every chunk
carries a checksum of itself and of the whole export, so `sync` refuses a chunk that was
truncated, copied wrongly, or left over from a different export. A design system with
~150 variables and ~30 text styles fits in one chunk.

## Using it in a project

### Install

The package isn't on npm. Install it from GitHub, pinned to a tag:

```sh
pnpm add -D github:tjones-dev/figma-mcp-tokens#v0.2.0
# or: npm i -D github:tjones-dev/figma-mcp-tokens#v0.2.0
```

The repo is private, so the machine needs GitHub access over SSH or through
`gh auth setup-git`. Requires Node 20+.

### Set up

From the project root:

```sh
npx figma-mcp-tokens init https://www.figma.com/design/<fileKey>/<name>
```

This writes:

- **`figma-mcp-tokens.config.json`** with `{ "figma": "<url>" }`, unless a config already
  exists. Only `figma` is required. See [Configuration](#configuration) for every option.
- **`.claude/skills/figma-mcp-tokens/SKILL.md`**, a Claude Code skill with the export and sync
  steps and what to do when they fail. Claude Code loads it whenever a request is about
  syncing design tokens or Figma variables. Commit it.
- **A "Design tokens" section in `AGENTS.md`** that points other agents (Cursor, Codex, …) at
  the skill file. Only if the project already has an `AGENTS.md`. The section sits between
  `<!-- figma-mcp-tokens:start -->` and `<!-- figma-mcp-tokens:end -->` markers and is
  replaced on every run.

`init` overwrites the skill and the `AGENTS.md` section, so don't edit them by hand. With
`--config <path>`, the config goes there and the skill's commands pass the same `--config`.

### Export and sync

Ask your agent to sync the design tokens. With the skill installed, "sync the tokens from
Figma" is enough. Without it (an agent that reads neither `.claude/skills` nor `AGENTS.md`),
spell it out:

> Run `npx figma-mcp-tokens script` and pass its output to the Figma MCP `use_figma` tool
> for the file in figma-mcp-tokens.config.json. Save the result exactly as returned to the
> path in its `saveAs`. Its `next` field says whether to export another chunk or run
> `npx figma-mcp-tokens sync`.

What the agent does, step by step:

```sh
npx figma-mcp-tokens script            # export code for chunk 1
# → run it with use_figma; save the result to its saveAs path (tokens/figma-export/1.json)
#   the result includes { chunk: 1, chunks: N }
npx figma-mcp-tokens script --chunk 2  # only if N > 1, and so on
npx figma-mcp-tokens sync              # dump → tokens.json → outputs
```

The script checks that the open Figma file is the one in `figma`, and fails if it isn't.

Commit `tokens.json` and the generated outputs. The dump folder can be committed or
gitignored. `sync` only needs it on the run that reads it.

### Use the outputs

```css
@import "./tokens/tokens.css";

.card {
  background: var(--color-surface-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  font: var(--text-body-md);
}
```

```ts
import { tokens } from "./tokens/tokens";

const duration = tokens.motion.duration.base; // 250 (ms)
const darkPage = tokens.$modes.dark.color.surface.page;
```

### Commands

| Command | What it does |
| --- | --- |
| `figma-mcp-tokens init [<figma url>]` | Writes the config if there's none, the agent skill, and the `AGENTS.md` section. |
| `figma-mcp-tokens script [--chunk <n>]` | Prints the export code for `use_figma`. |
| `figma-mcp-tokens sync` | Reads the dump, writes `tokens.json` and every output. Writes nothing when unchanged. |
| `figma-mcp-tokens build` | Writes every output from `tokens.json`. Doesn't read the dump. |

Every command reads the config from the current directory. `--config <path>` points at a
different config file. Paths in the config are relative to the config file.

## Configuration

`figma-mcp-tokens.config.json`, with defaults:

```jsonc
{
  // Figma file to export (required). A design URL, a branch URL or a bare file key.
  "figma": "https://www.figma.com/design/<fileKey>/<name>",

  // Where use_figma results are saved, one file per chunk (1.json, 2.json, …).
  "dumpDir": "tokens/figma-export",

  // The DTCG source of truth for the outputs.
  "tokens": "tokens/tokens.json",

  "outputs": {
    // CSS custom properties. null turns the output off.
    "css": "tokens/tokens.css",
    // Token module. A .ts path writes TypeScript; a .js or .mjs path writes JS plus a
    // .d.ts or .d.mts next to it. null turns the output off.
    "module": "tokens/tokens.ts"
  },

  // Collections that stay in tokens.json but are left out of the outputs.
  "primitives": ["primitive"],

  "css": {
    // Prepended to every custom property name: "ds" → --ds-color-surface-page.
    "prefix": "",
    // Where the first mode of each collection goes.
    "selector": ":root",
    // Where every other mode goes; {mode} is the mode name in kebab-case.
    "modeSelector": "[data-theme=\"{mode}\"]"
  },

  // Unit overrides for number variables, by "<collection>/<variable>" glob.
  // * matches within one /-segment, ** across segments. Units: "px", "ms" or "none".
  "units": {
    // "semantic/z/*": "none"
  },

  // true: anything the tool can't express fails sync and build, listing every problem.
  // false: each is skipped with a warning.
  "strict": true
}
```

Unknown options are an error, so a typo doesn't get silently ignored.

## What gets exported

### Variables

Every local variable collection becomes a top-level group in `tokens.json`, and aliases
stay references: `{primitive.color.paper.50}`. DTCG names can't hold `.`, `{` or `}`, so
those become `_` (`space/0.5` → `space.0_5`).

**CSS names.** A variable's WEB code syntax (`var(--color-surface-page)`) names its
custom property. Without one, the name is its path in kebab-case, without the collection:
`semantic/color/surface/page` → `--color-surface-page`. Two tokens with the same CSS name
are an error.

**Values.** The outputs hold resolved values, not `var()` references, because primitives
aren't output and a reference would break when a mode selector is set on an element below
`:root`.

**Units.** Number variables are px unless something says otherwise. In order:

| Rule | Written as |
| --- | --- |
| A `units` glob in the config matches | that unit |
| A path segment is `duration` | `ms` |
| A path segment is `opacity`, or every scope is `OPACITY` | unitless 0–1 (Figma's 0–100 ÷ 100) |
| Every scope is `FONT_WEIGHT` | unitless |
| Every scope is `LINE_HEIGHT` | unitless if every value is ≤ 5, otherwise `px` |
| Anything else (`GAP`, `CORNER_RADIUS`, `WIDTH_HEIGHT`, `ALL_SCOPES`, none, …) | `px` |

An alias written in a different unit than its target is converted (`250ms` → `250` for a
unitless token). An opacity can't alias a number that isn't one, since their scales differ.

**Modes.** Each collection's first mode is the default and goes under `css.selector`. Every
other mode name becomes a theme: under `css.modeSelector`, only the tokens whose value
differs in that mode are written. A theme applies to every collection that has a mode of
that name, and to every token that aliases into one, so a `component` token pointing at a
`semantic` color changes with it.

```css
:root {
  --color-surface-page: #fffbf2;
  --card-background: #fffbf2;
}
[data-theme="dark"] {
  --color-surface-page: #2b2620;
  --card-background: #2b2620;
}
```

The module holds the default values, and what differs in each other mode under
`tokens.$modes.<mode>`.

### Text styles

Each text style becomes a `typography` token under `text`, written to CSS as a `font`
shorthand named `--text-<style path>`:

```css
--text-body-md: 600 16px/1.4 "Nunito Sans";
--text-label-caps: italic 700 12px/16px Inter;
--text-label-caps-letter-spacing: 0.04em;
--text-label-caps-text-transform: uppercase;
--text-label-caps-text-decoration: underline;
```

- Font style names map to a weight and italic, with or without spaces: "SemiBold",
  "Semi Bold", "Bold Italic", "Black Oblique".
- Line height in % becomes unitless, in px stays px, and auto becomes `normal`.
- Letter spacing in % becomes `em`. It and text case and decoration are written as
  their own properties, and only when they aren't the default.
- A field bound to a variable is a reference in `tokens.json`.

The module holds each text style as an object: `fontFamily`, `fontWeight`, `fontStyle`,
`fontSize` (px number), `lineHeight`, `letterSpacing`, `textTransform`, `textDecoration`.

### Effect styles

Drop and inner shadows become `shadow` tokens under `effect`, written to CSS named by
their style path: `shadow/card` → `--shadow-card: 0px 1px 2px 0px #2b26201a, …`. Hidden
shadows are left out. Bound variables are references in `tokens.json`. In the module a
shadow is the same CSS string.

### Not supported in v0

These fail with `strict: true`, and are skipped with a warning with `strict: false`:

- Paint (color) styles and grid styles. Use color variables instead.
- Aliases to variables from a team library.
- Blur, noise, texture and glass effects. An effect style with only those is skipped.
- Text case small caps.
- Font style names that aren't a weight, like "Condensed Bold".

## Maintaining this repo

### Layout

```
src/
  cli.ts             argument parsing and the commands' output
  commands.ts        init, script, sync and build; JSON formatting; writing only what changed
  config.ts          loads and checks figma-mcp-tokens.config.json
  figma/export.js    the script that runs inside Figma (plain JS, no imports)
  agent/SKILL.md     the skill `init` installs; __CLI__ and __CONFIG__ are filled in
  dump.ts            reads the chunks, checks their checksums, joins them
  dtcg.ts            dump → DTCG tokens (units, modes, text and effect styles)
  build.ts           tokens.json → CSS and module (resolving references and modes)
  issues.ts          collects problems: an error with strict, warnings without
test/
  fake-figma.ts      a stand-in for the `figma` global that runs export.js in Node
  sample.ts          a sample design system and a temp project per test
  tokens.test.ts
scripts/build.mjs    compiles src/ → dist/; --check fails if dist/ is stale
dist/                compiled output: committed, see below
```

`src/figma/export.js` is never imported. `script` reads it as text, fills in
`__CHUNK__`, `__FILE_KEY__` and `__SAVE_DIR__`, and prints it. It has to stay valid in
Figma's plugin sandbox: plain JS, top-level `await`, no imports, and it ends in a `return`.
The tests run it against `test/fake-figma.ts`. When you change it in ways the fake can't
check, also run it once against a real file through `use_figma`.

`src/agent/SKILL.md` is also copied into `dist/` as is. It's what an agent follows, so when
a change affects the steps, an error message the skill quotes, or a command, update it too.

### Setup

```sh
pnpm install
pnpm test        # vitest
pnpm build       # compile src/ → dist/
pnpm check       # typecheck + tests + fail if dist/ is stale
```

### Why `dist/` is committed

Consumers install from GitHub, not npm. A git install only gets what's in git, and Node
can't run the TypeScript source. So the compiled `dist/` is committed with the source.
`pnpm check` fails when `dist/` doesn't match `src/`. **Run `pnpm build` before every
commit that touches `src/`.**

### Making a change

1. Change `src/`, and add or update a test.
2. `pnpm build && pnpm check`.
3. Commit the source and `dist/` together.

To support a new Figma feature, change these in order:

1. `src/figma/export.js`: read the new field and add it to the dump. Keep the format
   compact, because every byte counts toward the chunk limit.
2. `src/dump.ts`: add it to the dump types.
3. `src/dtcg.ts`: convert it to DTCG, or report it to `issues` if it can't be expressed.
4. `src/build.ts`: output it, if needed.
5. Add it to `test/fake-figma.ts` and `test/sample.ts`, and test each step. Move it out of
   [Not supported in v0](#not-supported-in-v0) in this README.

Changing the dump format breaks dumps saved by older versions. That's fine because dumps
aren't kept long, but bump `FORMAT` in `src/dump.ts` and `format` in `export.js` together.

### Releasing

Versions follow semver. A change that renames a CSS variable or module key in the outputs
is breaking: a minor version while on 0.x, a major one from 1.0.

```sh
# bump "version" in package.json, then:
pnpm build && pnpm check
git commit -am "Release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

### Updating a project to a new version

```sh
pnpm add -D github:tjones-dev/figma-mcp-tokens#v0.3.0
npx figma-mcp-tokens init     # refresh the skill and the AGENTS.md section
npx figma-mcp-tokens build    # regenerate outputs with the new version
```

Review the diff to the generated files before committing.

## Troubleshooting

**"Chunk N's checksum doesn't match"**: the result was cut off or changed on its way to
disk. Run that chunk's export again and save it exactly as returned.

**"Missing chunk N of M"**: save every chunk the export reported, then run `sync` again.

**"The chunks … come from different exports"**: the Figma file changed between chunks.
Delete the dump folder and export every chunk again.

**"This is file X; the config expects Y"**: the wrong Figma file is open, or the URL in
the config is wrong.

**"N problems: …"**: things this tool can't express yet. Change them in Figma, or set
`"strict": false` to skip them with a warning.

**A variable has the wrong unit**: give it the right scope in Figma, or add it to `units`
in the config.
