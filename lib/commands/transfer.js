const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const JSZip = require("jszip");
const ora = require("ora");
const sharp = require("sharp");
const axios = require("axios");
const {
  LTO,
  Message,
  Binary,
  Relay,
  Event,
  EventChain,
} = require("@ltonetwork/lto");
const {
  LTO_FEE,
  RELAY_URL,
  TESTNET_EXPLORER_URL,
  MAINNET_EXPLORER_URL,
  MAINNET_API_URL,
  TESTNET_API_URL,
} = require("../../constants");
const { calculateZipCID } = require("../utils/calculateCID");

const HARDCODED_CID =
  "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

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
    const pkgJsonFile = Object.keys(zip.files).find(
      (filename) => filename.toLowerCase() === "package.json"
    );
    if (pkgJsonFile) {
      spinner.info(chalk.yellow(`Found package.json as "${pkgJsonFile}"`));
      packageJsonFile = zip.file(pkgJsonFile);
    } else {
      throw new Error("ZIP does not contain package.json");
    }
  }

  const pkgJsonRaw = await packageJsonFile.async("string");
  let pkgJson;
  try {
    pkgJson = JSON.parse(pkgJsonRaw);
  } catch (e) {
    throw new Error("Invalid JSON in package.json");
  }

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
    zipBuffer: zipBuffer,
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
  packageCID,
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

  if (existingChain) {
    // For existing chain, just add transfer event
    const transferMsg = {
      "@context": "execute_msg.json",
      transfer: {
        to: recipient,
      },
    };
    spinner.text = "Adding transfer event to chain...";
    const transferEvent = new Event(transferMsg).addTo(chain).signWith(account);
  } else {
    // For new chain, create instantiate event
    const instantiateMsg = {
      "@context": "instantiate_msg.json",
      ownable_id: chain.id,
      package: packageCID,
      network_id: networkId,
      keywords: keywords,
    };
    spinner.text = "Adding instantiate event to chain...";
    const instantiateEvent = new Event(instantiateMsg)
      .addTo(chain)
      .signWith(account);

    // Then add transfer event
    const transferMsg = {
      "@context": "execute_msg.json",
      transfer: {
        to: recipient,
      },
    };
    spinner.text = "Adding transfer event to chain...";
    const transferEvent = new Event(transferMsg).addTo(chain).signWith(account);
  }

  spinner.text = "Getting anchors from chain...";
  let anchors;
  let anchorTx;
  const lto = new LTO(networkId);
  const explorerUrl =
    networkId === "L" ? MAINNET_EXPLORER_URL : TESTNET_EXPLORER_URL;

  if (existingChain) {
    // For existing chain, anchor only the transfer event
    const transferHash = chain.events[chain.events.length - 1].hash;
    const transferAnchors = chain.startingWith(
      Binary.fromHex(transferHash.hex)
    ).anchorMap;

    if (transferAnchors.length > 0) {
      spinner.text = "Anchoring transfer event...";
      try {
        anchorTx = await lto.anchor(account, ...transferAnchors);
        spinner.succeed("Transfer event anchored successfully");
        spinner.info(
          chalk.green("🔗 Transfer Anchor:") +
            " " +
            chalk.yellow(`${explorerUrl}/transactions/${anchorTx.id}`)
        );
      } catch (error) {
        spinner.fail("Transfer anchoring failed");
        throw error;
      }
    }
  } else {
    // For new chain, anchor instantiate event first
    const instantiateHash = chain.events[0].hash;
    const instantiateAnchors = chain.startingWith(
      Binary.fromHex(instantiateHash.hex)
    ).anchorMap;

    if (instantiateAnchors.length > 0) {
      spinner.text = "Anchoring instantiate event...";
      try {
        anchorTx = await lto.anchor(account, ...instantiateAnchors);
        spinner.succeed("Instantiate event anchored successfully");
        spinner.info(
          chalk.green("🔗 Instantiate Anchor:") +
            " " +
            chalk.yellow(`${explorerUrl}/transactions/${anchorTx.id}`)
        );
      } catch (error) {
        spinner.fail("Instantiate anchoring failed");
        throw error;
      }
    }

    // Then anchor transfer event
    const transferHash = chain.events[1].hash;
    const transferAnchors = chain.startingWith(
      Binary.fromHex(transferHash.hex)
    ).anchorMap;

    if (transferAnchors.length > 0) {
      spinner.text = "Anchoring transfer event...";
      try {
        anchorTx = await lto.anchor(account, ...transferAnchors);
        spinner.succeed("Transfer event anchored successfully");
        spinner.info(
          chalk.green("🔗 Transfer Anchor:") +
            " " +
            chalk.yellow(`${explorerUrl}/transactions/${anchorTx.id}`)
        );
      } catch (error) {
        spinner.fail("Transfer anchoring failed");
        throw error;
      }
    }
  }

  spinner.text = "Converting chain to JSON...";
  const chainJson = chain.toJSON();
  return { chainJson, anchorTx };
}

async function addChainJsonToZip(zip, chainJson) {
  zip.file("chain.json", JSON.stringify(chainJson, null, 2));
  //add timestamp to the zip for uniqueness
  zip.file("timestamp.txt", Math.floor(Date.now() / 1000).toString());
  return await zip.generateAsync({ type: "uint8array" });
}

