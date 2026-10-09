import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("../../../../../packages/ai", import.meta.url)),
  test: {
    include: [
      "../../apps/api/src/admin/questions/page-image.integration.test.ts",
      "../../apps/api/src/questions/imports/manual-page-image.test.ts",
    ],
    setupFiles: [
      fileURLToPath(
        new URL("../../questions/privacy/test-db.ts", import.meta.url),
      ),
    ],
    coverage: {
      enabled: true,
      allowExternal: true,
      provider: "v8",
      include: [
        fileURLToPath(
          new URL(
            "../../questions/imports/manual-page-image.ts",
            import.meta.url,
          ),
        ),
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: fileURLToPath(
        new URL("./coverage-page-image", import.meta.url),
      ),
    },
  },
});
