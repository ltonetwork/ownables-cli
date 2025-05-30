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

  // Check for existing chain.json
  let existingChain = null;
  const chainJsonFile = zip.file("chain.json");
  if (chainJsonFile) {
    try {
      const chainJsonRaw = await chainJsonFile.async("string");
      existingChain = JSON.parse(chainJsonRaw);
      spinner.info(chalk.cyan("📜 Found existing chain.json"));
    } catch (e) {
      spinner.warn(
        chalk.yellow(
          "⚠️  Found chain.json but could not parse it, will create new chain"
        )
      );
    }
  }

  // Extract and process thumbnail if it exists
  let thumbnail = null;
  const thumbnailFile = zip.file("thumbnail.webp");
  if (thumbnailFile) {
    const thumbnailBuffer = await thumbnailFile.async("nodebuffer");
    try {
      const processedThumbnail = await sharp(thumbnailBuffer)
        .webp({
          quality: 80,
          effort: 6,
          lossless: false,
        })
        .resize(50, 50, {
          fit: "cover",
          position: "center",
          withoutEnlargement: true,
        })
        .toBuffer();

      // Check if size is under 256KB, if not, reduce quality
      if (processedThumbnail.length > 256 * 1024) {
        thumbnail = await sharp(thumbnailBuffer)
          .webp({
            quality: 60,
            effort: 6,
            lossless: false,
          })
          .resize(50, 50, {
            fit: "cover",
            position: "center",
            withoutEnlargement: true,
          })
          .toBuffer();

        // If too large, retry with lower quality
        if (thumbnail.length > 256 * 1024) {
          thumbnail = await sharp(thumbnailBuffer)
            .webp({
              quality: 40,
              effort: 6,
              lossless: false,
            })
            .resize(50, 50, {
              fit: "cover",
              position: "center",
              withoutEnlargement: true,
            })
            .toBuffer();
        }
      } else {
        thumbnail = processedThumbnail;
      }

      thumbnail = Binary.from(new Uint8Array(thumbnail));
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
    existingChain,
  };
}

async function createEventAndChainJson(
  account,
  title,
  keywords,
  networkId,
  recipient,
  spinner,
  existingChain = null
) {
  let chain;
  if (existingChain) {
    spinner.text = "Loading existing event chain...";
    chain = EventChain.from(existingChain);
  } else {
    spinner.text = "Creating new event chain...";
    chain = new EventChain(account);
  }

  const msg = {
    "@context": "execute_msg.json",
    ownable_id: chain.id,
    network_id: networkId,
    title: title,
    keywords: keywords,
    recipient: recipient,
    sent_from: "ownables cli",
  };

  spinner.text = "Adding event to chain...";
  const event = new Event(msg).addTo(chain).signWith(account);

  spinner.text = "Getting anchors from chain...";
  let anchors;
  if (existingChain) {
    const lastEventHash = chain.events[chain.events.length - 2].hash;
    anchors = chain.startingAfter(Binary.fromHex(lastEventHash.hex)).anchorMap;
  } else {
    const hash = chain.latestHash.hex;
    anchors = chain.startingWith(Binary.fromHex(hash)).anchorMap;
  }

  if (anchors.length > 0) {
    spinner.text = "Anchoring to blockchain...";
    const lto = new LTO(networkId);
    try {
      const anchorTx = await lto.anchor(account, ...anchors);
      const explorerUrl =
        networkId === "L"
          ? "https://explorer.lto.network"
          : "https://explorer.testnet.lto.network";

      spinner.succeed("Chain anchored successfully");
      spinner.info(
        chalk.green("🔗 Anchor Transaction:") +
          " " +
          chalk.yellow(`${explorerUrl}/transactions/${anchorTx.id}`)
      );
      return { chainJson: chain.toJSON(), anchorTx };
    } catch (error) {
      spinner.fail("Anchoring failed");
      throw error;
    }
  }

  spinner.text = "Converting chain to JSON...";
  const chainJson = chain.toJSON();
  return { chainJson, anchorTx: null };
}

async function addChainJsonToZip(zip, chainJson) {
  zip.file("chain.json", JSON.stringify(chainJson, null, 2));
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
    const { title, description, keywords, zip, thumbnail, existingChain } =
      await extractMetadata(zipPath, spinner);

    spinner.succeed("Extracted metadata");
    spinner.info(chalk.cyan("📦 Title:") + " " + chalk.green(title));
    spinner.info(
      chalk.cyan("📝 Description:") + " " + chalk.green(description)
    );
    spinner.info(
      chalk.cyan("🏷️  Keywords:") + " " + chalk.green(keywords.join(", "))
    );
    if (thumbnail) {
      spinner.info(chalk.cyan("🖼️  Thumbnail:") + " " + chalk.green("Found"));
    }

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

    spinner.text = "Creating account...";
    const account = lto.account({ seed: seed.trim() });

    spinner.text = "Creating event and anchoring to blockchain...";
    const { chainJson, anchorTx } = await createEventAndChainJson(
      account,
      title,
      keywords,
      networkType,
      recipient,
      spinner,
      existingChain
    );

    spinner.text = "Adding chain.json to package...";
    const modifiedZipBuffer = await addChainJsonToZip(zip, chainJson);

    // Create binary content from the modified zip
    let pkgContent;
    try {
      const binaryData = new Uint8Array(modifiedZipBuffer);
      pkgContent = Binary.from(binaryData);
    } catch (error) {
      spinner.fail("Error creating Binary");
      throw error;
    }

    // send message
    spinner.text = "Creating message...";
    const message = new Message(pkgContent, "application/octet-stream", {
      title,
      description,
      type: "ownable",
      thumbnail: thumbnail || undefined,
    })
      .to(recipient)
      .signWith(account);

    spinner.text = "Sending message to relay...";
    const relayClient = new Relay(relay);
    try {
      await relayClient.send(message);
      spinner.succeed("Message sent successfully");
      spinner.info(
        chalk.green("✅ Message hash:") +
          " " +
          chalk.yellow(message.hash.base58)
      );
      if (anchorTx) {
        spinner.info(chalk.green("✅ Event transaction Id:")) + anchorTx.id;
      }
    } catch (error) {
      spinner.fail("Failed to send message");
      throw error;
    }
  } catch (error) {
    spinner.fail("Transfer failed");
    console.error(`\nError: ${error.message}`);
    throw error;
  }
}

module.exports = { transfer };
