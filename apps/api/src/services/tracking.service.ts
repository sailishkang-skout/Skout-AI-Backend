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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Converts a plain-text rendered email body into a tracked HTML body: bare URLs become
 * click-tracked links, newlines become <br>, and an invisible open-tracking pixel is appended.
 */
export function injectTracking(
  config: Env,
  plainText: string,
  enrollmentId: string,
  enrollmentStepId: string
): { html: string; text: string } {
  const escaped = escapeHtml(plainText);
  const withLinks = escaped.replace(URL_REGEX, (url) => {
    const trackedUrl = buildClickUrl(config, enrollmentId, enrollmentStepId, url);
    return `<a href="${trackedUrl}">${url}</a>`;
  });
  const withBreaks = withLinks.replace(/\n/g, "<br>\n");
  const pixelUrl = buildOpenPixelUrl(config, enrollmentId, enrollmentStepId);
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none" />`;

  return { html: `${withBreaks}${pixel}`, text: plainText };
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
