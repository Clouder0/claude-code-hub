import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "codex-request-retention",
  environment: "happy-dom",
  testFiles: ["tests/unit/proxy/request-retention.test.ts"],
  sourceFiles: ["src/app/v1/_lib/proxy/request-retention.ts"],
  thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
});
