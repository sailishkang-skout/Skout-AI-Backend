export interface CalendarEventSummary {
  googleEventId: string;
  title: string;
  start: string;
  end: string;
  hangoutLink: string | null;
  htmlLink: string | null;
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

interface GoogleCalendarListResponse {
  items?: { id?: string; selected?: boolean; accessRole?: string }[];
  error?: { message?: string };
}

/** All-day Google dates are `YYYY-MM-DD` (no timezone). Noon keeps them on that civil day in any offset. */
export function googleEventStartIso(start?: { dateTime?: string; date?: string }): string {
  if (start?.dateTime) return start.dateTime;
  if (start?.date) return `${start.date}T12:00:00`;
  return "";
}

export function googleEventEndIso(end?: { dateTime?: string; date?: string }): string {
  if (end?.dateTime) return end.dateTime;
  if (end?.date) return `${end.date}T12:00:00`;
  return "";
}

async function listVisibleCalendarIds(accessToken: string): Promise<string[]> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => ({}))) as GoogleCalendarListResponse;
  if (!res.ok) return ["primary"];

  const ids = (json.items ?? [])
    .filter((cal) => cal.id && cal.selected !== false)
    .map((cal) => cal.id as string);

  return ids.length > 0 ? ids : ["primary"];
}

async function listEventsForCalendar(
  accessToken: string,
  calendarId: string,
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
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const json = (await res.json().catch(() => ({}))) as GoogleEventsListResponse;
  if (!res.ok) {
    throw new Error(json.error?.message ?? `Google Calendar returned ${res.status} for ${calendarId}`);
  }

  return (json.items ?? [])
    .filter((item) => item.status !== "cancelled" && (item.start?.dateTime || item.start?.date))
    .map((item) => ({
      googleEventId: `${calendarId}:${item.id}`,
      title: item.summary?.trim() || "(No title)",
      start: googleEventStartIso(item.start),
      end: googleEventEndIso(item.end),
      hangoutLink: item.hangoutLink ?? null,
      htmlLink: item.htmlLink ?? null,
      organizerSelf: item.organizer?.self ?? false,
    }));
}

/**
 * Read-only display merge of everything on the connected Google account in range.
 * Tries every selected calendar (not just "primary") so work/shared calendars show up too.
 */
export async function listGoogleCalendarEvents(
  accessToken: string,
  range: { timeMin: Date; timeMax: Date }
): Promise<CalendarEventSummary[]> {
  const calendarIds = await listVisibleCalendarIds(accessToken);
  const results = await Promise.allSettled(
    calendarIds.map((id) => listEventsForCalendar(accessToken, id, range))
  );

  const events: CalendarEventSummary[] = [];
  const seen = new Set<string>();
  let lastError: Error | undefined;

  for (const result of results) {
    if (result.status === "rejected") {
      lastError = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      continue;
    }
    for (const event of result.value) {
      if (seen.has(event.googleEventId)) continue;
      seen.add(event.googleEventId);
      events.push(event);
    }
  }

  if (events.length === 0 && lastError && results.every((r) => r.status === "rejected")) {
    throw lastError;
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}
