const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const shell = require("shelljs");
const ora = require("ora");

async function checkPrerequisites() {
  const spinner = ora("Checking prerequisites...").start();

  try {
    if (!shell.which("rustc")) {
      throw new Error("Rust is not installed. Please install Rust first.");
    }

    if (!shell.which("cargo")) {
      throw new Error("Cargo is not installed. Please install Rust first.");
    }

    const wasmTargetResult = shell.exec("rustup target list --installed", {
      silent: true,
    });
    if (!wasmTargetResult.stdout.includes("wasm32-unknown-unknown")) {
      throw new Error(
        "WebAssembly target not installed. Please run: rustup target add wasm32-unknown-unknown"
      );
    }

    if (!shell.which("wasm-pack")) {
      throw new Error(
        "wasm-pack is not installed. Please install it with: cargo install wasm-pack"
      );
    }

    spinner.succeed("All prerequisites are installed");
  } catch (error) {
    spinner.fail(error.message);
    throw error;
  }
}

async function getTemplateType() {
  return inquirer.prompt([
    {
      type: "list",
      name: "template",
      message: "What type of Ownable would you like to create?",
      choices: [
        {
          name: "Static Ownable - A simple static image or content display",
          value: "static-ownable",
        },
        {
          name: "Music Ownable - Audio with cover art and backdrop image",
          value: "music-ownable",
        },
      ],
    },
  ]);
}

async function getMetadata() {
  const result = await inquirer.prompt([
    {
      type: "input",
      name: "displayName",
      message: "What would you like to name your Ownable?",
      validate: (input) => {
        if (!input) return "Name is required";
        return true;
      },
    },
    {
      type: "input",
      name: "description",
      message: "Describe your Ownable:",
      validate: (input) => {
        if (!input) return "Description is required";
        return true;
      },
    },
    {
      type: "input",
      name: "version",
      message: "Version (e.g., 1.0.0):",
      default: "1.0.0",
      validate: (input) => {
        if (!input) return "Version is required";
        if (!/^\d+\.\d+\.\d+$/.test(input)) {
          return "Version must be in format x.y.z";
        }
        return true;
      },
    },
    {
      type: "input",
      name: "authors",
      message: "Authors (comma-separated):",
      validate: (input) => {
        if (!input) return "At least one author is required";
        return true;
      },
    },
    {
      type: "input",
      name: "keywords",
      message: "Keywords (comma-separated):",
      validate: (input) => {
        if (!input) return "At least one keyword is required";
        return true;
      },
    },
  ]);

  result.name = result.displayName.toLowerCase().replace(/\s+/g, "-");
  result.keywords = result.keywords.split(",").map((k) => k.trim());
  return result;
}

async function replacePlaceholders(filePath, metadata) {
  let content = await fs.readFile(filePath, "utf8");

  content = content
    .replace(/PLACEHOLDER1_NAME/g, `"ownable"`)
    .replace(/PLACEHOLDER1_DESCRIPTION/g, `"${metadata.description}"`)
    .replace(/PLACEHOLDER1_VERSION/g, `"${metadata.version}"`)
    .replace(/PLACEHOLDER1_AUTHORS/g, `"${metadata.authors}"`)
    .replace(
      /PLACEHOLDER1_KEYWORDS/g,
      (metadata.keywords || []).map((k) => `"${k.trim()}"`).join(", ")
    )
    .replace(/PLACEHOLDER4_CONTRACT_NAME/g, `"${metadata.name}"`)
    .replace(/PLACEHOLDER4_TYPE/g, `"music"`)
    .replace(/PLACEHOLDER4_DESCRIPTION/g, `"${metadata.description}"`)
    .replace(/PLACEHOLDER4_NAME/g, `"${metadata.displayName}"`)
    .replace(/PLACEHOLDER3_MSG/g, "ownable")
    .replace(/PLACEHOLDER3_STATE/g, "ownable")
    .replace(/PLACEHOLDER2_TITLE/g, metadata.displayName)
    .replace(/PLACEHOLDER2_DESCRIPTION/g, metadata.description)
    .replace(/PLACEHOLDER2_COVER/g, "PLACEHOLDER2_COVER")
    .replace(/PLACEHOLDER2_BACKGROUND/g, "PLACEHOLDER2_BACKGROUND")
    .replace(/PLACEHOLDER2_AUDIO/g, "PLACEHOLDER2_AUDIO");

  await fs.writeFile(filePath, content);
}

