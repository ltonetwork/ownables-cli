const { build } = require("../lib/commands/build");
const assert = require("assert");
const fs = require("fs-extra");
const path = require("path");

async function runTests() {
  console.log("Running tests...");

  try {
    await build();
    console.log("✓ Build process completed successfully");
  } catch (error) {
    console.error("✗ Build process failed:", error.message);
    process.exit(1);
  }

  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  const zipFile = path.join(cwd, `${projectName}.zip`);

  assert(fs.existsSync(zipFile), "Output zip file should exist");
  console.log("✓ Output files created successfully");

  console.log("\nAll tests passed! 🎉");
}

runTests().catch(console.error);
