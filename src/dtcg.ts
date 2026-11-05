// Turns the Figma dump into DTCG tokens: one group per variable collection, text styles
// under `text`, effect styles under `effect`. Aliases stay references. A collection's first
// mode is each token's $value; the other modes go in $extensions["figma-mcp-tokens"].modes.
// Tier collections listed under `merge` become one merged group whose modes are every tier's
// modes, and aliases into a tier point at the merged group.
// Anything this can't express is reported to `issues` and left out.
import type { Config, Unit } from "./config.js";
import type { DumpBound, DumpCollection, DumpEffectStyle, DumpTextStyle, DumpValue, DumpVariable, FigmaDump } from "./dump.js";
import type { Issues } from "./issues.js";

/** The $extensions key this tool writes. */
export const EXT = "figma-mcp-tokens";
/** Top-level groups the styles go in. */
export const STYLE_GROUPS = ["text", "effect"];

export type Token = {
  $type: string;
  $value: unknown;
  $extensions?: Record<string, Record<string, unknown>>;
};
export type Group = { [key: string]: unknown };

/** A key for a token path: DTCG names can't hold ".", "{" or "}", or start with "$". */
export const tokenKey = (name: string) => name.replace(/[.{}]/g, "_").replace(/^\$/, "_");
const tokenPath = (name: string) => name.split("/").map((part) => tokenKey(part.trim()));

/** The unit of a number variable; opacity is a unitless number Figma keeps as 0–100. */
type NumberUnit = Unit | "opacity";

const TYPES = { c: "color", s: "string", b: "boolean" } as const;
const NUMBER_TYPES: Record<NumberUnit, string> = {
  px: "dimension",
  ms: "duration",
  none: "number",
  opacity: "number",
};

