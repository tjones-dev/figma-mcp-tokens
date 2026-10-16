// Compiles src/ into dist/ and copies the Figma export script next to it.
// With --check, builds into a temporary folder instead and fails if dist/ differs.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const out = check ? mkdtempSync(join(tmpdir(), "figma-mcp-tokens-")) : join(root, "dist");

rmSync(out, { recursive: true, force: true });
execFileSync(
  join(root, "node_modules/.bin/tsc"),
  ["-p", join(root, "tsconfig.build.json"), "--outDir", out],
  { stdio: "inherit" },
);
cpSync(join(root, "src/figma/export.js"), join(out, "figma/export.js"));
chmodSync(join(out, "cli.js"), 0o755);

if (check) {
  const files = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => relative(dir, join(d.parentPath, d.name)))
      .sort();
  const dist = join(root, "dist");
  const built = files(out);
  const stale =
    !existsSync(dist) ||
    built.join() !== files(dist).join() ||
    built.some((f) => !readFileSync(join(out, f)).equals(readFileSync(join(dist, f))));
  rmSync(out, { recursive: true, force: true });
  if (stale) {
    console.error("dist/ doesn't match src/. Run `pnpm build` and commit dist/.");
    process.exit(1);
  }
  console.log("dist/ is up to date.");
}
