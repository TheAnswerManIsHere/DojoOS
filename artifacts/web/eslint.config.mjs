import parser from "@typescript-eslint/parser";

export default [
  {
    files: ["server/**/*.ts"],
    languageOptions: { parser },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "(^\\.\\./(?!\\.)[^/]+/.+)|(^.*modules/[^/]+/.+)",
          message: "Import another module only through its public index.",
        }],
      }],
    },
  },
];