function glob(pattern: string): RegExp {
  const source = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/**
 * The unit of a number variable: a `units` override in the config, then `ms` for a
 * …/duration/… path, then the variable's scopes when they all agree, then px.
 */
function numberUnit(collection: string, variable: DumpVariable, config: Config): NumberUnit {
  const [name, , , scopes, ...values] = variable;
  for (const [pattern, unit] of Object.entries(config.units)) {
    if (glob(pattern).test(`${collection}/${name}`)) return unit;
  }
  const segments = name.toLowerCase().split("/");
  if (segments.includes("duration")) return "ms";
  if (segments.includes("opacity")) return "opacity";
  const only = (scope: string) => !!scopes && scopes.length > 0 && scopes.every((s) => s === scope);
  if (only("OPACITY")) return "opacity";
  if (only("FONT_WEIGHT")) return "none";
  if (only("LINE_HEIGHT")) {
    return values.every((v) => typeof v !== "number" || v <= 5) ? "none" : "px";
  }
  return "px";
}

const round = (n: number) => Math.round(n * 10000) / 10000;

function numberValue(n: number, unit: NumberUnit): string | number {
  if (unit === "px") return `${n}px`;
  if (unit === "ms") return `${n}ms`;
  if (unit === "opacity") return round(n / 100);
  return n;
}

const ALIAS = /^\{([^:?][^:]*):(.+)\}$/;

/** Tier collection → the merged collection it's part of, from the config's `merge`. */
type Merged = Map<string, string>;

function mergedNames(config: Config): Merged {
  return new Map(Object.entries(config.merge).flatMap(([name, tiers]) => tiers.map((tier) => [tier, name] as const)));
}

/** "{collection:a/b}" → "{collection.a.b}", with a tier collection replaced by its merged collection. */
function reference(alias: string, merged: Merged): string {
  const [, collection = "", name = ""] = ALIAS.exec(alias) ?? [];
  return `{${[tokenKey(merged.get(collection) ?? collection), ...tokenPath(name)].join(".")}}`;
}

/** Places a token in a nested group by its path; false if it can't, after reporting why. */
function place(root: Group, path: string[], token: Token, where: string, issues: Issues): boolean {
  let group = root;
  for (const key of path.slice(0, -1)) {
    const next = (group[key] ??= {}) as Group;
    if ("$value" in next) {
      issues.add(`${where}: ${path.join("/")} is inside the token ${key}; rename one of them.`);
      return false;
    }
    group = next;
  }
  const last = path.at(-1) ?? "";
  if (last in group) {
    issues.add(`${where}: the name ${path.join("/")} is used twice; rename one of them.`);
    return false;
  }
  group[last] = token;
  return true;
}

/** What a number variable is in each unit, for reporting a mismatch between tiers. */
const KINDS: Record<NumberUnit, string> = {
  px: "a dimension",
  ms: "a duration",
  none: "a number",
  opacity: "an opacity",
};

/**
 * Problems that would drop or mix whole tiers fail the sync even without `strict`: a tier
 * collection that isn't in the dump, a merge named like another collection, and a mode that's
 * in two tiers of one merge.
 */
function checkMerges(dump: FigmaDump, config: Config) {
  for (const [name, tiers] of Object.entries(config.merge)) {
    const fail = (message: string) => {
      throw new Error(`Merge ${name}: ${message}`);
    };
    for (const tier of tiers) {
      if (!dump.collections[tier]) fail(`no collection named ${tier} in the Figma file.`);
    }
    if (Object.keys(dump.collections).some((c) => !tiers.includes(c) && tokenKey(c) === tokenKey(name))) {
      fail("the name is taken by a collection in the Figma file; pick another merge name.");
    }
    const owners = new Map<string, string>();
    for (const tier of tiers) {
      for (const mode of dump.collections[tier]?.modes ?? []) {
        const owner = owners.get(mode);
        if (owner !== undefined) fail(`mode ${mode} is in both ${owner} and ${tier}; rename one.`);
        owners.set(mode, tier);
      }
    }
  }
}

function variables(dump: FigmaDump, config: Config, issues: Issues): Group {
  const merged = mergedNames(config);
  // A tier's units are worked out with the merged collection's name, and a merged variable
  // takes the unit of the first tier that has it, for every tier's values.
  const units = new Map<string, NumberUnit>();
  for (const [collection, { variables }] of Object.entries(dump.collections)) {
    const named = merged.get(collection) ?? collection;
    for (const variable of variables) {
      if (variable[1] === "n") units.set(`${collection}:${variable[0]}`, numberUnit(named, variable, config));
    }
  }
  const unitOf = (collection: string, name: string): NumberUnit | undefined => {
    const mergeName = merged.get(collection);
    const tiers = (mergeName === undefined ? undefined : config.merge[mergeName]) ?? [collection];
    const owner = tiers.find((tier) => units.has(`${tier}:${name}`)) ?? collection;
    return units.get(`${owner}:${name}`);
  };

  /** A tier's variables by name, for merging; `collectionGroup` adds each token it places. */
  type Placed = Map<string, Token>;
  const collectionGroup = (collection: string, { modes, variables }: DumpCollection, placed?: Placed): Group => {
    const group: Group = { $extensions: { [EXT]: { modes } } };
    for (const variable of variables) {
      const [name, type, web, , ...values] = variable;
      const where = `${collection}/${name}`;
      const unit = unitOf(collection, name);
      const value = (v: DumpValue | undefined): unknown => {
        if (typeof v === "string" && v.startsWith("{?")) {
          throw `aliases ${v.slice(2, -1)} from a library; library variables aren't supported yet.`;
        }
        if (typeof v === "string" && ALIAS.test(v)) {
          const [, targetCollection = "", targetName = ""] = ALIAS.exec(v) ?? [];
          const targetUnit = unitOf(targetCollection, targetName);
          if (unit && targetUnit && (unit === "opacity") !== (targetUnit === "opacity")) {
            throw `aliases ${targetCollection}/${targetName}, but only one of them is an opacity (0–100 in Figma). Scope both as opacity or neither.`;
          }
          return reference(v, merged);
        }
        if (type === "n") {
          if (typeof v !== "number") throw "expected a number.";
          return numberValue(v, unit ?? "px");
        }
        if (type === "c" && !(typeof v === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v))) {
          throw "expected a hex color.";
        }
        if (v === undefined) throw "has no value.";
        return v;
      };
      if (!(type in TYPES) && type !== "n") {
        issues.add(`${where}: variables of type ${type} aren't supported.`);
        continue;
      }
      let token: Token;
      try {
        token = modeToken(
          type === "n" ? NUMBER_TYPES[unit ?? "px"] : TYPES[type as keyof typeof TYPES],
          web,
          modes,
          values.map(value),
        );
      } catch (message) {
        issues.add(`${where} ${message}`);
        continue;
      }
      if (place(group, tokenPath(name), token, `Variable ${collection}`, issues)) placed?.set(name, token);
    }
    return group;
  };

  /** "a color", "a duration", "an opacity", …: what a variable is in one tier, unit included. */
  const kind = (tier: string, [name, type]: DumpVariable): string => {
    if (type === "n") return KINDS[units.get(`${tier}:${name}`) ?? "px"];
    return type in TYPES ? `a ${TYPES[type as keyof typeof TYPES]}` : `a ${type}`;
  };

  /**
   * One group for a merge: each tier is converted on its own (so problems name the tier), then
   * each token takes its value in every mode from the tier that owns the mode. A variable that
   * isn't in every tier, or isn't the same type and unit in every tier, is reported and left
   * out; one whose WEB code syntax differs is reported and keeps the first tier's.
   */
  const mergedGroup = (name: string, tiers: string[]): Group => {
    const present = tiers.map((tier) => {
      const collection = dump.collections[tier] as DumpCollection;
      const placed: Placed = new Map();
      collectionGroup(tier, collection, placed);
      return { tier, modes: collection.modes, dumped: new Map(collection.variables.map((v) => [v[0], v])), placed };
    });
    const modes = present.flatMap((tier) => tier.modes);
    const group: Group = { $extensions: { [EXT]: { modes, merged: tiers } } };
    const names = new Set(present.flatMap(({ dumped }) => [...dumped.keys()]));
    for (const variable of names) {
      const problem = (message: string) => issues.add(`Merge ${name}: ${variable} ${message}`);
      const owner = present.find(({ dumped }) => dumped.has(variable));
      const missing = present.filter(({ dumped }) => !dumped.has(variable));
      for (const { tier } of missing) problem(`is in ${owner?.tier} but not ${tier}.`);
      if (!owner || missing.length > 0) continue;

      const ownerVariable = owner.dumped.get(variable) as DumpVariable;
      let consistent = true;
      for (const { tier, dumped } of present.slice(1)) {
        const tierVariable = dumped.get(variable) as DumpVariable;
        const [first, other] = [kind(owner.tier, ownerVariable), kind(tier, tierVariable)];
        if (first !== other) {
          problem(`is ${first} in ${owner.tier} but ${other} in ${tier}.`);
          consistent = false;
        }
        const [firstWeb, otherWeb] = [ownerVariable[2] ?? "none", tierVariable[2] ?? "none"];
        if (firstWeb !== otherWeb) problem(`has WEB code syntax ${firstWeb} in ${owner.tier} but ${otherWeb} in ${tier}.`);
      }
      // A tier that couldn't convert the variable has already reported why.
      const parts = present.map(({ placed }) => placed.get(variable));
      if (!consistent || parts.some((part) => part === undefined)) continue;

      const values = present.flatMap(({ modes }, i) => {
        const part = parts[i] as Token;
        const other = (part.$extensions?.[EXT]?.["modes"] ?? {}) as Record<string, unknown>;
        return modes.map((mode, m) => (m > 0 && mode in other ? other[mode] : part.$value));
      });
      const first = parts[0] as Token;
      place(group, tokenPath(variable), modeToken(first.$type, ownerVariable[2], modes, values), `Variable ${name}`, issues);
    }
    return group;
  };

  checkMerges(dump, config);
  const tokens: Group = {};
  const done = new Set<string>();
  for (const [collection, dumped] of Object.entries(dump.collections)) {
    // A merged group takes the place of its first tier in the file.
    const mergeName = merged.get(collection);
    if (mergeName !== undefined) {
      if (done.has(mergeName)) continue;
      done.add(mergeName);
    }
    const name = mergeName ?? collection;
    const key = tokenKey(name);
    if (STYLE_GROUPS.includes(key) || key in tokens) {
      issues.add(`Collection ${name}: the name is taken; rename the collection.`);
      continue;
    }
    tokens[key] = mergeName ? mergedGroup(mergeName, config.merge[mergeName] ?? []) : collectionGroup(collection, dumped);
  }
  return tokens;
}

