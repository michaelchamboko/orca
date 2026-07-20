import { describe, expect, it } from "vitest";

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
});
