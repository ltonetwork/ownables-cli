# Ownables CLI

A command-line tool for building Ownables, making it easy to compile and package your CosmWasm smart contracts.

## Installation

```bash
npm install -g ownables-cli
```

Or use it directly with npx:

```bash
npx ownables-cli
```

## Prerequisites

Before using the CLI, make sure you have the following installed:

- [Rust](https://rustup.rs/)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Cargo](https://doc.rust-lang.org/cargo/getting-started/installation.html)

## Usage

### Building an Ownable

Navigate to your Rust project directory and run:

```bash
ownables-cli build
```

This command will:

1. Check for required dependencies
2. Verify the project structure
3. Build the WebAssembly files
4. Generate the schema
5. Create a package with all necessary files

The output will be a zip file containing:

- Compiled WASM files
- JavaScript bindings
- Schema files
- Assets

## Project Structure

Your Rust project should have the following structure:

```
your-ownable/
├── Cargo.toml
├── src/
│   └── lib.rs
├── assets/
└── schema/
```

## Error Handling

The CLI will provide clear error messages if:

- Required dependencies are missing
- Project structure is invalid
- Build process fails
- Schema generation fails
