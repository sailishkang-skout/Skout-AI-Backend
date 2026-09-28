import { describe, expect, it } from "vitest";
import { parseCsvText, rowToClerkExportUser, splitCsvLine } from "./convert-clerk-export-csv.js";

describe("splitCsvLine", () => {
  it("handles a quoted field with an embedded comma and a doubled quote", () => {
    expect(splitCsvLine('a,"b,c","d""e",f')).toEqual(["a", "b,c", 'd"e', "f"]);
  });
});

describe("rowToClerkExportUser", () => {
  it("marks the email verified when it appears in verified_email_addresses", () => {
    const user = rowToClerkExportUser({
      id: "user_abc",
      primary_email_address: "ada@example.com",
      verified_email_addresses: "ada@example.com,old@example.com",
      password_digest: "",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    expect(user).toMatchObject({
      id: "user_abc",
      email: "ada@example.com",
      email_verified: true,
      password_digest: null,
      first_name: "Ada",
      last_name: "Lovelace",
    });
  });

  it("marks the email unverified when the primary address is not in the verified list", () => {
    const user = rowToClerkExportUser({
      id: "user_ghi",
      primary_email_address: "unverified@example.com",
      verified_email_addresses: "",
    });
    expect(user.email_verified).toBe(false);
  });

  it("passes through a bcrypt digest untouched", () => {
    const user = rowToClerkExportUser({
      id: "user_def",
      primary_email_address: "grace@example.com",
      verified_email_addresses: "grace@example.com",
      password_digest: "$2a$10$abcdefghijklmnopqrstuv",
      password_hasher: "bcrypt",
    });
    expect(user.password_digest).toBe("$2a$10$abcdefghijklmnopqrstuv");
  });
});

describe("parseCsvText", () => {
  const header =
    "id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher,created_at";

  it("converts Clerk's real CSV shape end to end and counts digest presence", () => {
    const csv = [
      header,
      'user_abc,Ada,Lovelace,,ada@example.com,,"ada@example.com,old@example.com",,,,,,,"2026-01-01T00:00:00Z"',
      'user_def,Grace,Hopper,,grace@example.com,,grace@example.com,,,,,"$2a$10$abcdefghijklmnopqrstuv",bcrypt,"2026-01-01T00:00:00Z"',
    ].join("\n");

    const result = parseCsvText(csv);
    expect(result.users).toHaveLength(2);
    expect(result.withDigest).toBe(1);
    expect(result.nonBcryptHasher).toBe(0);
    expect(result.users[0]!.password_digest).toBeNull();
    expect(result.users[1]!.password_digest).toBe("$2a$10$abcdefghijklmnopqrstuv");
  });

  it("flags a non-bcrypt hasher without touching the digest value", () => {
    const csv = [header, "user_xyz,,,,x@example.com,,x@example.com,,,,,somehash,scrypt,"].join("\n");
    const result = parseCsvText(csv);
    expect(result.nonBcryptHasher).toBe(1);
  });

  it("throws on an empty file", () => {
    expect(() => parseCsvText("")).toThrow(/empty/i);
  });

  it("skips rows with no id", () => {
    const csv = [header, ",,,,,,,,,,,,,"].join("\n");
    expect(parseCsvText(csv).users).toHaveLength(0);
  });
});
