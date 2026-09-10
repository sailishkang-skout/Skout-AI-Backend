import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { signToken, verifyToken } from "../utils/signed-token.js";
import { trackingSecret } from "./suppression.service.js";

const { sequenceTrackingEvents } = schema;

interface TrackingTokenPayload {
  enrollmentId: string;
  enrollmentStepId: string;
  url?: string;
}

function baseUrl(config: Env): string {
  return config.API_PUBLIC_URL ?? `http://localhost:${config.PORT}`;
}

export function buildOpenPixelUrl(config: Env, enrollmentId: string, enrollmentStepId: string): string {
  const token = signToken<TrackingTokenPayload>({ enrollmentId, enrollmentStepId }, trackingSecret(config));
  // No literal ".gif" suffix — the token itself contains "." separators that would
  // otherwise collide with a route segment mixing a param and a static extension.
  // Content-Type: image/gif is set explicitly by the route instead.
  return `${baseUrl(config)}/api/v1/track/open/${token}`;
}

export function buildClickUrl(
  config: Env,
  enrollmentId: string,
  enrollmentStepId: string,
  url: string
): string {
  const token = signToken<TrackingTokenPayload>(
    { enrollmentId, enrollmentStepId, url },
    trackingSecret(config)
  );
  return `${baseUrl(config)}/api/v1/track/click/${token}`;
}

export function decodeTrackingToken(config: Env, token: string): TrackingTokenPayload | null {
  return verifyToken<TrackingTokenPayload>(token, trackingSecret(config));
}

const URL_REGEX = /https?:\/\/[^\s<>"]+/g;
/** TipTap / email-builder bodies are HTML; plain templates usually are not. */
const HTML_BODY_RE = /<\/?[a-z][\s\S]*>/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function looksLikeHtml(body: string): boolean {
  return HTML_BODY_RE.test(body.trim());
}

/** Strip tags for the multipart text/plain part (and Inbox fallbacks). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<\/(?:ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function rewriteHtmlHrefs(
  html: string,
  config: Env,
  enrollmentId: string,
  enrollmentStepId: string
): string {
  return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (_match, quote: string, url: string) => {
    const trackedUrl = buildClickUrl(config, enrollmentId, enrollmentStepId, url);
    return `href=${quote}${trackedUrl}${quote}`;
  });
}

function trackingPixel(config: Env, enrollmentId: string, enrollmentStepId: string): string {
  const pixelUrl = buildOpenPixelUrl(config, enrollmentId, enrollmentStepId);
  return `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none" />`;
}

/**
 * Builds tracked HTML + plain-text parts for a sequence email.
 * HTML bodies (from the email builder) are preserved; plain text is escaped and
 * converted to HTML. Bare URLs / hrefs get click tracking; an open pixel is appended.
 */
export function injectTracking(
  config: Env,
  body: string,
  enrollmentId: string,
  enrollmentStepId: string
): { html: string; text: string } {
  const pixel = trackingPixel(config, enrollmentId, enrollmentStepId);

  if (looksLikeHtml(body)) {
    const withTrackedLinks = rewriteHtmlHrefs(body, config, enrollmentId, enrollmentStepId);
    return {
      html: `${withTrackedLinks}${pixel}`,
      text: htmlToPlainText(body),
    };
  }

  const escaped = escapeHtml(body);
  const withLinks = escaped.replace(URL_REGEX, (url) => {
    const trackedUrl = buildClickUrl(config, enrollmentId, enrollmentStepId, url);
    return `<a href="${trackedUrl}">${url}</a>`;
  });
  const withBreaks = withLinks.replace(/\n/g, "<br>\n");

  return { html: `${withBreaks}${pixel}`, text: body };
}

export async function recordTrackingEvent(
  db: Db,
  params: {
    workspaceId: string;
    enrollmentId: string;
    enrollmentStepId: string;
    eventType: "open" | "click";
    url?: string;
    userAgent?: string;
    ipAddress?: string;
  }
): Promise<void> {
  await db.insert(sequenceTrackingEvents).values({
    workspaceId: params.workspaceId,
    enrollmentId: params.enrollmentId,
    enrollmentStepId: params.enrollmentStepId,
    eventType: params.eventType,
    url: params.url ?? null,
    userAgent: params.userAgent ?? null,
    ipAddress: params.ipAddress ?? null,
  });
}

/** 1x1 transparent GIF served by the open-tracking pixel route. */
export const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
  "base64"
);
