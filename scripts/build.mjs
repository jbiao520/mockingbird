import { build } from 'esbuild';
await build({entryPoints:['server/index.ts'],outfile:'dist/server.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',sourcemap:true});
await build({entryPoints:['server/analysis-worker.ts'],outfile:'dist/analysis-worker.mjs',bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',sourcemap:true});
// Electron entry uses an async IIFE because CommonJS cannot contain top-level await.
await build({stdin:{contents:'import "./electron/main.ts";',resolveDir:process.cwd()},outfile:'dist/main.cjs',bundle:true,platform:'node',format:'cjs',external:['electron'],target:'node22',sourcemap:true,banner:{js:'(async () => {'},footer:{js:'})();'}});
