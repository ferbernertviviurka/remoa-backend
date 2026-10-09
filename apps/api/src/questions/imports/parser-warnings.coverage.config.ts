import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../../../../../packages/ai", import.meta.url)),
  test: {
    include: [
      "../../apps/api/src/questions/imports/parser-warnings*.test.ts",
      "../../apps/api/src/admin/questions/parser-warnings-http.test.ts",
    ],
    coverage: {
      enabled: true,
      allowExternal: true,
      provider: "v8",
      include: [
        fileURLToPath(new URL("./parser-warnings.ts", import.meta.url)),
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: "/private/tmp/remoa-ccr135-warnings-coverage",
    },
  },
});
