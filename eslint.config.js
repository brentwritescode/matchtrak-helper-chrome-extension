const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  { ignores: ["dist/**", "build.js", "jest.config.js"] },
  eslint.configs.recommended,
  tseslint.configs.recommended
);
