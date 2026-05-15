const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const BUNDLE_LIMIT_BYTES = 500 * 1024; // 500KB — Danfo Test hard limit

async function build() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    minify: production,
    sourcemap: !production ? 'inline' : false,
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();

    const outPath = path.join(__dirname, 'dist', 'extension.js');
    const { size } = fs.statSync(outPath);
    const kb = (size / 1024).toFixed(1);

    if (size > BUNDLE_LIMIT_BYTES) {
      console.error(`\n[DANFO TEST FAILED] Bundle is ${kb}KB — exceeds 500KB limit. Trim dependencies.\n`);
      process.exit(1);
    } else {
      console.log(`\n[DANFO TEST PASSED] Bundle: ${kb}KB / 500KB limit\n`);
    }
  }
}

build().catch(() => process.exit(1));
