import { z } from "zod";
import { describe, expect, test } from "vitest";

import {
  DomainValidationError,
  parseDomainError
} from "../../src/domain/errors.js";

describe("parseDomainError", () => {
  test("maps zod validation issues to path-based messages", () => {
    const parsed = z.object({ projectRoot: z.string().min(1) }).safeParse({ projectRoot: "" });
    if (parsed.success) {
      throw new Error("expected validation failure");
    }

    expect(parseDomainError(parsed.error)).toEqual(["projectRoot: String must contain at least 1 character(s)"]);
  });

  test("returns message text for standard errors", () => {
    const error = new DomainValidationError("bad input");
    expect(parseDomainError(error)).toEqual(["bad input"]);
  });

  test("stringifies unknown input", () => {
    expect(parseDomainError(42)).toEqual(["42"]);
  });
});
