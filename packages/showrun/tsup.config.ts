import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  // Bundle all workspace dependencies
  noExternal: [
    '@showrun/core',
    '@showrun/harness',
    '@showrun/mcp-server',
    '@showrun/dashboard',
    '@showrun/browser-inspector-mcp',
    '@showrun/taskpack-editor-mcp',
  ],
  // Keep native modules and heavy dependencies external
  // @showrun/techniques is external because it's lazily loaded via dynamic import
  // and brings in weaviate-client which must resolve from the techniques package
  external: [
    'playwright',
    'camoufox-js',
    'better-sqlite3',
    'express',
    'socket.io',
    'socket.io-client',
    'cors',
    'uuid',
    'winston',
    'dotenv',
    'nunjucks',
    'jmespath',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    '@showrun/techniques',
  ],
  esbuildOptions(options) {
    options.banner = {
      js: 'import { createRequire } from "module";\nconst require = createRequire(import.meta.url);',
    };
  },
});
