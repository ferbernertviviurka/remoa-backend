import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../../../../../packages/ai", import.meta.url)),
  test: {
    include: ["../../apps/api/src/questions/pdf/corpus-eval.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      allowExternal: true,
      include: [fileURLToPath(new URL("./corpus-eval.ts", import.meta.url))],
      reporter: ["text", "json-summary"],
      reportsDirectory: fileURLToPath(new URL("./coverage-corpus-eval", import.meta.url)),
    },
  },
});
