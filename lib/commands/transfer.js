const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const JSZip = require("jszip");
const ora = require("ora");
const { LTO, Message, Binary, Relay } = require("@ltonetwork/lto");

async function findZipFile() {
  const files = await fs.readdir(process.cwd());
  const zipFile = files.find((file) => file.endsWith(".zip"));

  if (!zipFile) {
    throw new Error("No ZIP file found in current directory");
  }

  return path.join(process.cwd(), zipFile);
}

async function validateZipFile(zipPath) {
  try {
    const stats = await fs.stat(zipPath);
    if (!stats.isFile()) {
      throw new Error("Path is not a file");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("ZIP file not found");
    }
    throw error;
  }
}

async function extractMetadata(zipPath, spinner) {
  const zipBuffer = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(zipBuffer);

  const packageJsonFile = zip.file("package.json");
  if (!packageJsonFile) {
    throw new Error("ZIP does not contain package.json");
  }

  const pkgJsonRaw = await packageJsonFile.async("string");
  let pkgJson;
  try {
    pkgJson = JSON.parse(pkgJsonRaw);
  } catch (e) {
    throw new Error("Invalid JSON in package.json");
  }

  // Extract thumbnail if it exists
  let thumbnail = null;
  const thumbnailFile = zip.file("thumbnail.webp");
  if (thumbnailFile) {
    thumbnail = await thumbnailFile.async("base64");
  }

  return {
    title: pkgJson.name || "Ownable",
    description: pkgJson.description || "",
    zipBuffer,
    thumbnail,
  };
}

async function transfer() {
  const spinner = ora("Initializing transfer...").start();

  try {
    // Find ZIP
    spinner.text = "Looking for ZIP file...";
    const zipPath = await findZipFile();
    spinner.succeed(`Found ZIP file: ${path.basename(zipPath)}`);

    const { seed, recipient, relay } = await inquirer.prompt([
      {
        type: "password",
        name: "seed",
        message: "Enter your LTO seed phrase:",
        mask: "*",
        validate: (input) =>
          input.trim() !== "" ? true : "Seed phrase cannot be empty",
      },
      {
        type: "input",
        name: "recipient",
        message: "Enter recipient LTO address:",
        validate: (input) =>
          input.trim() !== "" ? true : "Recipient address is required",
      },
      {
        type: "input",
        name: "relay",
        message: "Enter relay URL (or press Enter to use default):",
        default: "https://relay-dev.lto.network",
      },
    ]);

    const lto = new LTO("T");
    if (!lto.isValidAddress(recipient)) {
      throw new Error("Invalid LTO address");
    }
    spinner.text = "Reading ZIP file...";
    const { title, description, zipBuffer, thumbnail } = await extractMetadata(
      zipPath,
      spinner
    );

    spinner.succeed("Extracted metadata");
    console.log(chalk.cyan("📦 Title:"), chalk.green(title));
    console.log(chalk.cyan("📝 Description:"), chalk.green(description));
    if (thumbnail) {
      console.log(chalk.cyan("🖼️  Thumbnail:"), chalk.green("Found"));
    }

    // Create account and message
    const account = lto.account({ seed: seed.trim() });
    const message = new Message(
      Binary.from(new Uint8Array(zipBuffer)),
      "application/octet-stream",
      {
        title,
        description,
        type: "ownable",
        thumbnail: thumbnail
          ? `data:image/webp;base64,${thumbnail}`
          : undefined,
      }
    )
      .to(recipient)
      .signWith(account);

    spinner.text = "Sending message to relay...";
    const relayClient = new Relay(relay);
    await relayClient.send(message);

    spinner.succeed("Message sent successfully");
    console.log(
      chalk.green("✅ Message hash:"),
      chalk.yellow(message.hash.base58)
    );
  } catch (error) {
    spinner.fail("Transfer failed");
    console.error(chalk.red("Error:"), error.message);
    process.exit(1);
  }
}

module.exports = { transfer };
