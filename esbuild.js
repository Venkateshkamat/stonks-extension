// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyMedia() {
  const mediaDir = path.join(__dirname, 'dist', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const chartSrc = path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
  fs.copyFileSync(chartSrc, path.join(mediaDir, 'chart.umd.min.js'));
  // Static webview assets (added in a later phase) live in ./media.
  const own = path.join(__dirname, 'media');
  if (fs.existsSync(own)) {
    for (const f of fs.readdirSync(own)) {
      fs.copyFileSync(path.join(own, f), path.join(mediaDir, f));
    }
  }
}

/** @type {import('esbuild').Plugin} */
const watchLogPlugin = {
  name: 'watch-log',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const e of result.errors) console.error(`ERROR: ${e.text}`);
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: watch ? [watchLogPlugin] : [],
  });
  copyMedia();
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
