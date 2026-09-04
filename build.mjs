import * as esbuild from 'esbuild';

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  loader: { '.css': 'text' },
  target: ['es2020'],
};

await esbuild.build({
  ...shared,
  outfile: 'dist/focus-timer.js',
  minify: false,
});

await esbuild.build({
  ...shared,
  outfile: 'dist/focus-timer.min.js',
  minify: true,
});

console.log('build complete: dist/focus-timer.js, dist/focus-timer.min.js');
