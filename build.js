// @ts-check
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/content.ts"],
  bundle: true,
  outdir: "dist",
  platform: "browser",
  target: "chrome100",
  format: "iife",
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("Watching for changes…");
  } else {
    await esbuild.build(options);
  }
}

main().catch(() => process.exit(1));
