import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // The engine must stay usable as a library, so it may not reach for the renderer. A lint rule is
  // the only version of this boundary that survives contact with a deadline.
  // See docs/decisions.md — "Engine and TUI share nothing but a typed event stream".
  {
    files: ["src/engine/**", "src/metrics/**", "src/config/**", "src/report/**", "src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/tui", "**/tui/**"],
              message:
                "The engine and its consumers must not import the TUI. The renderer subscribes to the engine's event stream, never the other way round (docs/decisions.md).",
            },
          ],
        },
      ],
    },
  },

  prettier,
);
