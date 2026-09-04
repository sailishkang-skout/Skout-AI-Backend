import { randomUUID } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull, lte } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { MeetingCreateInput, MeetingInvitee, MeetingUpdateInput } from "@skout/shared";
import type { ActivitiesService } from "./activities.service.js";
import { serviceLog } from "../lib/obs.js";
import { generateMeetingIcs } from "./ics-generator.service.js";
import { sendMeetingInviteEmail } from "./meeting-invite-mail.service.js";
import { emitSkoutEvent } from "./skout-event.service.js";
import type { Env } from "../config/env.js";

const log = serviceLog("meetings");
const { meetings, meetingAttendees, workspaces } = schema;

export interface MeetingAttendeeDto {
  email: string;
  name: string | null;
  rsvpStatus: string;
  respondedAt: string | null;
}

export interface MeetingDto {
  id: string;
  workspaceId: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  organizerId: string | null;
  title: string;
  scheduledAt: string;
  durationMinutes: number | null;
  meetingType: string;
  summary: string | null;
  outcome: string | null;
  meetingUrl: string | null;
  botExternalId: string | null;
  botStatus: string;
  /** R16.2 — opt-in auto-join; when true the meeting-auto-join worker schedules the bot on its own. */
  autoJoinBot: boolean;
  recordingUrl: string | null;
  transcriptUrl: string | null;
  transcript: string | null;
  invitees: MeetingInvitee[];
  /** Per-invitee RSVP status tracked via the .ics reply webhook — isolated from `invitees` (the create-time input/Google-sync list). Empty when this meeting has no ICS attendees. */
  attendees: MeetingAttendeeDto[];
  googleEventId: string | null;
  icsUid: string | null;
  icsSequence: number;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof meetings.$inferSelect, attendees: MeetingAttendeeDto[] = []): MeetingDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    contactId: row.contactId,
    companyId: row.companyId,
    dealId: row.dealId,
    organizerId: row.organizerId,
    title: row.title,
    scheduledAt: row.scheduledAt.toISOString(),
    durationMinutes: row.durationMinutes,
    meetingType: row.meetingType,
    summary: row.summary,
    outcome: row.outcome,
    meetingUrl: row.meetingUrl,
    botExternalId: row.botExternalId,
    botStatus: row.botStatus,
    autoJoinBot: row.autoJoinBot,
    recordingUrl: row.recordingUrl,
    transcriptUrl: row.transcriptUrl,
    transcript: row.transcript,
    invitees: (row.invitees ?? []) as MeetingInvitee[],
    attendees,
    googleEventId: row.googleEventId,
    icsUid: row.icsUid,
    icsSequence: row.icsSequence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class MeetingsService {
  constructor(
    private readonly db: Db,
    private readonly activitiesService: ActivitiesService,
    private readonly config?: Env
  ) {}

  /**
   * Sends a .ics invite to each attendee, best-effort — a failed send is logged but never
   * throws, since a bounced invite email shouldn't fail meeting creation/cancellation.
   */
  private async sendInvites(
    dto: MeetingDto,
    attendeeEmails: string[],
    method: "REQUEST" | "CANCEL"
  ): Promise<void> {
    if (!this.config || attendeeEmails.length === 0 || !dto.icsUid) return;

    const { icsContent } = generateMeetingIcs(
      {
        icsUid: dto.icsUid,
        icsSequence: dto.icsSequence,
        title: dto.title,
        scheduledAt: dto.scheduledAt,
        durationMinutes: dto.durationMinutes,
        method,
        // RFC 5545 §3.6.1 requires ORGANIZER on a METHOD:REQUEST — without it, calendar clients
        // have no address to send the METHOD:REPLY RSVP to.
        organizerEmail: this.config.MEETING_INVITE_FROM_ADDRESS,
      },
      attendeeEmails.map((email) => ({ email }))
    );

    for (const email of attendeeEmails) {
      try {
        await sendMeetingInviteEmail(this.config, {
          to: email,
          subject: method === "CANCEL" ? `Cancelled: ${dto.title}` : `Invite: ${dto.title}`,
          text:
            method === "CANCEL"
              ? "This meeting has been cancelled. See the attached calendar update."
              : "See the attached calendar invite.",
          icsContent,
          method,
        });
      } catch (err) {
        log.warn("meeting invite email failed", { meetingId: dto.id, email, err: (err as Error).message });
      }
    }
  }

  /** Batch-fetches meeting_attendees for a set of meetings and groups them by meetingId, merging
   *  in the invitee's display name from that meeting's `invitees` JSON (the attendees table only
   *  stores email + RSVP state). */
  private async attendeesFor(rows: (typeof meetings.$inferSelect)[]): Promise<Map<string, MeetingAttendeeDto[]>> {
    const ids = rows.map((r) => r.id);
    const byMeeting = new Map<string, MeetingAttendeeDto[]>();
    if (ids.length === 0) return byMeeting;

    const attendeeRows = await this.db
      .select()
      .from(meetingAttendees)
      .where(inArray(meetingAttendees.meetingId, ids));
    if (attendeeRows.length === 0) return byMeeting;

    const namesByMeeting = new Map<string, Map<string, string | undefined>>(
      rows.map((r) => [r.id, new Map(((r.invitees ?? []) as MeetingInvitee[]).map((i) => [i.email.toLowerCase(), i.name]))])
    );

    for (const a of attendeeRows) {
      const dto: MeetingAttendeeDto = {
        email: a.email,
        name: namesByMeeting.get(a.meetingId)?.get(a.email.toLowerCase()) ?? null,
        rsvpStatus: a.rsvpStatus,
        respondedAt: a.respondedAt ? a.respondedAt.toISOString() : null,
      };
      const list = byMeeting.get(a.meetingId);
      if (list) list.push(dto);
      else byMeeting.set(a.meetingId, [dto]);
    }
    return byMeeting;
  }

  async list(
    workspaceId: string,
    options: {
      limit: number;
      offset: number;
      dealId?: string;
      contactId?: string;
      companyId?: string;
      /** Calendar view — inclusive range on scheduledAt. */
      from?: string;
      to?: string;
    }
  ): Promise<{ data: MeetingDto[]; total: number }> {
    const conditions = [eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt)];
    if (options.dealId) conditions.push(eq(meetings.dealId, options.dealId));
    if (options.contactId) conditions.push(eq(meetings.contactId, options.contactId));
    if (options.companyId) conditions.push(eq(meetings.companyId, options.companyId));
    if (options.from) conditions.push(gte(meetings.scheduledAt, new Date(options.from)));
    if (options.to) conditions.push(lte(meetings.scheduledAt, new Date(options.to)));

    const rows = await this.db
      .select()
      .from(meetings)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(...conditions));

    const attendeesByMeeting = await this.attendeesFor(rows);
    return { data: rows.map((r) => toDto(r, attendeesByMeeting.get(r.id) ?? [])), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<MeetingDto | null> {
    const [row] = await this.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt)))
      .limit(1);
    if (!row) return null;
    const attendeesByMeeting = await this.attendeesFor([row]);
    return toDto(row, attendeesByMeeting.get(row.id) ?? []);
  }

  /** R16.2 — resolves the effective auto-join flag: an explicit per-meeting value always wins;
   * otherwise inherit the workspace default. */
  private async resolveAutoJoinBot(workspaceId: string, explicit: boolean | undefined): Promise<boolean> {
    if (explicit !== undefined) return explicit;
    const [ws] = await this.db
      .select({ meetingBotAutoJoinDefault: workspaces.meetingBotAutoJoinDefault })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return ws?.meetingBotAutoJoinDefault ?? false;
  }

  async create(workspaceId: string, organizerId: string | undefined, input: MeetingCreateInput): Promise<MeetingDto> {
    const autoJoinBot = await this.resolveAutoJoinBot(workspaceId, input.autoJoinBot);
    // Dedupe case-insensitively — meetingAttendees has a unique(meetingId, email) constraint,
    // and the create schema doesn't guarantee callers send distinct addresses. sendIcsInvites
    // defaults true but is skippable when the caller plans to invite via /schedule-google
    // instead — sending both would double-invite the same people through two channels.
    const shouldSendIcsInvites = input.sendIcsInvites ?? true;
    const attendeeEmails =
      input.invitees?.length && shouldSendIcsInvites
        ? [...new Map(input.invitees.map((i) => [i.email.toLowerCase(), i.email])).values()]
        : [];
    const icsUid = attendeeEmails.length ? `${randomUUID()}@meetings.skout.ai` : null;

    const dto = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(meetings)
        .values({
          workspaceId,
          contactId: input.contactId,
          companyId: input.companyId,
          dealId: input.dealId,
          organizerId: input.organizerId ?? organizerId,
          title: input.title,
          scheduledAt: new Date(input.scheduledAt),
          durationMinutes: input.durationMinutes,
          meetingType: input.meetingType,
          summary: input.summary,
          outcome: input.outcome,
          meetingUrl: input.meetingUrl,
          autoJoinBot,
          ...(input.invitees ? { invitees: input.invitees } : {}),
          ...(icsUid ? { icsUid } : {}),
        })
        .returning();

      if (attendeeEmails.length) {
        await tx
          .insert(meetingAttendees)
          .values(attendeeEmails.map((email) => ({ meetingId: row.id, email })))
          .onConflictDoNothing({ target: [meetingAttendees.meetingId, meetingAttendees.email] });
      }

      const namesByEmail = new Map((input.invitees ?? []).map((i) => [i.email.toLowerCase(), i.name]));
      const attendees: MeetingAttendeeDto[] = attendeeEmails.map((email) => ({
        email,
        name: namesByEmail.get(email.toLowerCase()) ?? null,
        rsvpStatus: "needs-action",
        respondedAt: null,
      }));
      return toDto(row, attendees);
    });

    if (attendeeEmails.length) {
      await this.sendInvites(dto, attendeeEmails, "REQUEST");
    }

    // Log on the timeline of whichever entity is linked — deal takes priority as the
    // most specific record, matching how deals.service.ts logs stage-change activity.
    if (dto.dealId) {
      await this.activitiesService.record(workspaceId, dto.organizerId ?? undefined, "deal", dto.dealId, "meeting", dto.title, dto.summary ?? undefined);
    } else if (dto.contactId) {
      await this.activitiesService.record(workspaceId, dto.organizerId ?? undefined, "contact", dto.contactId, "meeting", dto.title, dto.summary ?? undefined);
    } else if (dto.companyId) {
      await this.activitiesService.record(workspaceId, dto.organizerId ?? undefined, "company", dto.companyId, "meeting", dto.title, dto.summary ?? undefined);
    }

    log.info("meeting created", { workspaceId, meetingId: dto.id, dealId: dto.dealId });
    return dto;
  }

  /** Soft-deletes the meeting and, if it has ICS attendees, sends METHOD:CANCEL with an incremented sequence. */
  async cancel(workspaceId: string, id: string): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    const attendeeRows = await this.db
      .select({ email: meetingAttendees.email })
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, id));

    const nextSequence = existing.icsSequence + 1;
    const [row] = await this.db
      .update(meetings)
      .set({ deletedAt: new Date(), icsSequence: nextSequence, updatedAt: new Date() })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId)))
      .returning();
    if (!row) return false;

    if (attendeeRows.length > 0) {
      const dto = toDto(row);
      await this.sendInvites(dto, attendeeRows.map((a) => a.email), "CANCEL");
    }

    log.info("meeting cancelled", { workspaceId, meetingId: id });
    return true;
  }

  async update(workspaceId: string, id: string, input: MeetingUpdateInput): Promise<MeetingDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const [row] = await this.db
      .update(meetings)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: new Date(input.scheduledAt) } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.meetingType !== undefined ? { meetingType: input.meetingType } : {}),
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
        ...(input.dealId !== undefined ? { dealId: input.dealId } : {}),
        ...(input.organizerId !== undefined ? { organizerId: input.organizerId } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.meetingUrl !== undefined ? { meetingUrl: input.meetingUrl } : {}),
        ...(input.autoJoinBot !== undefined ? { autoJoinBot: input.autoJoinBot } : {}),
        ...(input.invitees !== undefined ? { invitees: input.invitees } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId)))
      .returning();
    if (row) log.info("meeting updated", { workspaceId, meetingId: id });
    const dto = row ? toDto(row) : null;

    // §7.3 — event-spine trigger: a meeting outcome being recorded is what "meeting.completed"
    // means here, not any other field on the meeting changing.
    if (dto && this.config && input.outcome !== undefined) {
      await emitSkoutEvent(this.config, {
        type: "meeting.completed",
        tenantId: workspaceId,
        aggregateId: id,
        data: {
          workspaceId,
          meetingId: id,
          outcome: dto.outcome,
          contactId: dto.contactId,
          companyId: dto.companyId,
          dealId: dto.dealId,
        },
      }).catch((err: unknown) => log.warn("failed to emit meeting.completed", { err, workspaceId, meetingId: id }));
    }

    return dto;
  }

  async softDelete(workspaceId: string, id: string): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    await this.db
      .update(meetings)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId)));
    log.info("meeting soft-deleted", { workspaceId, meetingId: id });
    return true;
  }

  /** R16.2 — record that a bot has been scheduled for this meeting. */
  async setBotScheduled(workspaceId: string, id: string, botExternalId: string): Promise<MeetingDto | null> {
    const [row] = await this.db
      .update(meetings)
      .set({ botExternalId, botStatus: "scheduled", updatedAt: new Date() })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId)))
      .returning();
    return row ? toDto(row) : null;
  }

  /**
   * Records a created Google Calendar event: the real Meet link lands in the same meetingUrl
   * column R16.2's "Schedule bot" already reads, so scheduling a notetaker on a Google-created
   * meeting needs no changes there.
   */
  async setGoogleEvent(
    workspaceId: string,
    id: string,
    update: { meetingUrl: string; googleEventId: string; googleCalendarId: string; invitees: MeetingInvitee[] }
  ): Promise<MeetingDto | null> {
    const [row] = await this.db
      .update(meetings)
      .set({
        meetingUrl: update.meetingUrl,
        googleEventId: update.googleEventId,
        googleCalendarId: update.googleCalendarId,
        invitees: update.invitees,
        updatedAt: new Date(),
      })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId)))
      .returning();
    if (row) log.info("google calendar event scheduled", { workspaceId, meetingId: id });
    return row ? toDto(row) : null;
  }

  /** R16.2 — webhook correlates by the vendor's bot id, not our own meeting id. */
  async findByBotExternalId(botExternalId: string) {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.botExternalId, botExternalId)).limit(1);
    return row ?? null;
  }

  /** R16.2/R16.3 — apply a webhook update (status + transcript/recording + optional summary). */
  async applyWebhookUpdate(
    id: string,
    update: {
      botStatus?: string;
      transcript?: string;
      transcriptUrl?: string;
      recordingUrl?: string;
      summary?: string;
    }
  ): Promise<MeetingDto | null> {
    const [row] = await this.db
      .update(meetings)
      .set({
        ...(update.botStatus !== undefined ? { botStatus: update.botStatus } : {}),
        ...(update.transcript !== undefined ? { transcript: update.transcript } : {}),
        ...(update.transcriptUrl !== undefined ? { transcriptUrl: update.transcriptUrl } : {}),
        ...(update.recordingUrl !== undefined ? { recordingUrl: update.recordingUrl } : {}),
        ...(update.summary !== undefined ? { summary: update.summary } : {}),
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, id))
      .returning();
    return row ? toDto(row) : null;
  }

  /**
   * R16.2/R16.3 AC — post the transcript summary + action items + LLM-extracted next steps and
   * stakeholders to the CRM activity timeline (not just the `meetings` row's own summary
   * column), so it shows up alongside every other interaction on the contact/company/deal.
   * `nextSteps`/`stakeholders` aren't scalar CRM fields, so unlike the typed contact/company/deal
   * fields they're never auto-filled onto a record — this timeline post is where they live.
   * Same entity-priority as create() above.
   */
  async recordTranscriptActivity(
    workspaceId: string,
    meeting: MeetingDto,
    summary: string | undefined,
    actionItems: string[] | undefined,
    nextSteps?: string,
    stakeholders?: string[]
  ): Promise<void> {
    const hasContent =
      Boolean(summary) || (actionItems && actionItems.length > 0) || Boolean(nextSteps) || (stakeholders && stakeholders.length > 0);
    if (!hasContent) return;

    const bodyLines: string[] = [];
    if (summary) bodyLines.push(summary);
    if (nextSteps) bodyLines.push("", "Next steps:", nextSteps);
    if (actionItems && actionItems.length > 0) {
      bodyLines.push("", "Action items:", ...actionItems.map((item) => `- ${item}`));
    }
    if (stakeholders && stakeholders.length > 0) {
      bodyLines.push("", "Stakeholders:", ...stakeholders.map((s) => `- ${s}`));
    }
    const body = bodyLines.join("\n");
    const subject = `Meeting transcript ready: ${meeting.title}`;

    if (meeting.dealId) {
      await this.activitiesService.record(workspaceId, meeting.organizerId ?? undefined, "deal", meeting.dealId, "meeting", subject, body);
    } else if (meeting.contactId) {
      await this.activitiesService.record(workspaceId, meeting.organizerId ?? undefined, "contact", meeting.contactId, "meeting", subject, body);
    } else if (meeting.companyId) {
      await this.activitiesService.record(workspaceId, meeting.organizerId ?? undefined, "company", meeting.companyId, "meeting", subject, body);
    }
  }

  /** Count of future meetings for the dashboard overview. */
  async upcomingCount(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt), gt(meetings.scheduledAt, new Date())));
    return rows.length;
  }
}

export function buildMeetingsService(
  db: Db | null,
  activitiesService: ActivitiesService | null,
  config?: Env
): MeetingsService | null {
  return db && activitiesService ? new MeetingsService(db, activitiesService, config) : null;
}
