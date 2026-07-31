import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureLoopbackBypassesProxy } from "../../src/cli/main.js";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

const previousEnv: Record<string, string | undefined> = {};

function readEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

afterEach(() => restoreEnv(previousEnv));

beforeEach(() => {
  Object.assign(previousEnv, readEnv());
  for (const key of PROXY_ENV_KEYS) Reflect.deleteProperty(process.env, key);
});

describe("ensureLoopbackBypassesProxy", () => {
  test("adds loopback targets to NO_PROXY when missing", () => {
    ensureLoopbackBypassesProxy("http://127.0.0.1:4096");
    expect(process.env.NO_PROXY).toContain("127.0.0.1");
    expect(process.env.NO_PROXY).toContain("localhost");
    expect(process.env.NO_PROXY).toContain("::1");
  });

  test("preserves existing NO_PROXY entries", () => {
    process.env.NO_PROXY = "internal.corp,10.0.0.0/8";
    ensureLoopbackBypassesProxy("http://127.0.0.1:4096");
    expect(process.env.NO_PROXY).toContain("internal.corp");
    expect(process.env.NO_PROXY).toContain("10.0.0.0/8");
    expect(process.env.NO_PROXY).toContain("127.0.0.1");
  });

  test("is a no-op for non-loopback origins", () => {
    ensureLoopbackBypassesProxy("http://10.0.0.5:4096");
    expect(process.env.NO_PROXY).toBeUndefined();
    expect(process.env.no_proxy).toBeUndefined();
  });

  test("mirrors NO_PROXY to lowercase no_proxy", () => {
    ensureLoopbackBypassesProxy("http://127.0.0.1:4096");
    expect(process.env.no_proxy).toBe(process.env.NO_PROXY);
  });
});