async function checkBalance(address, networkId) {
  try {
    const baseUrl = networkId === "T" ? TESTNET_API_URL : MAINNET_API_URL;
    const response = await axios.get(
      `${baseUrl}/addresses/balance/details/${address}`
    );
    const availableBalance = parseFloat(response.data.available) / 100000000;
    return availableBalance;
  } catch (error) {
    throw new Error(`Failed to check balance: ${error.message}`);
  }
}

async function preparePackage(zip, existingChain, spinner) {
  // For new chains, we don't add chain.json yet as it will be created with the first event
  // For existing chains, we use the existing chain.json
  if (!existingChain) {
    spinner.text = "No existing chain found, will create new chain...";
  } else {
    spinner.text = "Using existing chain...";
  }

  // Add chain.json and timestamp to ZIP
  spinner.text = "Adding chain.json and timestamp to ZIP...";
  const updatedZipContent = await addChainJsonToZip(
    zip,
    existingChain || { events: [] }
  );

  // Calculate CID
  spinner.text = "Calculating package CID...";
  const tempZipPath = path.join(process.cwd(), `temp-${Date.now()}.zip`);
  await fs.writeFile(tempZipPath, updatedZipContent);
  const packageCID = await calculateZipCID(tempZipPath, spinner);
  await fs.remove(tempZipPath); // Clean up temp file
  spinner.info(chalk.cyan("📦 Package CID: ") + chalk.white(packageCID));

  return { packageCID, updatedZipContent };
}

async function transfer() {
  const spinner = ora("Initializing transfer...").start();

  try {
    spinner.text = "Looking for ZIP file...";
    const zipPath = await findZipFile();
    spinner.succeed(`Found ZIP file: ${path.basename(zipPath)}`);

    spinner.text = "Reading package information...";
    let { title, description, keywords, zip, thumbnail, existingChain } =
      await extractMetadata(zipPath, spinner);

    spinner.info(chalk.cyan("📦 Name: ") + chalk.white(title));
    spinner.info(chalk.cyan("📝 Description: ") + chalk.white(description));

    const { recipient, relay, network, transferCount } = await inquirer.prompt([
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
        default: RELAY_URL,
      },
      {
        type: "number",
        name: "transferCount",
        message: "Enter number of transfers (max 50):",
        default: 1,
        validate: (input) => {
          const num = parseInt(input);
          if (isNaN(num) || num < 1)
            return "Please enter a number greater than 0";
          if (num > 50) return "Maximum number of transfers is 50";
          return true;
        },
      },
    ]);

    const networkId = network === "mainnet (L)" ? "L" : "T";

    const { seed } = await inquirer.prompt([
      {
        type: "password",
        name: "seed",
        message: "Enter your seed phrase to sign the transaction:",
        validate: (input) => (input.trim() !== "" ? true : "Seed is required"),
      },
    ]);

    const lto = new LTO(networkId);
    const account = lto.account({ seed });

    spinner.text = "Checking account balance...";
    const balance = await checkBalance(account.address, networkId);
    const requiredBalance = transferCount * LTO_FEE;

    if (balance < requiredBalance) {
      spinner.fail(
        `Insufficient balance. Required: ${requiredBalance} LTO, Available: ${balance} LTO`
      );
      return;
    }

    spinner.text = "Validating ZIP file...";
    await validateZipFile(zipPath);

    spinner.text = `Preparing to send ${transferCount} transfer(s)...`;

    for (let i = 0; i < transferCount; i++) {
      spinner.text = `Processing transfer ${i + 1} of ${transferCount}...`;

      const { packageCID, updatedZipContent } = await preparePackage(
        zip,
        existingChain,
        spinner
      );

      const { chainJson, anchorTx } = await createEventAndChainJson(
        account,
        title,
        keywords,
        networkId,
        recipient,
        spinner,
        packageCID,
        existingChain
      );

      // Update ZIP with the latest chain.json
      spinner.text = "Updating package with latest chain...";
      const finalZipContent = await addChainJsonToZip(zip, chainJson);

      let pkgContent;
      try {
        const binaryData = new Uint8Array(finalZipContent);
        pkgContent = Binary.from(binaryData);
      } catch (error) {
        spinner.fail("Error creating Binary");
        throw error;
      }

      spinner.text = "Creating message...";
      const message = new Message(pkgContent, "application/octet-stream", {
        title,
        description,
        type: "ownable",
        thumbnail: thumbnail || undefined,
      })
        .to(recipient)
        .signWith(account);

      if (relay && relay.trim() !== "") {
        spinner.text = "Sending to relay...";
        const relayUrl = relay || RELAY_URL;
        const relayClient = new Relay(relayUrl);

        try {
          await relayClient.send(message);
          spinner.succeed(`Transfer ${i + 1} completed successfully`);
        } catch (error) {
          spinner.fail(`Transfer ${i + 1} failed: ${error.message}`);
          throw error;
        }
      } else {
        spinner.succeed(`Transfer ${i + 1} completed (no relay specified)`);
      }

      if (i < transferCount - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    spinner.succeed(`All ${transferCount} transfer(s) completed successfully`);
  } catch (error) {
    spinner.fail(`Transfer failed: ${error.message}`);
    throw error;
  }
}

module.exports = { transfer };
