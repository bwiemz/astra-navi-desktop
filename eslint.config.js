import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The microphone worklet is plain JavaScript that runs on the browser's audio thread.
  {
    ignores: [
      "out/**",
      "dist/**",
      "node_modules/**",
      "src/renderer/public/**",
      "hands/win-hands-native/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["browser-bridge/*.js"],
    languageOptions: {
      globals: {
        chrome: "readonly",
        browser: "readonly",
        window: "readonly",
        document: "readonly",
        location: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["browser-bridge/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
