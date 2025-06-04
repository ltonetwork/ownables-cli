const fs = require("fs-extra");
const path = require("path");
const sharp = require("sharp");
const ora = require("ora");

const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_AUDIO_SIZE = 50 * 1024 * 1024; // 50MB
const MIN_IMAGE_DIMENSIONS = { width: 300, height: 300 };
const MAX_IMAGE_DIMENSIONS = { width: 4096, height: 4096 };
const ALLOWED_AUDIO_FORMATS = [".mp3", ".wav", ".ogg"];
const ALLOWED_IMAGE_FORMATS = [".jpg", ".jpeg", ".png", ".webp"];

/**
 * Validate image dimensions and format
 **/
async function validateImage(imagePath) {
  try {
    const metadata = await sharp(imagePath).metadata();

    if (
      !ALLOWED_IMAGE_FORMATS.includes(path.extname(imagePath).toLowerCase())
    ) {
      throw new Error(
        `Unsupported image format. Allowed formats: ${ALLOWED_IMAGE_FORMATS.join(
          ", "
        )}`
      );
    }

    if (
      metadata.width < MIN_IMAGE_DIMENSIONS.width ||
      metadata.height < MIN_IMAGE_DIMENSIONS.height
    ) {
      throw new Error(
        `Image dimensions too small. Minimum: ${MIN_IMAGE_DIMENSIONS.width}x${MIN_IMAGE_DIMENSIONS.height}`
      );
    }

    if (
      metadata.width > MAX_IMAGE_DIMENSIONS.width ||
      metadata.height > MAX_IMAGE_DIMENSIONS.height
    ) {
      throw new Error(
        `Image dimensions too large. Maximum: ${MAX_IMAGE_DIMENSIONS.width}x${MAX_IMAGE_DIMENSIONS.height}`
      );
    }

    const stats = await fs.stat(imagePath);
    if (stats.size > MAX_IMAGE_SIZE) {
      throw new Error(
        `Image file too large. Maximum size: ${
          MAX_IMAGE_SIZE / (1024 * 1024)
        }MB`
      );
    }

    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Image file not found: ${imagePath}`);
    }
    throw error;
  }
}

/**
 * Validate audio file format and size
 */
async function validateAudio(audioPath) {
  try {
    const ext = path.extname(audioPath).toLowerCase();
    if (!ALLOWED_AUDIO_FORMATS.includes(ext)) {
      throw new Error(
        `Unsupported audio format. Allowed formats: ${ALLOWED_AUDIO_FORMATS.join(
          ", "
        )}`
      );
    }

    const stats = await fs.stat(audioPath);
    if (stats.size > MAX_AUDIO_SIZE) {
      throw new Error(
        `Audio file too large. Maximum size: ${
          MAX_AUDIO_SIZE / (1024 * 1024)
        }MB`
      );
    }

    return stats;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Audio file not found: ${audioPath}`);
    }
    throw error;
  }
}

/**
 * Clean up temporary files
 */
async function cleanupTempFiles(files) {
  try {
    await Promise.all(files.map((file) => fs.remove(file)));
  } catch (error) {
    console.warn("Failed to cleanup temporary files:", error);
  }
}

async function handleStaticOwnable(projectPath, outputDir, metadata, spinner) {
  const tempFiles = [];
  try {
    const imagesDir = path.join(projectPath, "assets/images");
    const images = await fs.readdir(imagesDir);

    // Find any file with a supported image extension
    const imageFiles = images.filter((file) =>
      ALLOWED_IMAGE_FORMATS.includes(path.extname(file).toLowerCase())
    );

    if (imageFiles.length === 0) {
      throw new Error(
        `No image files found in assets/images. Supported formats: ${ALLOWED_IMAGE_FORMATS.join(
          ", "
        )}`
      );
    }

    // Use the first image file found
    const imageFile = imageFiles[0];

    // Validate image
    const sourceImagePath = path.join(projectPath, "assets/images", imageFile);
    if (spinner) spinner.text = "Validating image...";
    await validateImage(sourceImagePath);

    // Process images in parallel with progress tracking
    if (spinner) spinner.text = "Processing image...";
    const outputImagePath = path.join(outputDir, "images", imageFile);
    const thumbnailPath = path.join(outputDir, "thumbnail.webp");

    // Create output directories
    await fs.ensureDir(path.dirname(outputImagePath));
    await fs.ensureDir(path.dirname(thumbnailPath));

    // Process images with progress tracking
    await Promise.all([
      // Copy to images directory
      fs.copy(sourceImagePath, outputImagePath).then(() => {
        if (spinner) spinner.text = "Image copied successfully";
      }),
      // Create thumbnail
      sharp(sourceImagePath)
        .resize(300, 300, { fit: "inside" })
        .webp({ quality: 80 })
        .toFile(thumbnailPath)
        .then(() => {
          if (spinner) spinner.text = "Thumbnail created successfully";
        }),
    ]);

    return {
      imageFile,
      type: "image",
    };
  } catch (error) {
    // Cleanup on error
    await cleanupTempFiles(tempFiles);
    throw error;
  }
}

