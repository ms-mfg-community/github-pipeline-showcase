import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Scoped deliberately. Vitest's default glob would collect scripts/gate.test.mjs,
        // which is a node:test suite rather than a vitest one, and fail on its syntax.
        // Both src and test are included so a test placed in either location still runs —
        // a silently uncollected test is worse than a loose directory convention.
        include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        environment: "node",
    },
});
