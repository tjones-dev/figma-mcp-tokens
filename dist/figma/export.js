// Pass this whole script, unchanged, as the code of the Figma MCP use_figma tool.
// Runs inside Figma through the Figma MCP server's `use_figma` tool, not in Node:
// `figma-mcp-tokens script` fills in the placeholders below and prints this file. It only
// reads. It dumps every local variable (with aliases, scopes and WEB code syntax) and every
// text and effect style, then returns one chunk of the dump:
//
//   collections: { <name>: { modes: [<mode>…], variables: [[name, type, web, scopes, value…]] } }
//     type is c (color), n (number), s (string) or b (boolean); web is the WEB code syntax
//     or null; scopes is the variable's scopes for numbers, null otherwise; there is one
//     value per mode: "#rrggbb" or "#rrggbbaa" for colors, "{collection:name}" for an alias,
//     "{?name}" for an alias to a variable outside this file.
//   textStyles: [[name, family, style, size, lineHeight, letterSpacing, case, decoration, bound]]
//     lineHeight and letterSpacing are "125%", "20px" or "auto"; bound maps a field to an alias.
//   effectStyles: [[name, [[type, color, x, y, blur, spread, visible, bound]…]]]
//
// Tool results longer than about 20 KB are cut off before they reach the client, so the
// dump's JSON text is split into chunks. Each carries a checksum of its own slice and of the
// whole text (FNV-1a, matched by fnv1a() in src/dump.ts), so a chunk copied wrongly or taken
// from a different export is refused.

const CHUNK = __CHUNK__;
const FILE_KEY = __FILE_KEY__;
const SAVE_DIR = __SAVE_DIR__;
// Escaped characters of dump text per chunk; the rest of the 18 KB is the chunk's wrapper.
const BUDGET = 16000;

const round = (n) => Math.round(n * 10000) / 10000;
const hex = (n) => n.toString(16).padStart(2, "0");
const color = (c) => {
  const alpha = Math.round((c.a ?? 1) * 255);
  const rgb = hex(Math.round(c.r * 255)) + hex(Math.round(c.g * 255)) + hex(Math.round(c.b * 255));
  return `#${rgb}${alpha === 255 ? "" : hex(alpha)}`;
};
const typeCode = { COLOR: "c", FLOAT: "n", STRING: "s", BOOLEAN: "b" };

if (FILE_KEY && figma.fileKey && figma.fileKey !== FILE_KEY) {
  throw new Error(
    `This is file ${figma.fileKey}; the config expects ${FILE_KEY}. Open the right file or fix the config.`,
  );
}

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const byId = new Map();
for (const variable of await figma.variables.getLocalVariablesAsync()) {
  byId.set(variable.id, variable);
}
const collectionName = new Map(collections.map((c) => [c.id, c.name]));

const alias = async (id) => {
  const target = byId.get(id);
  if (target) return `{${collectionName.get(target.variableCollectionId)}:${target.name}}`;
  const remote = await figma.variables.getVariableByIdAsync(id).catch(() => null);
  return `{?${remote ? remote.name : id}}`;
};

const value = async (raw) => {
  if (typeof raw === "object" && raw !== null && raw.type === "VARIABLE_ALIAS") return alias(raw.id);
  if (typeof raw === "number") return round(raw);
  if (typeof raw === "object" && raw !== null && "r" in raw) return color(raw);
  return raw;
};

/** { field: alias } for a style's or effect's bound variables, or null if none. */
const bound = async (boundVariables) => {
  const entries = Object.entries(boundVariables ?? {}).filter(([, a]) => a && a.id);
  if (entries.length === 0) return null;
  const result = {};
  for (const [field, a] of entries) result[field] = await alias(a.id);
  return result;
};

const exported = {};
for (const collection of collections) {
  const variables = [];
  for (const id of collection.variableIds) {
    const variable = byId.get(id);
    if (!variable) continue;
    const values = [];
    for (const mode of collection.modes) values.push(await value(variable.valuesByMode[mode.modeId]));
    variables.push([
      variable.name,
      typeCode[variable.resolvedType],
      variable.codeSyntax.WEB ?? null,
      variable.resolvedType === "FLOAT" ? variable.scopes : null,
      ...values,
    ]);
  }
  exported[collection.name] = { modes: collection.modes.map((mode) => mode.name), variables };
}

const measure = (m) =>
  m.unit === "AUTO" ? "auto" : `${round(m.value)}${m.unit === "PERCENT" ? "%" : "px"}`;
const textStyles = [];
for (const style of await figma.getLocalTextStylesAsync()) {
  textStyles.push([
    style.name,
    style.fontName.family,
    style.fontName.style,
    round(style.fontSize),
    measure(style.lineHeight),
    measure(style.letterSpacing),
    style.textCase,
    style.textDecoration,
    await bound(style.boundVariables),
  ]);
}

const effectStyles = [];
for (const style of await figma.getLocalEffectStylesAsync()) {
  const effects = [];
  for (const effect of style.effects) {
    effects.push(
      effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW"
        ? [
            effect.type,
            color(effect.color),
            round(effect.offset.x),
            round(effect.offset.y),
            round(effect.radius),
            round(effect.spread ?? 0),
            effect.visible,
            await bound(effect.boundVariables),
          ]
        : [effect.type],
    );
  }
  effectStyles.push([style.name, effects]);
}

const fnv1a = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const text = JSON.stringify({
  file: figma.fileKey ?? null,
  collections: exported,
  textStyles,
  effectStyles,
});

// Split the text so each slice, escaped as a JSON string, stays within BUDGET.
const slices = [];
let start = 0;
do {
  let end = start;
  let size = 0;
  while (end < text.length) {
    const escaped = JSON.stringify(text[end]).length - 2;
    if (size + escaped > BUDGET) break;
    size += escaped;
    end++;
  }
  slices.push(text.slice(start, end));
  start = end;
} while (start < text.length);

if (CHUNK < 1 || CHUNK > slices.length) {
  throw new Error(`There are ${slices.length} chunks; chunk ${CHUNK} doesn't exist.`);
}
const data = slices[CHUNK - 1];
return {
  format: "figma-mcp-tokens/1",
  saveAs: `${SAVE_DIR}/${CHUNK}.json`,
  next:
    CHUNK < slices.length
      ? `Save this result, then run \`figma-mcp-tokens script --chunk ${CHUNK + 1}\`.`
      : "Save this result, then run `figma-mcp-tokens sync`.",
  chunk: CHUNK,
  chunks: slices.length,
  export: fnv1a(text),
  checksum: fnv1a(data),
  data,
};
