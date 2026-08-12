import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "responses-stream-gate",
  environment: "node",
  testFiles: [
    "tests/unit/proxy/responses-stream-frame-classifier.test.ts",
    "tests/unit/proxy/responses-stream-sse-frames.test.ts",
    "tests/unit/proxy/responses-stream-content-gate.test.ts",
    "tests/unit/proxy/responses-stream-shadow-observer.test.ts",
    "tests/unit/proxy/responses-stream-gate-config-resolution.test.ts",
    "tests/unit/proxy/responses-stream-gate-resources.test.ts",
    "tests/unit/proxy/streaming-response-gate.test.ts",
  ],
  sourceFiles: [
    "src/app/v1/_lib/proxy/stream-gate/**/*.ts",
    "src/app/v1/_lib/proxy/streaming-response-gate.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
