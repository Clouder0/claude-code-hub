import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "policy-security-events",
  environment: "happy-dom",
  testFiles: [
    "src/lib/security/security-signals.test.ts",
    "src/lib/security/security-event-recorder.test.ts",
    "src/lib/security/policy-containment.test.ts",
  ],
  sourceFiles: [
    "src/lib/security/security-signals.ts",
    "src/lib/security/security-event-recorder.ts",
    "src/lib/security/policy-containment.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
