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

  spinner.info("ZIP contents:");
  Object.keys(zip.files).forEach((filename) => {
    spinner.info(chalk.cyan(`  - ${filename}`));
  });

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

  const msg = existingChain
    ? {
        "@context": "execute_msg.json",
        transfer: {
          to: recipient,
        },
      }
    : {
        "@context": "instantiate_msg.json",
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

async function checkBalance(address, networkId) {
  const apiUrl = networkId === "L" ? MAINNET_API_URL : TESTNET_API_URL;
  try {
    const response = await axios.get(`${apiUrl}/addresses/balance/${address}`);
    return response.data.balance;
  } catch (error) {
    throw new Error(`Failed to check balance: ${error.message}`);
  }
}

async function transfer() {
  const spinner = ora("Starting transfer process...").start();

  try {
    const zipPath = await findZipFile();
    await validateZipFile(zipPath);

    const { title, keywords, zip, zipBuffer, thumbnail, existingChain } =
      await extractMetadata(zipPath, spinner);

    const { networkId, recipient, account } = await inquirer.prompt([
      {
        type: "list",
        name: "networkId",
        message: "Select network:",
        choices: [
          { name: "Mainnet", value: "L" },
          { name: "Testnet", value: "T" },
        ],
      },
      {
        type: "input",
        name: "recipient",
        message: "Enter recipient address:",
        validate: (input) => {
          if (!input) return "Recipient address is required";
          return true;
        },
      },
      {
        type: "input",
        name: "account",
        message: "Enter your seed phrase:",
        validate: (input) => {
          if (!input) return "Seed phrase is required";
          return true;
        },
      },
    ]);

    const ltoAccount = new LTO(networkId).account(account);
    const balance = await checkBalance(ltoAccount.address, networkId);

    if (balance < LTO_FEE) {
      throw new Error(
        `Insufficient balance. Required: ${LTO_FEE / 100000000} LTO`
      );
    }

    const { chainJson, anchorTx } = await createEventAndChainJson(
      ltoAccount,
      title,
      keywords,
      networkId,
      recipient,
      spinner,
      HARDCODED_CID,
      existingChain
    );

    const updatedZip = new JSZip();
    Object.keys(zip.files).forEach((filename) => {
      if (filename !== "chain.json") {
        updatedZip.file(filename, zip.files[filename]);
      }
    });

    updatedZip.file("chain.json", JSON.stringify(chainJson, null, 2));

    const outputPath = path.join(
      process.cwd(),
      `${title.toLowerCase().replace(/\s+/g, "-")}-transferred.zip`
    );
    const content = await updatedZip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(outputPath, content);

    spinner.succeed("Transfer completed successfully! 🎉");
    console.log(`\nUpdated package saved to: ${outputPath}`);

    if (anchorTx) {
      const explorerUrl =
        networkId === "L" ? MAINNET_EXPLORER_URL : TESTNET_EXPLORER_URL;
      console.log(
        `\nView transaction: ${explorerUrl}/transactions/${anchorTx.id}`
      );
    }
  } catch (error) {
    spinner.fail("Transfer failed");
    console.error(`\nError: ${error.message}`);
    throw error;
  }
}

module.exports = { transfer };
