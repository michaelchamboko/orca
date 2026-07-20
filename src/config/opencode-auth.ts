import { emitKeypressEvents } from "node:readline";

export interface OpenCodeConnectionConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export class OpenCodeCredentialsUnavailableError extends Error {
  constructor() {
    super("OpenCode credentials are unavailable: set OPENCODE_SERVER_PASSWORD or run doctor from an interactive terminal.");
    this.name = "OpenCodeCredentialsUnavailableError";
  }
}

export interface ResolveOpenCodeConnectionConfigOptions {
  baseUrl?: string;
  environment?: Record<string, string | undefined>;
  interactive?: boolean;
  prompt?: () => Promise<string>;
}

export async function resolveOpenCodeConnectionConfig(options: ResolveOpenCodeConnectionConfigOptions = {}): Promise<OpenCodeConnectionConfig> {
  const environment = options.environment ?? process.env;
  const password = environment.OPENCODE_SERVER_PASSWORD;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!password && !interactive) throw new OpenCodeCredentialsUnavailableError();
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl ?? environment.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"),
    username: environment.OPENCODE_SERVER_USERNAME ?? "opencode",
    password: password ?? await (options.prompt ?? readPassword)()
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readPassword(): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new OpenCodeCredentialsUnavailableError();
  emitKeypressEvents(input);
  output.write("OpenCode server password: ");
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let password = "";
    const done = (error?: Error) => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\n");
      if (error) reject(error); else resolve(password);
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") return done(new Error("OpenCode password entry cancelled"));
      if (key.name === "return" || key.name === "enter") return done();
      if (key.name === "backspace") {
        password = password.slice(0, -1);
        return;
      }
      if (character) password += character;
    };
    input.on("keypress", onKeypress);
  });
}
