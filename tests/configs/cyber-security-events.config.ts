import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "cyber-security-events",
  environment: "happy-dom",
  testFiles: [
    "src/lib/security/cyber-security-signals.test.ts",
    "src/lib/security/security-event-recorder.test.ts",
    "src/lib/security/cyber-containment.test.ts",
  ],
  sourceFiles: [
    "src/lib/security/cyber-security-signals.ts",
    "src/lib/security/security-event-recorder.ts",
    "src/lib/security/cyber-containment.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
