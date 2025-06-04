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

  // Check if Rust is installed
  if (!shell.which("rustc")) {
    throw new Error(
      `Rust is not installed. Please install Rust first:\n${getInstallInstructions(
        "rust"
      )}`
    );
  }

  // Check if cargo is installed
  if (!shell.which("cargo")) {
    throw new Error(
      `Cargo is not installed. Please install Rust first:\n${getInstallInstructions(
        "rust"
      )}`
    );
  }

  // Check if wasm-bindgen is installed
  if (!shell.which("wasm-bindgen")) {
    throw new Error(
      "wasm-bindgen is not installed. Please install it with: cargo install wasm-bindgen-cli"
    );
  }

  // Check if wasm32 target is installed
  const wasmTargetResult = shell.exec("rustup target list --installed", {
    silent: true,
  });
  if (!wasmTargetResult.stdout.includes("wasm32-unknown-unknown")) {
    throw new Error(
      "WebAssembly target not installed. Please run: rustup target add wasm32-unknown-unknown"
    );
  }

  // Additional OS-specific checks
  if (osInfo.isWindows) {
    // Check for Visual Studio Build Tools on Windows
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
    // Check for Xcode Command Line Tools on macOS
    if (!shell.which("xcode-select")) {
      console.warn(
        chalk.yellow(
          "Xcode Command Line Tools not found. You may need to install them for full Rust support."
        )
      );
    }
  }

  if (osInfo.isLinux) {
    // Check for essential build tools on Linux
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

    // Update Cargo.toml to use ownable as package name
    const cargoTomlPath = path.join(projectPath, "Cargo.toml");
    let cargoToml = await fs.readFile(cargoTomlPath, "utf8");
    cargoToml = cargoToml.replace(/name = "[^"]+"/, 'name = "ownable"');
    await fs.writeFile(cargoTomlPath, cargoToml);

    const wasmPath = path.join(buildDir, "ownable_bg.wasm");
    const jsPath = path.join(buildDir, "ownable.js");

    // Configure build environment
    process.env.RUSTFLAGS =
      "-C target-feature=+atomics,+bulk-memory,+mutable-globals";
    process.env.CARGO_TARGET_DIR = path.join(projectPath, "target");
    process.env.CC = "clang";

    // Build WASM module
    spinner.text = "Building WebAssembly module...";
    try {
      const { stdout: wasmStdout, stderr: wasmStderr } = await execAsync(
        "cargo build --target wasm32-unknown-unknown --release",
        { cwd: projectPath }
      );
      if (wasmStderr) console.error(chalk.yellow(wasmStderr));
    } catch (error) {
      throw new Error(`WASM build failed: ${error.message}`);
    }

    // generate js bindings directly to build directory
    spinner.text = "Generating JavaScript bindings...";
    try {
      const { stdout: bindgenStdout, stderr: bindgenStderr } = await execAsync(
        `wasm-bindgen target/wasm32-unknown-unknown/release/ownable.wasm --out-dir ${buildDir} --target web --out-name ownable`,
        { cwd: projectPath }
      );
      if (bindgenStderr) console.error(chalk.yellow(bindgenStderr));
    } catch (error) {
      throw new Error(`WASM bindgen failed: ${error.message}`);
    }

    // Check if schema directory exists in build directory
    const schemaDir = path.join(buildDir, "schema");
    const schemaExists = await fs.pathExists(schemaDir);

    if (!schemaExists) {
      // Create schema directory in build
      await fs.ensureDir(schemaDir);

      // Gen schema files
      spinner.text = "Generating schema files...";
      try {
        const { stdout: schemaStdout, stderr: schemaStderr } = await execAsync(
          "cargo run --example schema",
          { cwd: projectPath }
        );
        if (schemaStderr) console.error(chalk.yellow(schemaStderr));

        // copy generated schema files to build directory
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

        // Validate each schema file is valid JSON
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
      wasmPath,
      jsPath,
    };
  } catch (error) {
    throw new Error(`Failed to build WebAssembly: ${error.message}`);
  }
}

async function resizeToThumbnail(input) {
  try {
    const resized = await sharp(input)
      .resize(50, 50)
      .webp({ quality: 80 })
      .toBuffer();

    if (resized.length > 256 * 1024) {
      throw new Error("Thumbnail exceeds 256KB");
    }

    return resized;
  } catch (error) {
    throw new Error(`Failed to create thumbnail: ${error.message}`);
  }
}

async function getMetadataFromCargo() {
  const cwd = process.cwd();
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
    // Create output directories in parallel
    await Promise.all([
      fs.promises.mkdir(path.join(outputPath, "images"), { recursive: true }),
      fs.promises.mkdir(path.join(outputPath, "audio"), { recursive: true }),
    ]);

    // Copy schema files from the project's schema directory
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

    // Create package.json
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

    // Write package.json
    await fs.promises.writeFile(
      path.join(outputPath, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );

    // Create metadata.json
    await fs.promises.writeFile(
      path.join(outputPath, "metadata.json"),
      JSON.stringify(metadata, null, 2)
    );

    // Handle assets based on ownable type
    if (ownableType === "static-ownable") {
      const contentInfo = await handleStaticOwnable(
        projectPath,
        outputPath,
        metadata,
        spinner
      );
      // Update index.html with correct image references
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
      // Update index.html with correct image and audio references
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

    // Create ZIP file
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

    // Add WASM and JS files to ZIP with correct names
    const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");
    zip.file("ownable_bg.wasm", await fs.promises.readFile(wasmPath));
    zip.file("ownable.js", await fs.promises.readFile(jsPath));
    zip.file(
      "ownable.d.ts",
      await fs.promises.readFile(
        path.join(path.dirname(jsPath), "ownable.d.ts")
      )
    );

    // Add rest of the files
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

  const totalSteps = 5; // Reduced from 6 to 5 steps
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

    // Cleanup
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
    // Clean build
    const buildDir = path.join(projectPath, "build");
    if (await fs.pathExists(buildDir)) {
      spinner.text = "Removing build directory...";
      await fs.remove(buildDir);
    }

    // Clean target
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
