const { build } = require("../lib/commands/build");
const fs = require("fs-extra");
const path = require("path");
const shell = require("shelljs");
const sharp = require("sharp");

jest.mock("fs-extra");
jest.mock("shelljs");
jest.mock("sharp");
jest.mock("chalk", () => {
  const chalk = {
    blue: jest.fn((text) => text),
    green: jest.fn((text) => text),
    yellow: jest.fn((text) => text),
    red: jest.fn((text) => text),
    cyan: jest.fn((text) => text),
  };
  Object.defineProperty(chalk, "color", {
    get: () => chalk.cyan,
    configurable: true,
  });
  return chalk;
});

jest.mock("ora", () => {
  return jest.fn().mockImplementation(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    info: jest.fn().mockReturnThis(),
    text: "",
  }));
});

describe("Build Command", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync = jest.fn().mockReturnValue(true);
    fs.readFileSync = jest.fn().mockReturnValue(
      JSON.stringify({
        name: "test-ownable",
        version: "1.0.0",
      })
    );
    fs.readdir = jest.fn().mockResolvedValue(["test-image.jpg"]);
    fs.ensureDir = jest.fn().mockResolvedValue(undefined);
    fs.copy = jest.fn().mockResolvedValue(undefined);
    fs.writeFile = jest.fn().mockResolvedValue(undefined);

    shell.which = jest.fn().mockReturnValue(true);
    shell.exec = jest.fn().mockReturnValue({
      stdout: "wasm32-unknown-unknown",
      stderr: "",
      code: 0,
    });
  });

  test("should handle missing Cargo.toml", async () => {
    fs.existsSync.mockImplementation((path) => {
      if (path.includes("Cargo.toml")) return false;
      return true;
    });
    await expect(build()).rejects.toThrow(
      "No Cargo.toml found in the current directory"
    );
  });

  test("should handle missing thumbnail gracefully", async () => {
    fs.readdir.mockResolvedValueOnce([]);
    await expect(build()).rejects.toThrow(
      "No images found in assets/images directory"
    );
  });
});