async function create() {
  console.log(chalk.blue("Creating new Ownable template..."));

  await checkPrerequisites();

  const { template } = await getTemplateType();
  console.log(chalk.green("✓ Template type selected"));

  const metadata = await getMetadata();
  console.log(chalk.green("✓ Metadata collected"));

  const projectDir = path.join(process.cwd(), metadata.name);
  if (fs.existsSync(projectDir)) {
    throw new Error(`Directory ${metadata.name} already exists`);
  }

  const templateDir = path.join(__dirname, "../../templates", template);
  await fs.copy(templateDir, projectDir);

  await fs.writeFile(path.join(projectDir, "type.txt"), template);

  await fs.writeFile(
    path.join(projectDir, "metadata.txt"),
    JSON.stringify({
      displayName: metadata.displayName,
      description: metadata.description,
      version: metadata.version,
      authors: metadata.authors,
      keywords: metadata.keywords,
    })
  );

  const assetsDir = path.join(projectDir, "assets");
  await fs.ensureDir(assetsDir);

  const imagesDir = path.join(assetsDir, "images");
  await fs.ensureDir(imagesDir);

  if (template === "music-ownable") {
    const audioDir = path.join(assetsDir, "audio");
    await fs.ensureDir(audioDir);
  }

  const filesToUpdate = [
    path.join(projectDir, "Cargo.toml"),
    path.join(projectDir, "src", "contract.rs"),
    path.join(projectDir, "src", "msg.rs"),
    path.join(projectDir, "src", "state.rs"),
    path.join(projectDir, "src", "error.rs"),
    path.join(projectDir, "src", "lib.rs"),
    path.join(projectDir, "examples", "schema.rs"),
    path.join(assetsDir, "index.html"),
  ];

  for (const file of filesToUpdate) {
    if (fs.existsSync(file)) {
      await replacePlaceholders(file, metadata);
    } else {
      console.warn(
        chalk.yellow(
          `Warning: File ${file} not found, skipping placeholder replacement`
        )
      );
    }
  }

  console.log(chalk.green("\nOwnable template created successfully! 🎉"));
  console.log(chalk.blue("\nNext steps:"));

  if (template === "music-ownable") {
    console.log("1. Add your audio file to the assets/audio directory");
    console.log("   - Supported formats: .mp3");
    console.log("   - Maximum size: 50MB");
    console.log("\n2. Add your images to the assets/images directory");
    console.log("   - Required: Two images");
    console.log(
      "   - Cover art: Name one image with 'cover' or 'front' in the filename"
    );
    console.log("     Example: 'cover.jpg', 'front.png', 'my-cover.jpg'");
    console.log(
      "   - Backdrop: Name the second image with 'backdrop' or 'back' in the filename"
    );
    console.log("     Example: 'backdrop.jpg', 'back.png', 'my-backdrop.jpg'");
    console.log("   - Supported formats: .jpg, .jpeg, .png, .webp");
    console.log("   - Minimum dimensions: 300x300 pixels");
    console.log("   - Maximum dimensions: 4096x4096 pixels");
    console.log("   - Maximum size: 50MB per image");
    console.log("\n3. Run 'ownables-cli build' to build your Ownable");
  } else {
    console.log("1. Add your image file to the assets/images directory");
    console.log("2. Run 'ownables-cli build' to build your Ownable");
  }
}

module.exports = { create };
