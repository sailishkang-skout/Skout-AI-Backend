import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export function generateOtp(): string {
  return String(randomInt(100000, 1000000));
}

export function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

export function verifyOtp(otp: string, storedHash: string): boolean {
  const inputHash = Buffer.from(hashOtp(otp));
  const stored = Buffer.from(storedHash);
  if (inputHash.length !== stored.length) return false;
  return timingSafeEqual(inputHash, stored);
}
