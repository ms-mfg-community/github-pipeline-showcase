import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Flat config. Covers the TypeScript application, the .mjs harness scripts, and the
// config files themselves — verified by running `eslint . --debug` and confirming every
// file is listed, because a lint leg that silently inspects nothing passes for free.
export default tseslint.config(
    { ignores: ["dist/**", "coverage/**", "node_modules/**", ".venv/**", ".deploy/**", "public/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.mjs", "**/*.js"],
        languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    },
    {
        files: ["src/**/*.ts", "test/**/*.ts", "*.config.ts"],
        languageOptions: { globals: { ...globals.node } },
    },
);
