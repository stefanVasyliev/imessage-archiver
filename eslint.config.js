import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
    {
        ignores: ["dist/**", "node_modules/**", "storage/**", "logs/**", "reports/**"]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: true
            }
        },
        rules: {
            "no-console": "off"
        }
    }
];