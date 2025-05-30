module.exports = {
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.js"],
  collectCoverageFrom: ["lib/**/*.js", "!lib/utils/execAsync.js"],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
