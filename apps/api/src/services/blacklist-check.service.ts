import { Resolver } from "node:dns/promises";

const DNSBLS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "dnsbl.sorbs.net",
  "b.barracudacentral.org",
];

// Use public resolvers directly — avoids ECONNREFUSED on machines where the
// system stub resolver blocks A record queries (common on Windows/corporate DNS).
const resolver = new Resolver({ timeout: 5000 });
resolver.setServers(["8.8.8.8", "1.1.1.1"]);

export interface BlacklistResult {
  status: "clean" | "blacklisted" | "error";
  listedOn: string[];
  error?: string;
}

async function checkIpOnDnsbl(reversedIp: string, dnsbl: string): Promise<boolean> {
  try {
    await resolver.resolve4(`${reversedIp}.${dnsbl}`);
    return true; // record found = listed
  } catch {
    return false; // NXDOMAIN = clean
  }
}

/**
 * Checks a domain's resolved IP against major DNSBL lists.
 * Uses only node:dns — no external packages required.
 */
export async function checkDomainBlacklist(domain: string): Promise<BlacklistResult> {
  let ips: string[];
  try {
    ips = await resolver.resolve4(domain);
  } catch (err) {
    return {
      status: "error",
      listedOn: [],
      error: `Could not resolve IP for domain: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ip = ips[0];
  if (!ip) {
    return { status: "error", listedOn: [], error: "Domain resolved to no IPv4 addresses" };
  }

  const reversedIp = ip.split(".").reverse().join(".");
  const checks = await Promise.all(
    DNSBLS.map(async (dnsbl) => ({ dnsbl, listed: await checkIpOnDnsbl(reversedIp, dnsbl) }))
  );

  const listedOn = checks.filter((c) => c.listed).map((c) => c.dnsbl);
  return {
    status: listedOn.length > 0 ? "blacklisted" : "clean",
    listedOn,
  };
}
