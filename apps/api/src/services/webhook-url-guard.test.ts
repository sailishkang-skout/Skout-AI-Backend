import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BlockedAddressError, isPrivateAddress, webhookUrlProblem, type LookupAllFn } from "./webhook-url-guard.js";
import { deliverOnce } from "../workers/webhook-delivery.worker.js";
import { createCreateWebhookEndpoint } from "../public-api/endpoints/webhooks.js";

// PAPI-071 / JOB-6: SSRF protection for webhooks, at save time and after DNS resolution at delivery.

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.10.20.30",
    "10.0.0.1",
    "10.255.255.254",
    "169.254.169.254", // cloud metadata
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1", // IPv6 loopback
    "::",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:7f00:1", // same, hex form (what the URL parser produces)
    "::ffff:10.0.0.1",
    "fd00:ec2::254", // AWS metadata over IPv6
    "fc00::1",
    "fe80::1",
    "fe80::1%eth0",
    "64:ff9b::a00:1", // NAT64 to 10.0.0.1
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("webhookUrlProblem (save time)", () => {
  it.each([
    "https://127.0.0.1/hook",
    "https://10.1.2.3/hook",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://[fd00:ec2::254]/hook",
    "https://localhost/hook",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://intranet/hook",
    "http://hooks.example.com/hook",
    "https://user:pass@hooks.example.com/hook",
    "not a url",
  ])("rejects %s", (url) => {
    expect(webhookUrlProblem(url)).not.toBeNull();
  });

  it.each(["https://hooks.example.com/skout", "https://8.8.8.8/hook", "https://[2606:4700:4700::1111]/hook"])("accepts %s", (url) => {
    expect(webhookUrlProblem(url)).toBeNull();
  });

  it("the public API POST /webhooks applies the same check", () => {
    const { input } = createCreateWebhookEndpoint({ env: {} as never, db: {} as never });
    const parse = (url: string) => input.safeParse({ url, events: ["api.job.completed"] });
    for (const bad of ["https://127.0.0.1/h", "https://10.0.0.5/h", "https://169.254.169.254/h", "https://[::1]/h", "http://hooks.example.com/h"]) {
      expect(parse(bad).success, bad).toBe(false);
    }
    expect(parse("https://hooks.example.com/h").success).toBe(true);
  });
});

describe("deliverOnce (delivery time, after DNS resolution)", () => {
  let server: Server;
  let port = 0;
  let hits = 0;
  let respond: (res: import("node:http").ServerResponse) => void = (res) => res.writeHead(200).end("ok");

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      req.resume();
      req.on("end", () => respond(res));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    hits = 0;
    respond = (res) => res.writeHead(200).end("ok");
  });

  const job = (url: string) =>
    ({
      deliveryId: "del_1",
      endpointId: "ep_1",
      url,
      secret: "whsec_test",
      workspaceId: "ws_1",
      eventType: "api.job.completed",
      eventId: "evt_1",
      attempt: 1,
      payload: { ok: true },
    }) as never;

  /** A resolver that answers every name with these addresses. */
  const resolvesTo =
    (...addresses: string[]): LookupAllFn =>
    (_host, _opts, cb) =>
      cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

  it.each([`http://127.0.0.1:PORT/hook`, `http://10.0.0.5:PORT/hook`, `http://169.254.169.254/latest/meta-data/`, `http://[::1]:PORT/hook`])(
    "refuses an IP-literal URL %s without connecting",
    async (raw) => {
      await expect(deliverOnce("del_1", job(raw.replace("PORT", String(port))))).rejects.toBeInstanceOf(BlockedAddressError);
      expect(hits).toBe(0);
    }
  );

  it("DNS rebinding: a name that was public when saved and now resolves to 127.0.0.1 is refused before connecting", async () => {
    const url = `http://hooks.customer-example.com:${port}/hook`;
    expect(webhookUrlProblem(url.replace("http:", "https:"))).toBeNull(); // passed the save-time check
    await expect(deliverOnce("del_1", job(url), { resolve: resolvesTo("127.0.0.1") })).rejects.toBeInstanceOf(BlockedAddressError);
    expect(hits).toBe(0); // the receiver on 127.0.0.1 never saw a request
  });

  it.each([["10.0.0.7"], ["169.254.169.254"], ["::1"], ["fd00:ec2::254"], ["93.184.216.34", "10.0.0.7"]])(
    "DNS rebinding: refuses a name resolving to %s",
    async (...addresses) => {
      await expect(deliverOnce("del_1", job("https://hooks.customer-example.com/hook"), { resolve: resolvesTo(...addresses) })).rejects.toThrow(
        /non-public address/
      );
    }
  );

  it("connects to the address the guarded lookup checked (the check is on the real connection)", async () => {
    const r = await deliverOnce("del_1", job(`http://hooks.customer-example.com:${port}/hook`), {
      resolve: resolvesTo("127.0.0.1"),
      isBlocked: () => false, // allow the local receiver for this one test
    });
    expect(r.statusCode).toBe(200);
    expect(hits).toBe(1);
  });

  it("does not follow redirects (a receiver can't bounce us to the metadata service)", async () => {
    respond = (res) => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    const r = await deliverOnce("del_1", job(`http://127.0.0.1:${port}/hook`), { isBlocked: () => false });
    expect(r.statusCode).toBe(302);
    expect(hits).toBe(1);
  });
});
