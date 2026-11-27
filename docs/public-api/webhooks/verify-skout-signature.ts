// Reference verifier for Skout webhook signatures (public API PRD JOB-4), TypeScript / Node 18+, no dependencies.
//
// Every delivery carries:  Skout-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
// Verify against the RAW request body (before JSON parsing), reject anything older than 5 minutes,
// and compare in constant time. Use the endpoint's signing secret from POST /webhooks.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyOptions {
  /** How old a delivery may be, in seconds (default 300). */
  toleranceSeconds?: number;
  /** The current time in unix seconds (default now); for tests. */
  now?: number;
}

export function verifySkoutSignature(secret: string, header: string | undefined, rawBody: string, options: VerifyOptions = {}): boolean {
  const { toleranceSeconds = 300, now = Date.now() / 1000 } = options;
  if (!header) return false;
  const pairs = header.split(",").map((part) => part.trim().split("="));
  const t = Number(pairs.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return pairs
    .filter(([k]) => k === "v1")
    .some(([, v]) => {
      const got = Buffer.from(v ?? "");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}

// Example (Express):
//   app.post("/skout", express.raw({ type: "application/json" }), (req, res) => {
//     if (!verifySkoutSignature(process.env.SKOUT_WEBHOOK_SECRET!, req.get("Skout-Signature"), req.body.toString("utf8"))) {
//       return res.status(400).send("bad signature");
//     }
//     const event = JSON.parse(req.body.toString("utf8")); // event.type, event.data
//     res.sendStatus(200);
//   });
