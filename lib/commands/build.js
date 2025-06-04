const chalk = require("chalk");
const shell = require("shelljs");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const os = require("os");
const JSZip = require("jszip");
const toml = require("@iarna/toml");
const sharp = require("sharp");
const ora = require("ora");
const { execAsync } = require("../utils/execAsync");
const {
  getOwnableType,
  handleStaticOwnable,
  handleMusicOwnable,
} = require("../utils/ownableTypes");

const REQUIRED_SCHEMA_FILES = [
  "instantiate_msg.json",
  "metadata.json",
  "info_response.json",
  "query_msg.json",
  "execute_msg.json",
];

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getOSInfo() {
  const platform = os.platform();
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";
  const isLinux = platform === "linux";

  return {
    platform,
    isWindows,
    isMac,
    isLinux,
    name: isWindows
      ? "Windows"
      : isMac
      ? "macOS"
      : isLinux
      ? "Linux"
      : "Unknown",
  };
}

function getInstallInstructions(tool) {
  const osInfo = getOSInfo();

  const instructions = {
    rust: {
      windows: "Visit https://rustup.rs/ and download the installer",
      mac: "Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      linux:
        "Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    },
    docker: {
      windows:
        "Download Docker Desktop from https://www.docker.com/products/docker-desktop",
      mac: "Download Docker Desktop from https://www.docker.com/products/docker-desktop",
      linux: "Run: curl -fsSL https://get.docker.com | sh",
    },
  };

  return instructions[tool][
    osInfo.platform === "win32"
      ? "windows"
      : osInfo.platform === "darwin"
      ? "mac"
      : "linux"
  ];
}

async function checkPrerequisites() {
  const osInfo = getOSInfo();
  console.log(chalk.cyan(`\nDetected OS: ${osInfo.name}`));

  if (!shell.which("rustc")) {
    throw new Error(
      `Rust is not installed. Please install Rust first:\n${getInstallInstructions(
        "rust"
      )}`
    );
  }

  if (!shell.which("cargo")) {
    throw new Error(
      `Cargo is not installed. Please install Rust first:\n${getInstallInstructions(
        "rust"
      )}`
    );
  }

  if (!shell.which("wasm-pack")) {
    throw new Error(
      "wasm-pack is not installed. Please install it with: cargo install wasm-pack"
    );
  }

  const wasmTargetResult = shell.exec("rustup target list --installed", {
    silent: true,
  });
  if (!wasmTargetResult.stdout.includes("wasm32-unknown-unknown")) {
    throw new Error(
      "WebAssembly target not installed. Please run: rustup target add wasm32-unknown-unknown"
    );
  }

  if (osInfo.isWindows) {
    const vsWhere =
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
    if (!fs.existsSync(vsWhere)) {
      console.warn(
        chalk.yellow(
          "Visual Studio Build Tools not found. You may need to install them for full Rust support."
        )
      );
    }
  }

  if (osInfo.isMac) {
    if (!shell.which("xcode-select")) {
      console.warn(
        chalk.yellow(
          "Xcode Command Line Tools not found. You may need to install them for full Rust support."
        )
      );
    }
  }

  if (osInfo.isLinux) {
    const buildEssentials = shell.exec("dpkg -l | grep build-essential", {
      silent: true,
    });
    if (buildEssentials.code !== 0) {
      console.warn(
        chalk.yellow(
          "build-essential package not found. You may need to install it: sudo apt-get install build-essential"
        )
      );
    }
  }
}

async function checkProjectStructure() {
  const cwd = process.cwd();

  if (!fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    throw new Error(
      "No Cargo.toml found in the current directory. Please run this command in an Ownable project directory."
    );
  }

  if (!fs.existsSync(path.join(cwd, "src"))) {
    throw new Error(
      "No src directory found. Please ensure this is a valid Ownable project."
    );
  }

  if (!fs.existsSync(path.join(cwd, "assets"))) {
    throw new Error(
      "No assets directory found. Please ensure this is a valid Ownable project."
    );
  }

  if (!fs.existsSync(path.join(cwd, "assets", "index.html"))) {
    throw new Error("No index.html found in assets directory.");
  }

  if (!fs.existsSync(path.join(cwd, "assets", "images"))) {
    throw new Error("No images directory found in assets directory.");
  }

  const imagesDir = path.join(cwd, "assets", "images");
  const images = await fs.readdir(imagesDir);
  if (images.length === 0) {
    throw new Error("No images found in assets/images directory.");
  }
}

async function buildWasm(projectPath, spinner) {
  const buildDir = path.join(projectPath, "build");

  try {
    await fs.ensureDir(buildDir);

    const cargoTomlPath = path.join(projectPath, "Cargo.toml");
    let cargoToml = await fs.readFile(cargoTomlPath, "utf8");
    cargoToml = cargoToml.replace(/name = "[^"]+"/, 'name = "ownable"');
    await fs.writeFile(cargoTomlPath, cargoToml);

    process.env.CC = "clang";
    process.env.RUSTFLAGS =
      "-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=-zstack-size=65536";
    process.env.CARGO_TARGET_DIR = path.join(projectPath, "target");

    spinner.text = "Building WebAssembly module...";
    try {
      const { stdout: wasmStdout, stderr: wasmStderr } = await execAsync(
        "wasm-pack build --target web --out-name ownable",
        { cwd: projectPath }
      );
      if (wasmStderr) console.error(chalk.yellow(wasmStderr));
    } catch (error) {
      throw new Error(`WASM build failed: ${error.message}`);
    }

    const pkgDir = path.join(projectPath, "pkg");
    const files = await fs.readdir(pkgDir);
    await Promise.all(
      files.map((file) =>
        fs.move(path.join(pkgDir, file), path.join(buildDir, file), {
          overwrite: true,
        })
      )
    );

    await fs.remove(pkgDir);

    const schemaDir = path.join(buildDir, "schema");
    const schemaExists = await fs.pathExists(schemaDir);

    if (!schemaExists) {
      await fs.ensureDir(schemaDir);

      spinner.text = "Generating schema files...";
      try {
        const { stdout: schemaStdout, stderr: schemaStderr } = await execAsync(
          "cargo run --example schema",
          { cwd: projectPath }
        );
        if (schemaStderr) console.error(chalk.yellow(schemaStderr));

        const projectSchemaDir = path.join(projectPath, "schema");
        if (await fs.pathExists(projectSchemaDir)) {
          const schemaFiles = await fs.readdir(projectSchemaDir);
          await Promise.all(
            schemaFiles.map((file) =>
              fs.copy(
                path.join(projectSchemaDir, file),
                path.join(schemaDir, file)
              )
            )
          );
        }

        spinner.text = "Validating schema files...";
        const schemaFiles = await fs.readdir(schemaDir);

        const missingFiles = REQUIRED_SCHEMA_FILES.filter(
          (file) => !schemaFiles.includes(file)
        );

        if (missingFiles.length > 0) {
          throw new Error(
            `Missing required schema files: ${missingFiles.join(", ")}`
          );
        }

        await Promise.all(
          schemaFiles.map(async (file) => {
            try {
              const content = await fs.readFile(
                path.join(schemaDir, file),
                "utf8"
              );
              JSON.parse(content);
            } catch (error) {
              throw new Error(`Invalid schema file ${file}: ${error.message}`);
            }
          })
        );

        spinner.text = "Schema files validated successfully";
      } catch (error) {
        throw new Error(`Schema generation failed: ${error.message}`);
      }
    } else {
      spinner.text = "Using existing schema files...";
    }

    spinner.text = "Build process completed";
    return {
      wasmPath: path.join(buildDir, "ownable_bg.wasm"),
      jsPath: path.join(buildDir, "ownable.js"),
    };
  } catch (error) {
    throw new Error(`WASM build process failed: ${error.message}`);
  }
}

async function getMetadataFromCargo() {
  const cwd = process.cwd();

  const metadataPath = path.join(cwd, "metadata.txt");
  if (await fs.pathExists(metadataPath)) {
    const metadataContent = await fs.readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataContent);
    return {
      name: metadata.displayName.toLowerCase().replace(/\s+/g, "-"),
      description: metadata.description,
      version: metadata.version,
      authors: metadata.authors.split(",").map((a) => a.trim()),
      keywords: metadata.keywords,
    };
  }

  const cargoPath = path.join(cwd, "Cargo.toml");
  const cargoContent = await fs.readFile(cargoPath, "utf8");
  const cargoData = toml.parse(cargoContent);

  return {
    name: cargoData.package.name.replace(/"/g, ""),
    description: cargoData.package.description.replace(/"/g, ""),
    version: cargoData.package.version.replace(/"/g, ""),
    authors: cargoData.package.authors || [],
    keywords: cargoData.package.keywords || [],
  };
}

async function createPackage(
  projectPath,
  outputPath,
  wasmPath,
  jsPath,
  metadata,
  ownableType,
  spinner
) {
  try {
    await Promise.all([
      fs.promises.mkdir(path.join(outputPath, "images"), { recursive: true }),
      fs.promises.mkdir(path.join(outputPath, "audio"), { recursive: true }),
    ]);

    const schemaDir = path.join(projectPath, "schema");
    const schemaFiles = await fs.promises.readdir(schemaDir);
    await Promise.all(
      schemaFiles.map((file) =>
        fs.promises.copyFile(
          path.join(schemaDir, file),
          path.join(outputPath, file)
        )
      )
    );

    const packageJson = {
      name: metadata.name,
      authors: metadata.authors ? [metadata.authors] : [],
      description: metadata.description,
      version: metadata.version,
      type: "module",
      main: "ownable.js",
      types: "ownable.d.ts",
      files: ["ownable_bg.wasm", "ownable.js", "ownable.d.ts"],
      sideEffects: ["./snippets/*"],
      keywords: metadata.keywords ? metadata.keywords : [],
    };

    await fs.promises.writeFile(
      path.join(outputPath, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );

    await fs.promises.writeFile(
      path.join(outputPath, "metadata.json"),
      JSON.stringify(metadata, null, 2)
    );

    if (ownableType === "static-ownable") {
      const contentInfo = await handleStaticOwnable(
        projectPath,
        outputPath,
        metadata,
        spinner
      );
      const indexHtml = await fs.promises.readFile(
        path.join(projectPath, "assets", "index.html"),
        "utf8"
      );
      const updatedHtml = indexHtml.replace(
        /PLACEHOLDER2_IMG/g,
        `images/${contentInfo.imageFile}`
      );
      await fs.promises.writeFile(
        path.join(outputPath, "index.html"),
        updatedHtml
      );
    } else if (ownableType === "music-ownable") {
      const contentInfo = await handleMusicOwnable(
        projectPath,
        outputPath,
        metadata,
        spinner
      );
      const indexHtml = await fs.promises.readFile(
        path.join(projectPath, "assets", "index.html"),
        "utf8"
      );
      const updatedHtml = indexHtml
        .replace(
          /src="PLACEHOLDER2_COVER"/g,
          `src="images/${contentInfo.coverArt}"`
        )
        .replace(
          /src="PLACEHOLDER2_BACKGROUND"/g,
          `src="images/${contentInfo.backdrop}"`
        )
        .replace(
          /src="PLACEHOLDER2_AUDIO"/g,
          `src="audio/${contentInfo.audioFile}"`
        );
      await fs.promises.writeFile(
        path.join(outputPath, "index.html"),
        updatedHtml
      );
    }

    const zip = new JSZip();
    const addDirToZip = async (dirPath, zipPath = "") => {
      const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
      await Promise.all(
        files.map(async (file) => {
          const fullPath = path.join(dirPath, file.name);
          const relativePath = path.join(zipPath, file.name);
          if (file.isDirectory()) {
            await addDirToZip(fullPath, relativePath);
          } else {
            const content = await fs.promises.readFile(fullPath);
            zip.file(relativePath, content);
          }
        })
      );
    };

    const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");
    zip.file("ownable_bg.wasm", await fs.promises.readFile(wasmPath));
    zip.file("ownable.js", await fs.promises.readFile(jsPath));
    zip.file(
      "ownable.d.ts",
      await fs.promises.readFile(
        path.join(path.dirname(jsPath), "ownable.d.ts")
      )
    );

    await addDirToZip(outputPath);

    const zipContent = await zip.generateAsync({ type: "nodebuffer" });
    const zipPath = path.join(process.cwd(), `${metadata.name}.zip`);
    await fs.promises.writeFile(zipPath, zipContent);

    return zipPath;
  } catch (error) {
    throw new Error(`Failed to create package: ${error.message}`);
  }
}

async function build() {
  const spinner = ora({
    text: "Starting build process...",
    color: "cyan",
    spinner: {
      frames: spinnerFrames,
      interval: 80,
    },
  }).start();

  const totalSteps = 5;
  let currentStep = 0;

  const updateProgress = (step, message) => {
    currentStep++;
    const percentage = Math.round((currentStep / totalSteps) * 100);
    spinner.text = `[${percentage}%] ${message}`;
  };

  try {
    const projectPath = process.cwd();
    updateProgress(1, "Checking environment...");
    await Promise.all([checkPrerequisites(), checkProjectStructure()]);

    updateProgress(2, "Building WebAssembly...");
    const { wasmPath, jsPath } = await buildWasm(projectPath, spinner);

    updateProgress(3, "Preparing package...");
    const metadata = await getMetadataFromCargo();

    updateProgress(4, "Creating package...");
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ownable-")
    );
    const zipPath = await createPackage(
      projectPath,
      tmpDir,
      wasmPath,
      jsPath,
      metadata,
      await getOwnableType(projectPath),
      spinner
    );

    updateProgress(5, "Cleaning up...");
    await fs.remove(tmpDir);

    spinner.succeed("Build completed successfully! 🎉");
    console.log(`\nPackage created at: ${zipPath}`);
  } catch (error) {
    spinner.fail("Build failed");
    console.error(`\nError: ${error.message}`);
    throw error;
  }
}

async function clean(projectPath = process.cwd()) {
  const spinner = ora({
    text: "Cleaning build cache...",
    color: "cyan",
    spinner: {
      frames: spinnerFrames,
      interval: 80,
    },
    prefixText: chalk.cyan("🧹"),
    suffixText: chalk.cyan("🧹"),
  }).start();

  try {
    const buildDir = path.join(projectPath, "build");
    if (await fs.pathExists(buildDir)) {
      spinner.text = "Removing build directory...";
      await fs.remove(buildDir);
    }

    const targetDir = path.join(projectPath, "target");
    if (await fs.pathExists(targetDir)) {
      spinner.text = "Removing target directory...";
      await fs.remove(targetDir);
    }

    spinner.succeed(chalk.cyan("Build cache cleaned successfully!"));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to clean build cache: ${error.message}`));
    throw error;
  }
}

module.exports = {
  build,
  clean,
};
