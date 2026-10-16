/** The $extensions key this tool writes. */
export const EXT = "figma-mcp-tokens";
/** Top-level groups the styles go in. */
export const STYLE_GROUPS = ["text", "effect"];
/** A key for a token path: DTCG names can't hold ".", "{" or "}", or start with "$". */
export const tokenKey = (name) => name.replace(/[.{}]/g, "_").replace(/^\$/, "_");
const tokenPath = (name) => name.split("/").map((part) => tokenKey(part.trim()));
const TYPES = { c: "color", s: "string", b: "boolean" };
const NUMBER_TYPES = {
    px: "dimension",
    ms: "duration",
    none: "number",
    opacity: "number",
};
function glob(pattern) {
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
function numberUnit(collection, variable, config) {
    const [name, , , scopes, ...values] = variable;
    for (const [pattern, unit] of Object.entries(config.units)) {
        if (glob(pattern).test(`${collection}/${name}`))
            return unit;
    }
    const segments = name.toLowerCase().split("/");
    if (segments.includes("duration"))
        return "ms";
    if (segments.includes("opacity"))
        return "opacity";
    const only = (scope) => !!scopes && scopes.length > 0 && scopes.every((s) => s === scope);
    if (only("OPACITY"))
        return "opacity";
    if (only("FONT_WEIGHT"))
        return "none";
    if (only("LINE_HEIGHT")) {
        return values.every((v) => typeof v !== "number" || v <= 5) ? "none" : "px";
    }
    return "px";
}
const round = (n) => Math.round(n * 10000) / 10000;
function numberValue(n, unit) {
    if (unit === "px")
        return `${n}px`;
    if (unit === "ms")
        return `${n}ms`;
    if (unit === "opacity")
        return round(n / 100);
    return n;
}
const ALIAS = /^\{([^:?][^:]*):(.+)\}$/;
/** "{collection:a/b}" → "{collection.a.b}" */
function reference(alias) {
    const [, collection = "", name = ""] = ALIAS.exec(alias) ?? [];
    return `{${[tokenKey(collection), ...tokenPath(name)].join(".")}}`;
}
/** Places a token in a nested group by its path. */
function place(root, path, token, where, issues) {
    let group = root;
    for (const key of path.slice(0, -1)) {
        const next = (group[key] ??= {});
        if ("$value" in next) {
            issues.add(`${where}: ${path.join("/")} is inside the token ${key}; rename one of them.`);
            return;
        }
        group = next;
    }
    const last = path.at(-1) ?? "";
    if (last in group) {
        issues.add(`${where}: the name ${path.join("/")} is used twice; rename one of them.`);
        return;
    }
    group[last] = token;
}
function variables(dump, config, issues) {
    const tokens = {};
    const units = new Map();
    for (const [collection, { variables }] of Object.entries(dump.collections)) {
        for (const variable of variables) {
            if (variable[1] === "n")
                units.set(`${collection}:${variable[0]}`, numberUnit(collection, variable, config));
        }
    }
    for (const [collection, { modes, variables }] of Object.entries(dump.collections)) {
        const key = tokenKey(collection);
        if (STYLE_GROUPS.includes(key) || key in tokens) {
            issues.add(`Collection ${collection}: the name is taken; rename the collection.`);
            continue;
        }
        const group = { $extensions: { [EXT]: { modes } } };
        for (const variable of variables) {
            const [name, type, web, , ...values] = variable;
            const where = `${collection}/${name}`;
            const unit = units.get(`${collection}:${name}`);
            const value = (v) => {
                if (typeof v === "string" && v.startsWith("{?")) {
                    throw `aliases ${v.slice(2, -1)} from a library; library variables aren't supported yet.`;
                }
                if (typeof v === "string" && ALIAS.test(v)) {
                    const [, targetCollection = "", targetName = ""] = ALIAS.exec(v) ?? [];
                    const targetUnit = units.get(`${targetCollection}:${targetName}`);
                    if (unit && targetUnit && (unit === "opacity") !== (targetUnit === "opacity")) {
                        throw `aliases ${targetCollection}/${targetName}, but only one of them is an opacity (0–100 in Figma). Scope both as opacity or neither.`;
                    }
                    return reference(v);
                }
                if (type === "n") {
                    if (typeof v !== "number")
                        throw "expected a number.";
                    return numberValue(v, unit ?? "px");
                }
                if (type === "c" && !(typeof v === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v))) {
                    throw "expected a hex color.";
                }
                if (v === undefined)
                    throw "has no value.";
                return v;
            };
            if (!(type in TYPES) && type !== "n") {
                issues.add(`${where}: variables of type ${type} aren't supported.`);
                continue;
            }
            let token;
            try {
                const [first, ...rest] = values.map(value);
                const other = {};
                rest.forEach((v, i) => {
                    if (v !== first)
                        other[modes[i + 1] ?? ""] = v;
                });
                const extensions = {};
                if (web)
                    extensions["com.figma"] = { codeSyntax: { WEB: web } };
                if (Object.keys(other).length > 0)
                    extensions[EXT] = { modes: other };
                token = {
                    $type: type === "n" ? NUMBER_TYPES[unit ?? "px"] : TYPES[type],
                    $value: first,
                    ...(Object.keys(extensions).length > 0 ? { $extensions: extensions } : {}),
                };
            }
            catch (message) {
                issues.add(`${where} ${message}`);
                continue;
            }
            place(group, tokenPath(name), token, `Variable ${collection}`, issues);
        }
        tokens[key] = group;
    }
    return tokens;
}
const WEIGHTS = {
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
export function fontStyle(style) {
    const compact = style.toLowerCase().replace(/[\s_-]/g, "");
    const italic = /italic|oblique/.test(compact);
    const weight = WEIGHTS[compact.replace(/italic|oblique/, "")];
    return weight === undefined ? null : { weight, italic };
}
const TEXT_CASE = {
    ORIGINAL: "none",
    UPPER: "uppercase",
    LOWER: "lowercase",
    TITLE: "capitalize",
};
const TEXT_DECORATION = {
    NONE: "none",
    UNDERLINE: "underline",
    STRIKETHROUGH: "line-through",
};
/** A bound variable's reference, or the literal value for an unbound or library field. */
function boundOr(bound, field, literal) {
    const alias = bound?.[field];
    return alias && ALIAS.test(alias) ? reference(alias) : literal;
}
function textStyle(style) {
    const [, family, styleName, size, height, spacing, textCase, decoration, bound] = style;
    const font = fontStyle(styleName);
    if (!font)
        throw `font style ${styleName} isn't a weight this tool knows.`;
    const textTransform = TEXT_CASE[textCase];
    if (!textTransform)
        throw `text case ${textCase} isn't supported.`;
    const textDecoration = TEXT_DECORATION[decoration];
    if (!textDecoration)
        throw `text decoration ${decoration} isn't supported.`;
    let lineHeight;
    if (height === "auto")
        lineHeight = "normal";
    else if (height.endsWith("%"))
        lineHeight = round(Number(height.slice(0, -1)) / 100);
    else
        lineHeight = height;
    let letterSpacing;
    if (spacing.endsWith("%"))
        letterSpacing = `${round(Number(spacing.slice(0, -1)) / 100)}em`;
    else if (spacing === "auto")
        letterSpacing = "0px";
    else
        letterSpacing = spacing;
    return {
        $type: "typography",
        $value: {
            fontFamily: boundOr(bound, "fontFamily", family),
            fontWeight: boundOr(bound, "fontWeight", font.weight),
            fontStyle: font.italic ? "italic" : "normal",
            fontSize: boundOr(bound, "fontSize", `${size}px`),
            lineHeight: boundOr(bound, "lineHeight", lineHeight),
            letterSpacing: boundOr(bound, "letterSpacing", letterSpacing),
            textTransform,
            textDecoration,
        },
    };
}
function effectStyle([name, effects], issues) {
    const shadows = effects.flatMap(([type, color, x, y, blur, spread, visible, bound]) => {
        if (type !== "DROP_SHADOW" && type !== "INNER_SHADOW") {
            issues.add(`Effect style ${name}: ${type} effects aren't supported; only shadows are.`);
            return [];
        }
        if (!visible)
            return [];
        return [
            {
                color: boundOr(bound, "color", color),
                offsetX: boundOr(bound, "offsetX", `${x}px`),
                offsetY: boundOr(bound, "offsetY", `${y}px`),
                blur: boundOr(bound, "radius", `${blur}px`),
                spread: boundOr(bound, "spread", `${spread}px`),
                ...(type === "INNER_SHADOW" ? { inset: true } : {}),
            },
        ];
    });
    const hasShadow = effects.some(([type]) => type === "DROP_SHADOW" || type === "INNER_SHADOW");
    return hasShadow ? { $type: "shadow", $value: shadows } : null;
}
/** The DTCG tokens for a dump. */
export function toDtcg(dump, config, issues) {
    const tokens = variables(dump, config, issues);
    const text = {};
    for (const style of dump.textStyles) {
        try {
            place(text, tokenPath(style[0]), textStyle(style), "Text style", issues);
        }
        catch (message) {
            issues.add(`Text style ${style[0]}: ${message}`);
        }
    }
    if (Object.keys(text).length > 0)
        tokens["text"] = text;
    const effect = {};
    for (const style of dump.effectStyles) {
        const token = effectStyle(style, issues);
        if (token)
            place(effect, tokenPath(style[0]), token, "Effect style", issues);
    }
    if (Object.keys(effect).length > 0)
        tokens["effect"] = effect;
    return tokens;
}
