/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS commercial email addition, 2026-11-05).
 *   - Tables touched directly: contacts (read only: id, company_id, first_name, last_name, email),
 *     deals (read only: company_id, to check the contact belongs to the deal's account)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: a proposal or payment link is emailed to the account's contacts the rep picked; only
 *     their name and address are read.
 *   - Review date: 2026-11-05
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { defaultPriceBasis, proposalTcv } from "@skout/shared";
import PDFDocument from "pdfkit";
import type { Env } from "../config/env.js";
import { escapeHtml, renderTransactionalLayout, sendMail } from "./mail.service.js";
import { CommercialError } from "./cops-commercial.service.js";

const { contacts, proposals, proposalVersions, proposalLineItems, paymentRequests } = schema;

export interface EmailResult {
  /** Addresses the email was handed to the mail provider for. */
  to: string[];
  /** False when no mail provider is configured, so nothing actually left. */
  sent: boolean;
}

const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
};

/** The chosen contacts that have an email and sit on the deal's account; any other id is dropped. */
async function recipients(db: Db, workspaceId: string, dealId: string, contactIds: string[]) {
  if (!contactIds.length) return [];
  const [deal] = await db.select({ companyId: schema.deals.companyId }).from(schema.deals).where(and(eq(schema.deals.workspaceId, workspaceId), eq(schema.deals.id, dealId))).limit(1);
  if (!deal?.companyId) return [];
  const rows = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.companyId, deal.companyId), inArray(contacts.id, contactIds)));
  return rows.filter((r): r is typeof r & { email: string } => !!r.email);
}

type Attachment = { filename: string; content: Buffer; contentType: string };

async function deliver(config: Env, list: { firstName: string; email: string }[], build: (firstName: string) => { subject: string; text: string; html: string; attachments?: Attachment[] }): Promise<EmailResult> {
  let sent = list.length > 0;
  for (const r of list) {
    const res = await sendMail(config, { to: r.email, ...build(r.firstName) });
    if (!res.sent) sent = false;
  }
  return { to: list.map((r) => r.email), sent };
}

/**
 * Emails the current draft version of a proposal (its lines, total and a PDF) to the chosen
 * contacts. Called before the version is locked, so a proposal is only marked sent once it went out.
 */
