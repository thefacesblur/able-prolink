import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
const AdmZip = createRequire(import.meta.url)("adm-zip") as typeof import("adm-zip");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options: esbuild.BuildOptions = {
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  // Stub native/filesystem-heavy modules so they bundle as empty objects rather than
  // emitting require() calls. The Extension Host's Node.js permission model blocks
  // require() resolution (filesystem traversal) for modules not present on disk.
  alias: {
    "better-sqlite3": path.resolve("src/stubs/better-sqlite3.js"),
    "iconv-lite":     path.resolve("src/stubs/iconv-lite.js"),
  },
  define: {
    // Extension Host sandbox doesn't expose Node.js `global`; globalThis is always available
    "global": "globalThis",
  },
};

// Beat Link API JAR — searched in order, first found wins
const JAR_CANDIDATES = [
  path.resolve(process.env.USERPROFILE ?? "", "development", "beat-link-dashboard", "api-server", "target", "uberjar", "beat-link-api-standalone.jar"),
  path.resolve(process.env.USERPROFILE ?? "", "development", "dj-set-capture",      "api-server", "target", "uberjar", "beat-link-api-standalone.jar"),
];

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(options);

  // Copy beat-link-api.jar to dist/
  const jarSrc = JAR_CANDIDATES.find(p => fs.existsSync(p));
  const jarDst = path.resolve(path.dirname(manifest.entry), "beat-link-api.jar");
  if (jarSrc) {
    fs.copyFileSync(jarSrc, jarDst);
    const sizeMB = (fs.statSync(jarDst).size / 1_048_576).toFixed(1);
    console.log(`  beat-link-api.jar  ${sizeMB}mb`);
  } else {
    console.warn("  beat-link-api.jar  NOT FOUND — auto-launch unavailable");
  }

  // Build the .ablx (ZIP) including the JAR.
  // extensions-cli package only includes the manifest entry file, so we zip manually.
  const ablxName = `${manifest.name}-${manifest.version}.ablx`;
  const zip = new AdmZip();
  zip.addLocalFile("manifest.json");
  zip.addLocalFile(manifest.entry, "dist");
  if (jarSrc) zip.addLocalFile(jarDst, "dist");
  zip.writeZip(ablxName);
  const ablxMB = (fs.statSync(ablxName).size / 1_048_576).toFixed(1);
  console.log(`  ${ablxName}  ${ablxMB}mb`);
}