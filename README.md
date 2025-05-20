# Ownables CLI

A command-line tool for creating and building Ownables - digital assets with unique visual and audio experiences.

## Prerequisites

Before using the Ownables CLI, you'll need to set up your development environment:

### Windows

1. Install Rust:

   - Visit [https://rustup.rs/](https://rustup.rs/)
   - Download and run the installer

2. Install Visual Studio Build Tools:

   - Download from [Visual Studio Downloads](https://visualstudio.microsoft.com/downloads/)
   - Select "Desktop development with C++"

3. Install wasm-bindgen:

   ```bash
   cargo install wasm-bindgen-cli
   ```

4. Add WebAssembly target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

### macOS

1. Install Rust:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. Install Xcode Command Line Tools:

   ```bash
   xcode-select --install
   ```

3. Install wasm-bindgen:

   ```bash
   cargo install wasm-bindgen-cli
   ```

4. Add WebAssembly target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

### Linux

1. Install Rust:

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. Install build essentials:

   ```bash
   sudo apt-get update
   sudo apt-get install build-essential
   ```

3. Install wasm-bindgen:

   ```bash
   cargo install wasm-bindgen-cli
   ```

4. Add WebAssembly target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

## Installation

Install the Ownables CLI globally:

```bash
npm install -g @ownables/cli
```

## Quick Start

### Create a New Ownable

1. Create a new project:

   ```bash
   ownables create
   ```

2. Choose your template:

   - **Static Ownable**: For displaying a single image
   - **Music Ownable**: For audio with cover art and backdrop

3. Follow the prompts to:
   - Name your ownable
   - Add a description
   - Set version
   - Add authors
   - Add keywords

### Add Your Assets

#### For Static Ownables:

1. Add your image to `assets/images/`
   - Supported formats: jpg, jpeg, png, webp
   - Minimum size: 300x300 pixels
   - Maximum size: 4096x4096 pixels
   - Maximum file size: 50MB

#### For Music Ownables:

1. Add your audio file to `assets/audio/`

   - Format: mp3
   - Maximum size: 50MB

2. Add your images to `assets/images/`:
   - Cover art: Name with 'cover' or 'front' (e.g., 'cover.jpg')
   - Backdrop: Name with 'backdrop' or 'back' (e.g., 'backdrop.jpg')
   - Same requirements as static ownable images

### Build Your Ownable

1. Run the build command:

   ```bash
   ownables build
   ```

2. The CLI will:
   - Compile your code
   - Process your assets, schema, wasm and build
   - Create a package (a zip file) in the `build` directory - this is your ownable!

## Project Structure

```
your-ownable/
├── assets/
│   ├── images/     # Your image files
│   ├── audio/      # Your audio files (music ownables only)
│   └── index.html  # Display template
├── src/            # Rust source code
└── Cargo.toml      # Project configuration
```

## Need Help?

If you encounter any issues:

1. Check that all prerequisites are installed
2. Verify your assets meet the requirements
3. Ensure you're in the correct directory when running commands
