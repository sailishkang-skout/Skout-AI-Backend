import { promises as dns, type MxRecord } from "node:dns";

// Skout-managed record values that must be present for a "pass"
const SPF_INCLUDE = "_spf.skout.dev";
const DKIM_SELECTOR = "skout";
const DMARC_PREFIX = "v=DMARC1";

export type DnsRecordStatus = "pass" | "fail" | "unknown";

export interface DnsCheckResult {
  spf: DnsRecordStatus;
  dkim: DnsRecordStatus;
  dmarc: DnsRecordStatus;
  mx: DnsRecordStatus;
  records: StoredDnsRecord[];
  error?: string;
}

export interface StoredDnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: "SPF" | "DKIM" | "DMARC" | "MX";
  status: DnsRecordStatus;
}

function flatTxt(settled: PromiseSettledResult<string[][]>): string[] {
  if (settled.status === "rejected") return [];
  return settled.value.map((chunks) => chunks.join(""));
}

function checkSpf(settled: PromiseSettledResult<string[][]>): DnsRecordStatus {
  if (settled.status === "rejected") return "fail";
  const records = flatTxt(settled);
  return records.some((r) => r.includes(SPF_INCLUDE)) ? "pass" : "fail";
}

function checkDkim(settled: PromiseSettledResult<string[][]>): DnsRecordStatus {
  if (settled.status === "rejected") return "fail";
  const records = flatTxt(settled);
  return records.some((r) => r.startsWith("v=DKIM1")) ? "pass" : "fail";
}

function checkDmarc(settled: PromiseSettledResult<string[][]>): DnsRecordStatus {
  if (settled.status === "rejected") return "fail";
  const records = flatTxt(settled);
  return records.some((r) => r.startsWith(DMARC_PREFIX)) ? "pass" : "fail";
}

function checkMx(settled: PromiseSettledResult<MxRecord[]>): DnsRecordStatus {
  if (settled.status === "rejected") return "fail";
  return settled.value.length > 0 ? "pass" : "fail";
}

function buildRecords(
  domain: string,
  spfSettled: PromiseSettledResult<string[][]>,
  dkimSettled: PromiseSettledResult<string[][]>,
  dmarcSettled: PromiseSettledResult<string[][]>,
  mxSettled: PromiseSettledResult<MxRecord[]>,
  spf: DnsRecordStatus,
  dkim: DnsRecordStatus,
  dmarc: DnsRecordStatus,
  mx: DnsRecordStatus
): StoredDnsRecord[] {
  const spfVal =
    spfSettled.status === "fulfilled"
      ? flatTxt(spfSettled).find((r) => r.includes("spf1")) ?? `v=spf1 include:${SPF_INCLUDE} ~all`
      : `v=spf1 include:${SPF_INCLUDE} ~all`;

  const dkimVal =
    dkimSettled.status === "fulfilled"
      ? flatTxt(dkimSettled)[0] ?? "v=DKIM1; k=rsa; p=PLACEHOLDER_CONTACT_SUPPORT"
      : "v=DKIM1; k=rsa; p=PLACEHOLDER_CONTACT_SUPPORT";

  const dmarcVal =
    dmarcSettled.status === "fulfilled"
      ? flatTxt(dmarcSettled)[0] ?? `v=DMARC1; p=none; rua=mailto:dmarc@skout.dev`
      : `v=DMARC1; p=none; rua=mailto:dmarc@skout.dev`;

  const mxVal =
    mxSettled.status === "fulfilled" && mxSettled.value[0]
      ? `${mxSettled.value[0].priority} ${mxSettled.value[0].exchange}`
      : "10 mail.skout.dev";

  return [
    { type: "TXT", name: domain, value: spfVal, purpose: "SPF", status: spf },
    { type: "TXT", name: `${DKIM_SELECTOR}._domainkey.${domain}`, value: dkimVal, purpose: "DKIM", status: dkim },
    { type: "TXT", name: `_dmarc.${domain}`, value: dmarcVal, purpose: "DMARC", status: dmarc },
    { type: "MX", name: domain, value: mxVal, purpose: "MX", status: mx },
  ];
}

/**
 * Performs live DNS lookups for SPF, DKIM, DMARC and MX records.
 * All four lookups run in parallel; a single failure does not abort the rest.
 */
export async function checkDomainDns(domain: string): Promise<DnsCheckResult> {
  const [spfSettled, dkimSettled, dmarcSettled, mxSettled] = await Promise.allSettled([
    dns.resolveTxt(domain),
    dns.resolveTxt(`${DKIM_SELECTOR}._domainkey.${domain}`),
    dns.resolveTxt(`_dmarc.${domain}`),
    dns.resolveMx(domain),
  ]);

  const spf = checkSpf(spfSettled);
  const dkim = checkDkim(dkimSettled);
  const dmarc = checkDmarc(dmarcSettled);
  const mx = checkMx(mxSettled);

  return {
    spf,
    dkim,
    dmarc,
    mx,
    records: buildRecords(domain, spfSettled, dkimSettled, dmarcSettled, mxSettled, spf, dkim, dmarc, mx),
  };
}

/** Returns expected DNS records without performing lookups (used at domain creation). */
export function generateExpectedDnsRecords(domain: string): StoredDnsRecord[] {
  return [
    {
      type: "TXT",
      name: domain,
      value: `v=spf1 include:${SPF_INCLUDE} ~all`,
      purpose: "SPF",
      status: "unknown",
    },
    {
      type: "TXT",
      name: `${DKIM_SELECTOR}._domainkey.${domain}`,
      value: "v=DKIM1; k=rsa; p=PLACEHOLDER_CONTACT_SUPPORT",
      purpose: "DKIM",
      status: "unknown",
    },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: "v=DMARC1; p=none; rua=mailto:dmarc@skout.dev",
      purpose: "DMARC",
      status: "unknown",
    },
    {
      type: "MX",
      name: domain,
      value: "10 mail.skout.dev",
      purpose: "MX",
      status: "unknown",
    },
  ];
}
