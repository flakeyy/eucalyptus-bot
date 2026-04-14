const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        // Node.js globals
        require: true,
        module: true,
        exports: true,
        process: true,
        __dirname: true,
        Buffer: true,
        console: true,
        setInterval: true,
        clearInterval: true,
        setTimeout: true,
        clearTimeout: true,
        global: true,
        fetch: true,
        // Test globals
        jest: true,
        describe: true,
        test: true,
        expect: true,
        afterEach: true,
        beforeEach: true,
        beforeAll: true,
        afterAll: true
      }
    },
    rules: {
      // Disable rule for unpublished requires in tests
      "node/no-unpublished-require": "off",
      // Spacing and Formatting
      indent: [ "error", 2 ],
      "array-bracket-spacing": [ "error", "always" ],
      "object-curly-spacing": [ "error", "always" ],
      "arrow-spacing": [ "error", { before: true, after: true } ],
      "max-len": [ "error", {
        code: 150,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreComments: true,
        ignoreRegExpLiterals: true
      } ],

      // Quotes and Strings
      quotes: [ "error", "double" ],
      "template-curly-spacing": [ "error", "never" ],

      // Semicolons and Commas
      semi: [ "error", "always" ],
      "comma-dangle": [ "error", "never" ],
      "comma-spacing": [ "error", { before: false, after: true } ],
      "comma-style": [ "error", "last" ],

      // Functions and Arrows
      "arrow-parens": [ "error", "as-needed" ],
      "space-before-function-paren": [ "error", {
        anonymous: "never",
        named: "never",
        asyncArrow: "always"
      } ],

      // Variables and Equality
      "prefer-const": "error",
      eqeqeq: "error",

      // General Style
      "no-multiple-empty-lines": [ "error", { max: 1 } ],
      "no-trailing-spaces": "error",
      "eol-last": [ "error", "always" ],
      "key-spacing": [ "error", { beforeColon: false, afterColon: true } ],
      "keyword-spacing": [ "error", { before: true, after: true } ],
      "space-infix-ops": "error",
      "space-before-blocks": "error",

      // Disabled Rules
      "no-var": "error",
      "no-console": "off"
    }
  }
];