/** A token whose $value is the first mode's value; the other modes are kept where they differ. */
function modeToken(type: string, web: string | null, modes: string[], values: unknown[]): Token {
  const [first, ...rest] = values;
  const other: Record<string, unknown> = {};
  rest.forEach((v, i) => {
    if (v !== first) other[modes[i + 1] ?? ""] = v;
  });
  const extensions: Token["$extensions"] = {};
  if (web) extensions["com.figma"] = { codeSyntax: { WEB: web } };
  if (Object.keys(other).length > 0) extensions[EXT] = { modes: other };
  return {
    $type: type,
    $value: first,
    ...(Object.keys(extensions).length > 0 ? { $extensions: extensions } : {}),
  };
}

const WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  "": 400,
  regular: 400,
  normal: 400,
  book: 400,
  roman: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/** "Semi Bold Italic" → { weight: 600, italic: true } */
export function fontStyle(style: string): { weight: number; italic: boolean } | null {
  const compact = style.toLowerCase().replace(/[\s_-]/g, "");
  const italic = /italic|oblique/.test(compact);
  const weight = WEIGHTS[compact.replace(/italic|oblique/, "")];
  return weight === undefined ? null : { weight, italic };
}

const TEXT_CASE: Record<string, string> = {
  ORIGINAL: "none",
  UPPER: "uppercase",
  LOWER: "lowercase",
  TITLE: "capitalize",
};
const TEXT_DECORATION: Record<string, string> = {
  NONE: "none",
  UNDERLINE: "underline",
  STRIKETHROUGH: "line-through",
};

