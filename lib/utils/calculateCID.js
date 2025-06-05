const fs = require("fs-extra");
const path = require("path");
const JSZip = require("jszip");
const { importer } = require("ipfs-unixfs-importer");

class SimpleBlockstore {
  constructor() {
    this.blocks = new Map();
  }

  async put(cid, block) {
    this.blocks.set(cid.toString(), block);
  }

  async get(cid) {
    const block = this.blocks.get(cid.toString());
    if (!block) {
      throw new Error(`Block not found: ${cid.toString()}`);
    }
    return block;
  }

  async has(cid) {
    return this.blocks.has(cid.toString());
  }

  async delete(cid) {
    return this.blocks.delete(cid.toString());
  }

  async *getAll() {
    for (const [cidStr, block] of this.blocks) {
      yield { cid: cidStr, block };
    }
  }
}

// Minimal blockstore that just stores hashes (for onlyHash: true)
class HashOnlyBlockstore {
  async get() {
    throw new Error("Block not available in hash-only mode");
  }

  async has() {
    return false;
  }

  async delete() {
    return false;
  }

  async *getAll() {
    // No blocks stored
  }
}

async function calculateZipCID(zipPath, spinner) {
  try {
    spinner.text = "Reading ZIP file...";
    const zipBuffer = await fs.readFile(zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);

    spinner.text = "Processing files...";
    const files = [];
    const excludePatterns = ["chain.json", ".*"];

    // Process files from ZIP
    for (const [filename, file] of Object.entries(zip.files)) {
      if (!file.dir && !shouldExclude(filename, excludePatterns)) {
        const content = await file.async("uint8array");
        files.push({
          path: `./package/${filename}`,
          content: content,
        });
      }
    }

    if (files.length === 0) {
      throw new Error("No files found to process after filtering");
    }

    spinner.text = "Calculating CID...";
    const blockstore = new HashOnlyBlockstore();
    let directoryCid;

    try {
      for await (const entry of importer(files, blockstore, {
        wrapWithDirectory: true,
        onlyHash: true,
        chunker: "size-262144", // Use consistent chunking
        rawLeaves: true,
        cidVersion: 1,
      })) {
        if (entry.path === "package" && entry.unixfs?.type === "directory") {
          directoryCid = entry.cid.toString();
          break;
        }
      }
    } catch (importError) {
      // Fallback: try without some options if the above fails
      spinner.text = "Retrying CID calculation with fallback options...";

      for await (const entry of importer(files, blockstore, {
        wrapWithDirectory: true,
        onlyHash: true,
      })) {
        if (entry.path === "package" && entry.unixfs?.type === "directory") {
          directoryCid = entry.cid.toString();
          break;
        }
      }
    }

    if (!directoryCid) {
      throw new Error(
        "Failed to calculate directory CID: importer did not find a directory entry in the input files"
      );
    }

    spinner.succeed(`CID calculated: ${directoryCid}`);
    return directoryCid;
  } catch (error) {
    spinner.fail("Failed to calculate CID");
    throw new Error(`CID calculation failed: ${error.message}`);
  }
}

// Enhanced pattern matching function
function shouldExclude(filePath, patterns) {
  return patterns.some((pattern) => {
    // Handle hidden files (starting with dot)
    if (pattern === ".*" && path.basename(filePath).startsWith(".")) {
      return true;
    }

    // Handle glob patterns
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" +
          pattern
            .replace(/\./g, "\\.") // Escape dots
            .replace(/\*/g, ".*") // Convert * to .*
            .replace(/\?/g, ".") + // Convert ? to .
          "$"
      );
      return regex.test(filePath);
    }

    // Handle directory patterns
    if (pattern.endsWith("/")) {
      return filePath.startsWith(pattern) || filePath === pattern.slice(0, -1);
    }

    // Exact match
    return filePath === pattern || path.basename(filePath) === pattern;
  });
}

// Alternative function that processes a directory instead of ZIP
async function calculateDirectoryCID(
  dirPath,
  spinner,
  excludePatterns = ["chain.json", ".*"]
) {
  try {
    spinner.text = "Reading directory...";
    const files = [];

    async function walkDirectory(currentPath, basePath = "") {
      const items = await fs.readdir(currentPath);

      for (const item of items) {
        const fullPath = path.join(currentPath, item);
        const relativePath = path.join(basePath, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
          if (!shouldExclude(relativePath + "/", excludePatterns)) {
            await walkDirectory(fullPath, relativePath);
          }
        } else {
          if (!shouldExclude(relativePath, excludePatterns)) {
            const content = await fs.readFile(fullPath);
            files.push({
              path: `./package/${relativePath}`,
              content: new Uint8Array(content),
            });
          }
        }
      }
    }

    await walkDirectory(dirPath);

    if (files.length === 0) {
      throw new Error("No files found to process after filtering");
    }

    spinner.text = "Calculating CID...";
    const blockstore = new HashOnlyBlockstore();
    let directoryCid;

    for await (const entry of importer(files, blockstore, {
      wrapWithDirectory: true,
      onlyHash: true,
      cidVersion: 1,
    })) {
      if (entry.path === "package" && entry.unixfs?.type === "directory") {
        directoryCid = entry.cid.toString();
        break;
      }
    }

    if (!directoryCid) {
      throw new Error("Failed to calculate directory CID");
    }

    spinner.succeed(`Directory CID calculated: ${directoryCid}`);
    return directoryCid;
  } catch (error) {
    spinner.fail("Failed to calculate directory CID");
    throw new Error(`Directory CID calculation failed: ${error.message}`);
  }
}

module.exports = {
  calculateZipCID,
  calculateDirectoryCID,
  SimpleBlockstore,
  HashOnlyBlockstore,
};
