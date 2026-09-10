import { createEvent, type EventAttributes } from "ics";

export interface MeetingIcsInput {
  icsUid: string;
  icsSequence: number;
  title: string;
  scheduledAt: string;
  durationMinutes: number | null;
  method: "REQUEST" | "CANCEL";
  organizerEmail?: string;
  organizerName?: string;
}

export interface MeetingIcsAttendee {
  email: string;
}

function toIcsDateArray(iso: string): [number, number, number, number, number] {
  const d = new Date(iso);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
}

/** Generates an RFC 5545 .ics payload for a meeting invite or cancellation. */
export function generateMeetingIcs(
  meeting: MeetingIcsInput,
  attendees: MeetingIcsAttendee[]
): { icsContent: string } {
  const event: EventAttributes = {
    uid: meeting.icsUid,
    sequence: meeting.icsSequence,
    start: toIcsDateArray(meeting.scheduledAt),
    duration: { minutes: meeting.durationMinutes ?? 30 },
    title: meeting.title,
    status: meeting.method === "CANCEL" ? "CANCELLED" : "CONFIRMED",
    method: meeting.method,
    organizer: meeting.organizerEmail
      ? { name: meeting.organizerName, email: meeting.organizerEmail }
      : undefined,
    attendees: attendees.map((a) => ({ email: a.email, rsvp: true })),
  };

  const { error, value } = createEvent(event);
  if (error || !value) {
    throw new Error(`ics_generation_failed: ${error?.message ?? "unknown error"}`);
  }
  return { icsContent: value };
}