export async function emailProposal(db: Db, config: Env, workspaceId: string, proposalId: string, contactIds: string[], message?: string): Promise<EmailResult> {
  const [proposal] = await db.select().from(proposals).where(and(eq(proposals.workspaceId, workspaceId), eq(proposals.id, proposalId))).limit(1);
  if (!proposal) throw new CommercialError("NOT_FOUND", "Proposal not found");
  if (["accepted", "declined", "expired"].includes(proposal.status)) {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", `Proposal is ${proposal.status}`, { status: proposal.status });
  }
  const list = await recipients(db, workspaceId, proposal.opportunityId, contactIds);
  if (!list.length) {
    throw new CommercialError("VALIDATION_FAILED", "None of the chosen people is a contact with an email on this account. Add a contact, then send the proposal.");
  }
  const [version] = await db
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.version, proposal.currentVersion)))
    .limit(1);
  if (!version) throw new CommercialError("NOT_FOUND", "Proposal version not found");
  if (version.sentAt) {
    throw new CommercialError("BUSINESS_STATE_CONFLICT", "The latest version was already sent; create a new version to change it", { version: version.version });
  }
  const lines = await db.select().from(proposalLineItems).where(eq(proposalLineItems.versionId, version.id)).orderBy(asc(proposalLineItems.position));
  // Same contract value the deal amount follows (TCV over the term, after every discount).
  const { tcv_minor: total } = proposalTcv({
    term_months: version.termMonths,
    discount_pct: Number(version.discountPct),
    lines: lines.map((l) => ({ kind: l.kind, price_basis: l.priceBasis, gross_minor: Number(l.grossMinor), net_minor: Number(l.netMinor) })),
  });
  const cur = version.currency;
  const price = (l: (typeof lines)[number]) => `${money(Number(l.netMinor), cur)}${(l.priceBasis ?? defaultPriceBasis(l.kind)) === "per_month" ? "/month" : ""}`;
  const rowsText = lines.map((l) => `- ${l.description} x ${l.quantity}: ${price(l)}`).join("\n");
  const rowsHtml = lines
    .map((l) => `<tr><td style="padding:6px 0;">${escapeHtml(l.description)} &times; ${l.quantity}</td><td style="padding:6px 0;text-align:right;">${escapeHtml(price(l))}</td></tr>`)
    .join("");
  const discount = Number(version.discountPct) > 0 ? ` including a ${Number(version.discountPct)}% discount` : "";
  const note = message?.trim();
  const pdf = await proposalPdf({
    title: proposal.title,
    version: version.version,
    termMonths: version.termMonths,
    discount,
    rows: lines.map((l) => ({ label: `${l.description} x ${l.quantity}`, amount: price(l) })),
    total: money(total, cur),
  });
  const attachments = [{ filename: `${proposal.title.replace(/[^\w. -]/g, "_")} v${version.version}.pdf`, content: pdf, contentType: "application/pdf" }];
  return deliver(config, list, (first) => ({
    attachments,
    subject: `Proposal: ${proposal.title}`,
    text: `Hi ${first},\n\n${note ? `${note}\n\n` : ""}Here is our proposal "${proposal.title}" (version ${version.version}):\n\n${rowsText}\n\nTotal contract value: ${money(total, cur)} over ${version.termMonths} months${discount}\n\nThe proposal is attached as a PDF. Reply to this email to accept or ask questions.\n`,
    html: renderTransactionalLayout({
      preheader: `Proposal ${proposal.title}: ${money(total, cur)}`,
      title: `Proposal: ${proposal.title}`,
      bodyHtml: `<p>Hi ${escapeHtml(first)},</p>${note ? `<p>${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : ""}<p>Here is our proposal (version ${version.version}):</p><table style="width:100%;border-collapse:collapse;font-size:14px;">${rowsHtml}<tr><td style="padding:8px 0;border-top:1px solid #e4e4e7;font-weight:600;">Total contract value (${version.termMonths} months${discount})</td><td style="padding:8px 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:600;">${escapeHtml(money(total, cur))}</td></tr></table><p>The proposal is attached as a PDF. Reply to this email to accept or ask questions.</p>`,
    }),
  }));
}

/** Emails a payment link's hosted checkout URL to one contact. */
export async function emailPaymentLink(db: Db, config: Env, workspaceId: string, paymentRequestId: string, contactId: string): Promise<EmailResult | null> {
  const [pr] = await db.select().from(paymentRequests).where(and(eq(paymentRequests.workspaceId, workspaceId), eq(paymentRequests.id, paymentRequestId))).limit(1);
  if (!pr || !pr.checkoutUrl) return null;
  const list = await recipients(db, workspaceId, pr.opportunityId, [contactId]);
  const amount = money(Number(pr.amountMinor), pr.currency);
  const url = pr.checkoutUrl;
  return deliver(config, list, (first) => ({
    subject: `Payment request: ${amount}`,
    text: `Hi ${first},\n\nYou can pay ${amount}${pr.description ? ` for ${pr.description}` : ""} here:\n${url}\n\nThe payment is handled on our payment provider's secure page.\n`,
    html: renderTransactionalLayout({
      preheader: `Pay ${amount} securely`,
      title: `Payment request: ${amount}`,
      bodyHtml: `<p>Hi ${escapeHtml(first)},</p><p>You can pay <strong>${escapeHtml(amount)}</strong>${pr.description ? ` for ${escapeHtml(pr.description)}` : ""} on our payment provider's secure page.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;background:#09090b;color:#fafafa;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Pay ${escapeHtml(amount)}</a></p>`,
    }),
  }));
}

/** A one-page proposal PDF: the same lines and total as the email. */
export function proposalPdf(p: { title: string; version: number; termMonths: number; discount: string; rows: { label: string; amount: string }[]; total: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "A4", info: { Title: `${p.title} v${p.version}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const right = doc.page.width - 56;
    doc.fontSize(20).font("Helvetica-Bold").text("Proposal", 56, 56);
    doc.moveDown(0.3).fontSize(13).font("Helvetica").text(p.title);
    doc.fontSize(10).fillColor("#666").text(`Version ${p.version} - ${new Date().toISOString().slice(0, 10)} - ${p.termMonths}-month term`);
    doc.moveDown(1.5).fillColor("#000");
    for (const r of p.rows) {
      const y = doc.y;
      doc.fontSize(11).font("Helvetica").text(r.label, 56, y, { width: right - 56 - 140 });
      doc.text(r.amount, right - 140, y, { width: 140, align: "right" });
      doc.moveDown(0.6);
    }
    doc.moveTo(56, doc.y).lineTo(right, doc.y).strokeColor("#ccc").stroke().moveDown(0.6);
    const y = doc.y;
    doc.font("Helvetica-Bold").text(`Total contract value (${p.termMonths} months${p.discount})`, 56, y, { width: right - 56 - 140 });
    doc.text(p.total, right - 140, y, { width: 140, align: "right" });
    doc.moveDown(2).font("Helvetica").fontSize(9).fillColor("#666").text("Prices exclude tax. This proposal is not a contract; the order form and MSA follow once it is accepted.", 56);
    doc.end();
  });
}
