import { serviceLog } from "../lib/obs.js";

const log = serviceLog("google-calendar");

export interface CalendarEventAttendee {
  email: string;
  displayName?: string;
}

export interface CreateCalendarEventInput {
  title: string;
  scheduledAt: Date;
  durationMinutes: number | null;
  attendees: CalendarEventAttendee[];
  /** Set when the meeting already has a googleEventId — patches that event in place instead
   * of creating a duplicate. See createCalendarEvent's doc comment for why this matters. */
  existingEventId?: string;
}

export interface CreateCalendarEventResult {
  googleEventId: string;
  googleCalendarId: string;
  hangoutLink: string;
}

/*
==================================================
CREATE (OR UPDATE) A REAL GOOGLE MEET MEETING
==================================================

One REST call to the connected user's primary
calendar: conferenceData.createRequest generates a
real Google Meet link (no separate "create a Meet"
step exists in the API — it's a side effect of
creating the event this way), and sendUpdates=all
makes Google email every attendee its own native
invite — no invite-email system needs to be built
here.

When `existingEventId` is set (the meeting was already
scheduled on Google once), this PATCHes that event
instead of POSTing a new one — the caller uses this to
re-sync attendees on every save without creating a
second, orphaned event and a second, different Meet
link every time someone edits the meeting.
conferenceData is deliberately omitted from the PATCH
body: requesting a new conferenceData.createRequest on
update would mint a *different* Meet link and silently
invalidate the one already shared/joined by attendees.
==================================================
*/

export async function createCalendarEvent(
  accessToken: string,
  input: CreateCalendarEventInput
): Promise<CreateCalendarEventResult> {
  const start = input.scheduledAt;
  const end = new Date(start.getTime() + (input.durationMinutes ?? 30) * 60_000);
  const isUpdate = Boolean(input.existingEventId);

  const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const url = isUpdate
    ? `${base}/${input.existingEventId}?sendUpdates=all&conferenceDataVersion=1`
    : `${base}?sendUpdates=all&conferenceDataVersion=1`;

  const body: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.displayName })),
  };
  if (!isUpdate) {
    body.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const res = await fetch(url, {
    method: isUpdate ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    hangoutLink?: string;
    error?: { message?: string };
  };

  if (!res.ok || !json.id || !json.hangoutLink) {
    log.warn(`Google Calendar event ${isUpdate ? "update" : "creation"} failed`, { status: res.status, body: json });
    throw new Error(json.error?.message ?? `Google Calendar returned ${res.status}`);
  }

  return { googleEventId: json.id, googleCalendarId: "primary", hangoutLink: json.hangoutLink };
}

export interface CalendarEventSummary {
  googleEventId: string;
  title: string;
  start: string;
  end: string;
  hangoutLink: string | null;
  htmlLink: string | null;
  /** true when this event's own attendee list includes the connected account — Google's feed
   * includes events the user only organizes vs. was invited to; both render the same here. */
  organizerSelf: boolean;
}

interface GoogleEventsListResponse {
  items?: {
    id: string;
    summary?: string;
    status?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    hangoutLink?: string;
    htmlLink?: string;
    organizer?: { self?: boolean };
  }[];
  error?: { message?: string };
}

/**
 * R16.4 — "show everything on the connected Google Calendar, not just meetings created in
 * Skout." Read-only: this is a display merge on the frontend calendar view, not a sync — it
 * does not write anything back or create `meetings` rows for these. `singleEvents=true`
 * expands recurring events into individual instances (otherwise a weekly standup would come
 * back as one row with an RRULE, useless for a day-grid).
 */
export async function listCalendarEvents(
  accessToken: string,
  range: { timeMin: Date; timeMax: Date }
): Promise<CalendarEventSummary[]> {
  const params = new URLSearchParams({
    timeMin: range.timeMin.toISOString(),
    timeMax: range.timeMax.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const json = (await res.json().catch(() => ({}))) as GoogleEventsListResponse;
  if (!res.ok) {
    log.warn("Google Calendar events list failed", { status: res.status, body: json });
    throw new Error(json.error?.message ?? `Google Calendar returned ${res.status}`);
  }

  return (json.items ?? [])
    .filter((item) => item.status !== "cancelled" && (item.start?.dateTime || item.start?.date))
    .map((item) => ({
      googleEventId: item.id,
      title: item.summary?.trim() || "(No title)",
      // All-day events only carry `date` (no time component) — fall back to that so the event
      // still shows on the right day instead of being dropped.
      start: item.start?.dateTime ?? item.start?.date ?? "",
      end: item.end?.dateTime ?? item.end?.date ?? "",
      hangoutLink: item.hangoutLink ?? null,
      htmlLink: item.htmlLink ?? null,
      organizerSelf: item.organizer?.self ?? false,
    }));
}
