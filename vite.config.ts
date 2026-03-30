import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    format: ["esm"],
    sourcemap: true,
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["dist/**"],
  },
});
