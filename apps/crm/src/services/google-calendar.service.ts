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
}

export interface CreateCalendarEventResult {
  googleEventId: string;
  googleCalendarId: string;
  hangoutLink: string;
}

/*
==================================================
CREATE A REAL GOOGLE MEET MEETING
==================================================

One REST call to the connected user's primary
calendar: conferenceData.createRequest generates a
real Google Meet link (no separate "create a Meet"
step exists in the API — it's a side effect of
creating the event this way), and sendUpdates=all
makes Google email every attendee its own native
invite — no invite-email system needs to be built
here.
==================================================
*/

export async function createCalendarEvent(
  accessToken: string,
  input: CreateCalendarEventInput
): Promise<CreateCalendarEventResult> {
  const start = input.scheduledAt;
  const end = new Date(start.getTime() + (input.durationMinutes ?? 30) * 60_000);

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: input.title,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.displayName })),
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    }
  );

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    hangoutLink?: string;
    error?: { message?: string };
  };

  if (!res.ok || !json.id || !json.hangoutLink) {
    log.warn("Google Calendar event creation failed", { status: res.status, body: json });
    throw new Error(json.error?.message ?? `Google Calendar returned ${res.status}`);
  }

  return { googleEventId: json.id, googleCalendarId: "primary", hangoutLink: json.hangoutLink };
}
