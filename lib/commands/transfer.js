const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");
const inquirer = require("inquirer");
const JSZip = require("jszip");
const ora = require("ora");
const sharp = require("sharp");
const axios = require("axios");
const { create } = require("ipfs-http-client/dist/index.js");
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

  // Debug: List all files in the ZIP
  spinner.info("ZIP contents:");
  Object.keys(zip.files).forEach((filename) => {
    spinner.info(chalk.cyan(`  - ${filename}`));
  });

  const packageJsonFile = zip.file("package.json");
  if (!packageJsonFile) {
    // Try to find package.json with case-insensitive search
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

  // Calculate the package CID
  const zipPath = await findZipFile();
  const packageCID = await calculatePackageCID(zipPath);

  const msg = {
    "@context": "execute_msg.json",
    ownable_id: chain.id,
    package: packageCID,
    network_id: networkId,
    keywords: keywords,
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
        networkId === "L" ? MAINNET_EXPLORER_URL : TESTNET_EXPLORER_URL;

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

async function calculatePackageCID(zipPath) {
  // Create a new IPFS client
  const ipfs = create({ url: "https://ipfs.infura.io:5001/api/v0" });

  // Read the ZIP file
  const zipContent = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(zipContent);
  const newZip = new JSZip();
  for (const [filename, file] of Object.entries(zip.files)) {
    if (!filename.startsWith(".") && filename !== "chain.json") {
      const content = await file.async("nodebuffer");
      newZip.file(filename, content);
    }
  }

  // Generate the new ZIP content
  const newZipContent = await newZip.generateAsync({ type: "nodebuffer" });

  // Add the ZIP content to IPFS
  const { cid } = await ipfs.add(newZipContent);

  return cid.toString();
}

async function transfer() {
  const spinner = ora("Initializing transfer...").start();

  try {
    // Find ZIP
    spinner.text = "Looking for ZIP file...";
    const zipPath = await findZipFile();
    spinner.succeed(`Found ZIP file: ${path.basename(zipPath)}`);

    // Extract metadata early to show info
    spinner.text = "Reading package information...";
    const { title, description, keywords, zip, thumbnail, existingChain } =
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
        type: "input",
        name: "creator",
        message: "Created by:",
        validate: (input) => (input.trim() !== "" ? true : "Joe Doe"),
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

    // Get seed phrase
    const { seed } = await inquirer.prompt([
      {
        type: "password",
        name: "seed",
        message: "Enter your seed phrase:",
        validate: (input) => (input.trim() !== "" ? true : "Seed is required"),
      },
    ]);

    // Create LTO instance
    const lto = new LTO(networkId);
    const account = lto.account({ seed });

    // Check balance
    spinner.text = "Checking account balance...";
    const balance = await checkBalance(account.address, networkId);
    const requiredBalance = transferCount * LTO_FEE; //Minimum amount required per transfer

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

      const { chainJson, anchorTx } = await createEventAndChainJson(
        account,
        title,
        keywords,
        networkId,
        recipient,
        spinner,
        existingChain
      );

      spinner.text = "Adding chain.json to ZIP...";
      const updatedZipContent = await addChainJsonToZip(zip, chainJson);

      // Create binary content from the modified zip
      let pkgContent;
      try {
        const binaryData = new Uint8Array(updatedZipContent);
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

      if (relay || relay.trim() !== "") {
        spinner.text = "Sending to relay...";
        const relayUrl = relay || "https://relay.lto.network";
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

      // Small delay between transfers to prevent rate limiting
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
