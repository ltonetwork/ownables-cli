const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const JSZip = require("jszip");
const ora = require("ora");
const sharp = require("sharp");
const {
  LTO,
  Message,
  Binary,
  Relay,
  Event,
  EventChain,
} = require("@ltonetwork/lto");

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

  // Extract and process thumbnail if it exists
  let thumbnail = null;
  const thumbnailFile = zip.file("thumbnail.webp");
  if (thumbnailFile) {
    const thumbnailBuffer = await thumbnailFile.async("nodebuffer");
    try {
      // Process thumbnail with sharp
      const processedThumbnail = await sharp(thumbnailBuffer)
        .webp({ quality: 80 })
        .resize(800, 800, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .toBuffer();

      // Check if size is under 256KB, if not, reduce quality
      if (processedThumbnail.length > 256 * 1024) {
        thumbnail = await sharp(thumbnailBuffer)
          .webp({ quality: 60 })
          .resize(600, 600, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .toBuffer();
      } else {
        thumbnail = processedThumbnail;
      }

      // Convert to base64
      thumbnail = thumbnail.toString("base64");
    } catch (error) {
      console.warn(
        chalk.yellow("Warning: Failed to process thumbnail, skipping...")
      );
      thumbnail = null;
    }
  }

  return {
    title: pkgJson.name || "Ownable",
    description: pkgJson.description || "",
    keywords: pkgJson.keywords || [],
    zip: zip,
    thumbnail,
  };
}

async function createEventAndChainJson(
  account,
  title,
  keywords,
  networkId,
  recipient
) {
  const chain = new EventChain(account);
  const msg = {
    "@context": "execute_msg.json",
    ownable_id: chain.id,
    network_id: networkId,
    title: title,
    keywords: keywords,
    recipient: recipient,
    sent_from: "ownables cli",
  };
  const event = new Event(msg).addTo(chain).signWith(account);
  const hash = chain.latestHash.hex;
  // Anchor the chain
  const anchors = chain.startingWith(Binary.fromHex(event.anchor)).anchorMap;
  if (anchors.length > 0) {
    await lto.anchor(account, ...anchors);
  }

  const chainJson = chain.toJSON();

  return chainJson;
}

async function addChainJsonToZip(zip, chainJson) {
  // Add chain.json to the existing zip
  zip.file("chain.json", JSON.stringify(chainJson, null, 2));
  // Generate new zip as Uint8Array
  return await zip.generateAsync({ type: "uint8array" });
}

async function transfer() {
  const spinner = ora("Initializing transfer...").start();

  try {
    // Find ZIP
    spinner.text = "Looking for ZIP file...";
    const zipPath = await findZipFile();
    spinner.succeed(`Found ZIP file: ${path.basename(zipPath)}`);

    const { recipient, relay, network } = await inquirer.prompt([
      {
        type: "input",
        name: "recipient",
        message: "Enter recipient LTO address:",
        validate: (input) =>
          input.trim() !== "" ? true : "Recipient address is required",
      },
      {
        type: "list",
        name: "network",
        message: "Select network:",
        choices: ["mainnet (L)", "testnet (T)"],
        default: "mainnet (L)",
      },
      {
        type: "input",
        name: "relay",
        message: "Enter relay URL (or press Enter to use default):",
        default: "https://relay-dev.lto.network",
      },
    ]);

    const networkType = network.startsWith("mainnet") ? "L" : "T";
    const lto = new LTO(networkType);
    if (!lto.isValidAddress(recipient)) {
      throw new Error("Invalid LTO address");
    }

    spinner.text = "Reading ZIP file...";
    const { title, description, keywords, zip, thumbnail } =
      await extractMetadata(zipPath, spinner);

    spinner.succeed("Extracted metadata");
    console.log(chalk.cyan("📦 Title:"), chalk.green(title));
    console.log(chalk.cyan("📝 Description:"), chalk.green(description));
    console.log(chalk.cyan("🏷️  Keywords:"), chalk.green(keywords.join(", ")));
    if (thumbnail) {
      console.log(chalk.cyan("🖼️  Thumbnail:"), chalk.green("Found"));
    }

    // Get sender's seed and create account
    const { seed } = await inquirer.prompt([
      {
        type: "password",
        name: "seed",
        message: "Enter your LTO seed phrase:",
        mask: "*",
        validate: (input) =>
          input.trim() !== "" ? true : "Seed phrase cannot be empty",
      },
    ]);

    const account = lto.account({ seed: seed.trim() });

    // Create event and chain.json
    spinner.text = "Creating event and anchoring to blockchain...";
    const chainJson = await createEventAndChainJson(
      account,
      title,
      keywords,
      networkType,
      recipient
    );

    // Add chain.json to zip
    spinner.text = "Adding chain.json to package...";
    const modifiedZipBuffer = await addChainJsonToZip(zip, chainJson);

    // Create binary content from the modified zip
    let pkgContent;
    try {
      // Ensure we have a proper Uint8Array
      const binaryData = new Uint8Array(modifiedZipBuffer);
      pkgContent = Binary.from(binaryData);
    } catch (error) {
      console.error("Error creating Binary:", error);
      throw error;
    }

    // Create and send message
    const message = new Message(pkgContent, "application/octet-stream", {
      title,
      description,
      type: "ownable",
      thumbnail: thumbnail ? `data:image/webp;base64,${thumbnail}` : undefined,
    })
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
    console.log(
      chalk.green("✅ Event anchored:"),
      chalk.yellow(chainJson.anchor)
    );
  } catch (error) {
    spinner.fail("Transfer failed");
    console.error(chalk.red("Error:"), error.message);
    process.exit(1);
  }
}

module.exports = { transfer };
