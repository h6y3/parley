import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep each entry self-contained. With splitting on, tsup hoists the shared
  // code (including cli.ts's `import.meta.url === argv` self-invocation guard)
  // into a chunk, so the guard's import.meta.url no longer equals the invoked
  // dist/cli.js path and `main()` never runs when the bin is executed.
  splitting: false,
  target: "node20"
});
