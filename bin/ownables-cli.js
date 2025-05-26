#!/usr/bin/env node

const { Command } = require("commander");
const { create } = require("../lib/commands/create");
const { build } = require("../lib/commands/build");
const { transfer } = require("../lib/commands/transfer");

const program = new Command();

program
  .name("ownables")
  .description("CLI for creating and building Ownables")
  .version("1.0.0");

program
  .command("create")
  .description("Create a new Ownable project")
  .action(create);

program.command("build").description("Build an Ownable project").action(build);

program
  .command("transfer")
  .description("Transfer an Ownable package to a recipient via LTO Relay")
  .action(transfer);

program.parse();
