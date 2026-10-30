import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".wrangler/**", "dist/**", ".dev.vars"],
  },
  ...tseslint.configs.recommended,
);
