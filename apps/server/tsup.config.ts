import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  outDir: 'dist',
  clean: true,
  outExtension() {
    return { js: '.cjs' };
  },
  noExternal: ['@gateway/db', '@gateway/shared', '@gateway/protocol'],
});
