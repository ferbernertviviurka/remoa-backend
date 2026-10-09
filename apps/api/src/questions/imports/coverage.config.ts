import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../../../../../packages/ai", import.meta.url)),
  test: {
    include: ["../../apps/api/src/questions/imports/{domain,worker}.test.ts"],
    coverage: {
      enabled: true,
      allowExternal: true,
      provider: "v8",
      include: [
        fileURLToPath(new URL("./{domain,worker}.ts", import.meta.url)),
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: fileURLToPath(new URL("./coverage", import.meta.url)),
    },
  },
});
