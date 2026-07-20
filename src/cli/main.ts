import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { fileURLToPath } from "node:url";

export function getVersion(): string {
  return packageJson.version;
}

export function buildCliProgram(): Command {
  const program = new Command();

  program
    .name("swarmctl")
    .description("OpenCode five-session orchestration controller CLI")
    .version(getVersion());

  return program;
}

function main(): void {
  const program = buildCliProgram();

  program.parse(process.argv);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