/** A bound variable's reference, or the literal value for an unbound or library field. */
function boundOr(bound: DumpBound | undefined, field: string, literal: unknown, merged: Merged): unknown {
  const alias = bound?.[field];
  return alias && ALIAS.test(alias) ? reference(alias, merged) : literal;
}

function textStyle(style: DumpTextStyle, merged: Merged): Token {
  const [, family, styleName, size, height, spacing, textCase, decoration, bound] = style;
  const font = fontStyle(styleName);
  if (!font) throw `font style ${styleName} isn't a weight this tool knows.`;
  const textTransform = TEXT_CASE[textCase];
  if (!textTransform) throw `text case ${textCase} isn't supported.`;
  const textDecoration = TEXT_DECORATION[decoration];
  if (!textDecoration) throw `text decoration ${decoration} isn't supported.`;

  let lineHeight: string | number;
  if (height === "auto") lineHeight = "normal";
  else if (height.endsWith("%")) lineHeight = round(Number(height.slice(0, -1)) / 100);
  else lineHeight = height;
  let letterSpacing: string;
  if (spacing.endsWith("%")) letterSpacing = `${round(Number(spacing.slice(0, -1)) / 100)}em`;
  else if (spacing === "auto") letterSpacing = "0px";
  else letterSpacing = spacing;

  return {
    $type: "typography",
    $value: {
      fontFamily: boundOr(bound, "fontFamily", family, merged),
      fontWeight: boundOr(bound, "fontWeight", font.weight, merged),
      fontStyle: font.italic ? "italic" : "normal",
      fontSize: boundOr(bound, "fontSize", `${size}px`, merged),
      lineHeight: boundOr(bound, "lineHeight", lineHeight, merged),
      letterSpacing: boundOr(bound, "letterSpacing", letterSpacing, merged),
      textTransform,
      textDecoration,
    },
  };
}

function effectStyle([name, effects]: DumpEffectStyle, merged: Merged, issues: Issues): Token | null {
  const shadows = effects.flatMap(([type, color, x, y, blur, spread, visible, bound]) => {
    if (type !== "DROP_SHADOW" && type !== "INNER_SHADOW") {
      issues.add(`Effect style ${name}: ${type} effects aren't supported; only shadows are.`);
      return [];
    }
    if (!visible) return [];
    return [
      {
        color: boundOr(bound, "color", color, merged),
        offsetX: boundOr(bound, "offsetX", `${x}px`, merged),
        offsetY: boundOr(bound, "offsetY", `${y}px`, merged),
        blur: boundOr(bound, "radius", `${blur}px`, merged),
        spread: boundOr(bound, "spread", `${spread}px`, merged),
        ...(type === "INNER_SHADOW" ? { inset: true } : {}),
      },
    ];
  });
  const hasShadow = effects.some(([type]) => type === "DROP_SHADOW" || type === "INNER_SHADOW");
  return hasShadow ? { $type: "shadow", $value: shadows } : null;
}

/** The DTCG tokens for a dump. */
export function toDtcg(dump: FigmaDump, config: Config, issues: Issues): Group {
  const tokens = variables(dump, config, issues);
  const merged = mergedNames(config);

  const text: Group = {};
  for (const style of dump.textStyles) {
    try {
      place(text, tokenPath(style[0]), textStyle(style, merged), "Text style", issues);
    } catch (message) {
      issues.add(`Text style ${style[0]}: ${message}`);
    }
  }
  if (Object.keys(text).length > 0) tokens["text"] = text;

  const effect: Group = {};
  for (const style of dump.effectStyles) {
    const token = effectStyle(style, merged, issues);
    if (token) place(effect, tokenPath(style[0]), token, "Effect style", issues);
  }
  if (Object.keys(effect).length > 0) tokens["effect"] = effect;
  return tokens;
}
