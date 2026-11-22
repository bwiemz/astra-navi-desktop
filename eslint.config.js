import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The microphone worklet is plain JavaScript that runs on the browser's audio thread.
  { ignores: ["out/**", "node_modules/**", "src/renderer/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