async function handleMusicOwnable(projectPath, outputDir, metadata, spinner) {
  const tempFiles = [];
  try {
    const projectName = metadata.name.toLowerCase().replace(/\s+/g, "-");

    // Check for required files in parallel
    if (spinner) spinner.text = "Checking required directories...";
    const [audioDir, imagesDir] = await Promise.all([
      fs.pathExists(path.join(projectPath, "assets/audio")),
      fs.pathExists(path.join(projectPath, "assets/images")),
    ]);

    if (!audioDir) {
      throw new Error("No audio directory found in assets");
    }

    if (!imagesDir) {
      throw new Error("No images directory found in assets");
    }

    // Read directories in parallel
    if (spinner) spinner.text = "Reading asset directories...";
    const [audioFiles, images] = await Promise.all([
      fs.readdir(path.join(projectPath, "assets/audio")),
      fs.readdir(path.join(projectPath, "assets/images")),
    ]);

    const musicFile = audioFiles.find((file) =>
      file.toLowerCase().endsWith(".mp3")
    );

    if (!musicFile) {
      throw new Error("No music.mp3 file found in assets/audio directory");
    }

    if (images.length < 2) {
      throw new Error(
        "At least two images are required in assets/images directory"
      );
    }

    // Find cover art and backdrop images
    const coverArt = images.find(
      (img) =>
        img.toLowerCase().includes("cover") ||
        img.toLowerCase().includes("front")
    );
    const backdrop = images.find(
      (img) =>
        img.toLowerCase().includes("backdrop") ||
        img.toLowerCase().includes("back")
    );

    if (!coverArt) {
      throw new Error(
        "No cover art image found. Please name one image with 'cover' or 'front' in the filename"
      );
    }

    if (!backdrop) {
      throw new Error(
        "No backdrop image found. Please name one image with 'backdrop' or 'back' in the filename"
      );
    }

    // Validate audio and images
    if (spinner) spinner.text = "Validating audio file...";
    const audioPath = path.join(projectPath, "assets/audio", musicFile);
    await validateAudio(audioPath);

    if (spinner) spinner.text = "Validating images...";
    const coverArtPath = path.join(projectPath, "assets/images", coverArt);
    const backdropPath = path.join(projectPath, "assets/images", backdrop);
    await Promise.all([
      validateImage(coverArtPath),
      validateImage(backdropPath),
    ]);

    // Create output directories
    await fs.ensureDir(path.join(outputDir, "audio"));
    await fs.ensureDir(path.join(outputDir, "images"));

    // Process all files in parallel with progress tracking
    if (spinner) spinner.text = "Processing assets...";
    await Promise.all([
      // Copy audio file
      fs
        .copy(
          path.join(projectPath, "assets/audio", musicFile),
          path.join(outputDir, "audio", musicFile)
        )
        .then(() => {
          if (spinner) spinner.text = "Audio file copied successfully";
        }),
      // Copy and process images
      fs
        .copy(
          path.join(projectPath, "assets/images", coverArt),
          path.join(outputDir, "images", coverArt)
        )
        .then(() => {
          if (spinner) spinner.text = "Cover art copied successfully";
        }),
      fs
        .copy(
          path.join(projectPath, "assets/images", backdrop),
          path.join(outputDir, "images", backdrop)
        )
        .then(() => {
          if (spinner) spinner.text = "Backdrop copied successfully";
        }),
      // Create thumbnail from cover art
      sharp(path.join(projectPath, "assets/images", coverArt))
        .resize(300, 300, { fit: "inside" })
        .webp({ quality: 80 })
        .toFile(path.join(outputDir, "thumbnail.webp"))
        .then(() => {
          if (spinner) spinner.text = "Thumbnail created successfully";
        }),
    ]);

    return {
      audioFile: musicFile,
      coverArt,
      backdrop,
      type: "music",
    };
  } catch (error) {
    // Cleanup on error
    await cleanupTempFiles(tempFiles);
    throw error;
  }
}

async function getOwnableType(projectPath) {
  const typePath = path.join(projectPath, "type.txt");
  if (!fs.existsSync(typePath)) {
    throw new Error("No type.txt found in project directory");
  }
  return fs.readFile(typePath, "utf8");
}

module.exports = {
  handleStaticOwnable,
  handleMusicOwnable,
  getOwnableType,
};
