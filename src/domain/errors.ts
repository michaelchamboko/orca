import { ZodError } from "zod";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export function parseDomainError(error: unknown): string[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  }

  if (error instanceof Error) {
    return [error.message];
  }

  return [String(error)];
}
