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
