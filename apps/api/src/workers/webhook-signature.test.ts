import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, deliverOnce, signPayload, verifySkoutSignatureHeader } from "./webhook-delivery.worker.js";

/**
 * PAPI-070 (JOB-4): a real delivery carries `Skout-Signature: t=…,v1=…`, and the reference verifiers
 * shipped for the docs (Node and Python) validate it; the legacy x-skout-signature stays unchanged.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, "../../../../docs/public-api/webhooks");
const SECRET = "whsec_test_0123456789abcdef";

type Captured = { headers: Record<string, string | string[] | undefined>; body: string };

function python(): string | null {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}

describe("webhook signatures (PAPI-070)", () => {
  let server: Server;
  let url = "";
  const received: Captured[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function deliver() {
    await deliverOnce("del_1", {
      deliveryId: "del_1",
      endpointId: "ep_1",
      url,
      secret: SECRET,
      workspaceId: "ws_1",
      eventType: "api.job.completed",
      eventId: "evt_1",
      attempt: 1,
      payload: { job_id: "job_abc", status: "completed", note: "unicode ✓ é" },
    } as never, { isBlocked: () => false }); // the receiver is on 127.0.0.1, which PAPI-071 blocks in production
    return received.at(-1)!;
  }

  it("sends Skout-Signature t=…,v1=… with the same HMAC as the legacy header", async () => {
    const got = await deliver();
    const header = String(got.headers["skout-signature"]);
    expect(header).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
    const t = Number(/t=(\d+)/.exec(header)![1]);
    expect(String(got.headers["x-skout-timestamp"])).toBe(String(t));
    expect(got.headers["x-skout-signature"]).toBe(signPayload(SECRET, t, got.body));
    expect(header.split("v1=")[1]).toBe(String(got.headers["x-skout-signature"]).slice("sha256=".length));
    expect(verifySkoutSignatureHeader(SECRET, header, got.body)).toBe(true);
  });

  it("the TypeScript reference verifier for the docs accepts a real delivery and rejects tampering, old or wrong-secret ones", async () => {
    const { verifySkoutSignature } = (await import(pathToFileURL(path.join(docs, "verify-skout-signature.ts")).href)) as {
      verifySkoutSignature: (s: string, h: string, b: string, o?: { now?: number }) => boolean;
    };
    const got = await deliver();
    const header = String(got.headers["skout-signature"]);
    expect(verifySkoutSignature(SECRET, header, got.body)).toBe(true);
    expect(verifySkoutSignature(SECRET, header, got.body.replace("completed", "failed"))).toBe(false);
    expect(verifySkoutSignature("whsec_other", header, got.body)).toBe(false);
    expect(verifySkoutSignature(SECRET, header, got.body, { now: Date.now() / 1000 + 301 })).toBe(false);
    expect(verifySkoutSignature(SECRET, "", got.body)).toBe(false);
    // A receiver that also accepts a future v2 entry keeps working: extra entries are ignored.
    expect(verifySkoutSignature(SECRET, `${header},v2=deadbeef`, got.body)).toBe(true);
  });

  it("the Python reference verifier for the docs accepts a real delivery and rejects a tampered one", async () => {
    const py = python();
    if (!py) return; // no Python on this machine; the Node verifier covers the same scheme
    const got = await deliver();
    const header = String(got.headers["skout-signature"]);
    const run = (body: string) => spawnSync(py, [path.join(docs, "verify_skout_signature.py"), SECRET, header], { input: Buffer.from(body, "utf8") });
    expect(run(got.body).status).toBe(0);
    expect(run(got.body + " ").status).toBe(1);
  });

  it("retries with exponential backoff for about 24 hours (JOB-5)", () => {
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(23 * 3_600_000);
    expect(total).toBeLessThanOrEqual(24 * 3_600_000);
    for (let i = 1; i < RETRY_DELAYS_MS.length; i++) expect(RETRY_DELAYS_MS[i]!).toBeGreaterThan(RETRY_DELAYS_MS[i - 1]!);
    expect(MAX_ATTEMPTS).toBe(RETRY_DELAYS_MS.length + 1);
  });
});
