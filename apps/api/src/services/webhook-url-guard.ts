/**
 * SSRF protection for outbound webhooks (public API JOB-6, PAPI-071).
 *
 * Two layers:
 *  - `webhookUrlProblem`, at save time: https only, no credentials, no local/internal hostnames, no
 *    private IP literals.
 *  - `guardedLookup` / `assertPublicAddress`, at delivery time: every address the hostname resolves
 *    to must be public, checked inside the socket's own DNS lookup, so the address we check is the
 *    address we connect to. A name that was public when saved and points at 10.x later (DNS
 *    rebinding) is refused.
 */
import dns from "node:dns";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified and IPv4-compatible (::1 is below, ::a.b.c.d here)
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64, can reach any IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo, embeds an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, embeds an IPv4 address
  ["fc00::", 7], // unique local, incl. AWS metadata fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/**
 * True for an address a webhook must not be sent to: private, loopback, link-local, metadata,
 * multicast, reserved, documentation. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is checked as IPv4.
 * Anything that is not a valid IP counts as blocked.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // strip brackets and a zone id
  const v = isIP(ip);
  if (v === 0) return true;
  return blocked.check(ip, v === 4 ? "ipv4" : "ipv6");
}

/**
 * Save-time check. Webhooks send customer data to another server, so the address must be public
 * HTTPS: no localhost, no private or link-local IPs, no internal hostnames. Returns the problem, or null.
 */
export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Must be a valid URL";
  }
  if (u.protocol !== "https:") return "Must start with https://";
  if (u.username || u.password) return "Must not contain a username or password";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host) ? "Must be a public address, not a private IP" : null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return "Must be a public address, not a local or internal one";
  }
  return null;
}

/** Thrown when a webhook's host is, or resolves to, an address we don't send to. */
export class BlockedAddressError extends Error {
  constructor(host: string, address: string) {
    super(`Webhook host ${host} resolves to a non-public address (${address}); not delivering`);
    this.name = "BlockedAddressError";
  }
}

/**
 * Throws BlockedAddressError when `host` is an IP literal that is blocked. Node skips `lookup` for
 * IP literals, so these are checked here; names are checked by guardedLookup.
 */
export function assertPublicAddress(host: string, isBlocked: (address: string) => boolean = isPrivateAddress): void {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) && isBlocked(bare)) throw new BlockedAddressError(host, bare);
}

type LookupAddress = { address: string; family: number };
export type LookupAllFn = (
  hostname: string,
  options: { all: true; family?: number },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const dnsLookupAll: LookupAllFn = (hostname, options, cb) => dns.lookup(hostname, options, cb);

/**
 * A `lookup` for http(s).request / net.connect that resolves every address for the host and fails
 * with BlockedAddressError if any of them is blocked. Node calls it while opening the socket and
 * connects to the address it returns, so there is no gap between the check and the connection.
 * `resolve` and `isBlocked` are for tests only.
 */
export function guardedLookup(resolve: LookupAllFn = dnsLookupAll, isBlocked: (address: string) => boolean = isPrivateAddress) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
  ): void => {
    resolve(hostname, { family: options.family, all: true }, (err, addresses) => {
      if (err) return cb(err, "");
      if (!addresses?.length) return cb(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), "");
      const bad = addresses.find((a) => isBlocked(a.address));
      if (bad) return cb(new BlockedAddressError(hostname, bad.address), "");
      if (options.all) return cb(null, addresses);
      cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
