import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { MeetingCreateInput, MeetingUpdateInput } from "@skout/shared";
import type { ActivitiesService } from "./activities.service.js";
import { serviceLog } from "../lib/obs.js";

const log = serviceLog("meetings");
const { meetings } = schema;

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
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof meetings.$inferSelect): MeetingDto {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class MeetingsService {
  constructor(
    private readonly db: Db,
    private readonly activitiesService: ActivitiesService
  ) {}

  async list(
    workspaceId: string,
    options: { limit: number; offset: number; dealId?: string; contactId?: string; companyId?: string }
  ): Promise<{ data: MeetingDto[]; total: number }> {
    const conditions = [eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt)];
    if (options.dealId) conditions.push(eq(meetings.dealId, options.dealId));
    if (options.contactId) conditions.push(eq(meetings.contactId, options.contactId));
    if (options.companyId) conditions.push(eq(meetings.companyId, options.companyId));

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

    return { data: rows.map(toDto), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<MeetingDto | null> {
    const [row] = await this.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  async create(workspaceId: string, organizerId: string | undefined, input: MeetingCreateInput): Promise<MeetingDto> {
    const [row] = await this.db
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
      })
      .returning();

    const dto = toDto(row);
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
        updatedAt: new Date(),
      })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, workspaceId)))
      .returning();
    if (row) log.info("meeting updated", { workspaceId, meetingId: id });
    return row ? toDto(row) : null;
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

  /** Count of future meetings for the dashboard overview. */
  async upcomingCount(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt), gt(meetings.scheduledAt, new Date())));
    return rows.length;
  }
}

export function buildMeetingsService(db: Db | null, activitiesService: ActivitiesService | null): MeetingsService | null {
  return db && activitiesService ? new MeetingsService(db, activitiesService) : null;
}
