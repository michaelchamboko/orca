import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isAuthorizedBearer(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
