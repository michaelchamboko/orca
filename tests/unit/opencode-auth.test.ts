import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import {
  OpenCodeCredentialsUnavailableError,
  resolveOpenCodeConnectionConfig
} from "../../src/config/opencode-auth.js";

describe("resolveOpenCodeConnectionConfig", () => {
  it("uses environment credentials without prompting", async () => {
    const prompt = async () => {
      throw new Error("prompt should not be called");
    };

    await expect(
      resolveOpenCodeConnectionConfig({
        baseUrl: "http://127.0.0.1:4096",
        environment: {
          OPENCODE_SERVER_USERNAME: "operator",
          OPENCODE_SERVER_PASSWORD: "not-a-real-password"
        },
        interactive: false,
        prompt
      })
    ).resolves.toEqual({
      baseUrl: "http://127.0.0.1:4096",
      username: "operator",
      password: "not-a-real-password"
    });
  });

  it("uses a secure prompt only when the password is absent", async () => {
    await expect(
      resolveOpenCodeConnectionConfig({
        baseUrl: "http://127.0.0.1:4096",
        environment: { OPENCODE_SERVER_USERNAME: "operator" },
        interactive: true,
        prompt: async () => "prompt-only-password"
      })
    ).resolves.toMatchObject({ username: "operator", password: "prompt-only-password" });
  });

  it("fails clearly instead of hanging when stdin is noninteractive", async () => {
    await expect(
      resolveOpenCodeConnectionConfig({
        baseUrl: "http://127.0.0.1:4096",
        environment: {},
        interactive: false,
        prompt: async () => "unused"
      })
    ).rejects.toBeInstanceOf(OpenCodeCredentialsUnavailableError);
  });

  it("prompts for password on interactive sessions", async () => {
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
    const fakeStdin = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      setRawMode: (raw: boolean) => void;
      resume: () => void;
      off: (event: string | symbol, listener: (...args: unknown[]) => void) => EventEmitter;
      on: (event: string | symbol, listener: (...args: unknown[]) => void) => EventEmitter;
    };
    fakeStdin.isTTY = true;
    fakeStdin.setRawMode = () => undefined;
    fakeStdin.resume = () => undefined;

    const fakeStdout = {
      isTTY: true,
      writes: [] as string[],
      write: (chunk: string | Buffer | Uint8Array) => {
        fakeStdout.writes.push(Buffer.from(chunk).toString());
        return true;
      }
    };

    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: fakeStdout as unknown as NodeJS.WriteStream, configurable: true });

    try {
      const resultPromise = resolveOpenCodeConnectionConfig({
        baseUrl: "http://127.0.0.1:4096",
        environment: {
          OPENCODE_SERVER_USERNAME: "operator"
        },
        interactive: true
      });

      setTimeout(() => {
        fakeStdin.emit("keypress", "s", { name: "s" });
        fakeStdin.emit("keypress", "e", { name: "e" });
        fakeStdin.emit("keypress", "c", { name: "r" });
        fakeStdin.emit("keypress", "r", { name: "r" });
        fakeStdin.emit("keypress", "e", { name: "e" });
        fakeStdin.emit("keypress", "t", { name: "t" });
        fakeStdin.emit("keypress", "", { name: "return" });
      }, 0);

      await expect(
        resultPromise
      ).resolves.toMatchObject({
        username: "operator",
        password: "secret",
        baseUrl: "http://127.0.0.1:4096"
      });
      expect(fakeStdout.writes.join("")) .toContain("OpenCode server password:");
    } finally {
      if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
      if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
    }
  });
});
