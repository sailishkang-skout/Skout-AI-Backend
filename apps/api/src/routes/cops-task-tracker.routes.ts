import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { writeCopsAudit } from "../services/cops-platform.service.js";

/*
 * Work tracker for every Skout department, GitHub Projects / Jira style: projects with a key,
 * issues numbered per project (ENG-12), a board by status, comments and a history (audit_logs).
 * Every staff member who can open CustomerOps can use it (the ops:access guard runs first).
 *
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (work tracker additions).
 *   - Tables touched directly: companies (read only) - owned by apps/crm
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: an issue linked to a customer shows that customer's name in lists and boards.
 *   - Review date: revisit when apps/crm's internal API covers batched reads
 */

const { copsTrackerDepartmentMembers: deptMembers, copsTrackerDepartments: departments, copsTrackerProjects: projects, copsTrackerIssues: issues, copsTrackerComments: comments, users, companies, auditLogs, workspaceMembers } = schema;

const DEPARTMENTS = schema.TRACKER_DEPARTMENTS;
const STATUSES = schema.TRACKER_STATUSES;
const PRIORITIES = schema.TRACKER_PRIORITIES;
const TYPES = schema.TRACKER_TYPES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const projectCreate = z
  .object({
    key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, "2 to 10 letters or digits, starting with a letter (ENG, SALES)"),
    name: z.string().trim().min(2).max(80),
    department: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "Pick a department"),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
const projectPatch = z
  .object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(2000).nullable().optional(), archived: z.boolean().optional() })
  .strict();
const issueFields = {
  title: z.string().trim().min(2).max(200),
  description: z.string().max(20000).nullable(),
  type: z.enum(TYPES),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  assignee_id: z.string().uuid().nullable(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10),
  due_date: z.string().date().nullable(),
  account_id: z.string().uuid().nullable(),
  parent_id: z.string().uuid().nullable(),
  position: z.number().finite(),
};
const issueCreate = z
  .object({ project_id: z.string().uuid(), ...issueFields })
  .partial()
  .required({ project_id: true, title: true })
  .strict();
const issuePatch = z.object(issueFields).partial().strict();
const listQuery = z.object({
  project_id: z.string().uuid().optional(),
  department: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignee_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
  label: z.string().trim().max(30).optional(),
  q: z.string().trim().max(100).optional(),
  mine: z.enum(["true", "false"]).optional(),
  include_done: z.enum(["true", "false"]).optional(),
});

type Reply = FastifyReply;

export async function copsTaskTrackerRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });
  const fail = (reply: Reply, requestId: string, code: "VALIDATION_FAILED" | "NOT_FOUND" | "FORBIDDEN" | "BUSINESS_STATE_CONFLICT", message: string, details: Record<string, unknown> = {}) =>
    reply.status(code === "NOT_FOUND" ? 404 : copsErrorStatus(code)).send(copsErrorBody({ code, message, requestId, details }));
  const invalid = (reply: Reply, requestId: string, error: z.ZodError) =>
    fail(reply, requestId, "VALIDATION_FAILED", error.issues[0]?.message ?? "Invalid request", {
      fields: error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })),
    });
  const audit = (ctx: ReturnType<typeof ctxOf>, entityType: "tracker_issue" | "tracker_project" | "tracker_department", entityId: string, action: string, before: unknown, after: unknown) =>
    writeCopsAudit(db, { tenantId: ctx.workspaceId, actor: { type: "user", id: ctx.userId }, entityType, entityId, action, before, after, correlationId: ctx.requestId, sourceChannel: "web" });

  /** A user must be a member of this workspace to be assigned. */
  const isMember = async (workspaceId: string, userId: string) =>
    !!(await db.select({ u: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1))[0];

  const issueRows = async (workspaceId: string, where: SQL[]) => {
    const rows = await db
      .select({ i: issues, projectKey: projects.key, projectName: projects.name, department: projects.department, accountName: companies.name })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(companies, eq(companies.id, issues.accountId))
      .where(and(eq(issues.workspaceId, workspaceId), ...where))
      .orderBy(asc(issues.status), asc(issues.position), desc(issues.updatedAt))
      .limit(500);
    const ids = [...new Set(rows.flatMap((r) => [r.i.assigneeId, r.i.reporterId]).filter((x): x is string => !!x))];
    const people = ids.length ? await db.select({ id: users.id, name: users.fullName, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    const who = (id: string | null) => {
      const p = id ? people.find((x) => x.id === id) : undefined;
      return p ? { id: p.id, name: p.name?.trim() || p.email } : null;
    };
    return rows.map(({ i, ...r }) => ({
      id: i.id,
      key: `${r.projectKey}-${i.number}`,
      number: i.number,
      project: { id: i.projectId, key: r.projectKey, name: r.projectName, department: r.department },
      title: i.title,
      description: i.description,
      type: i.type,
      status: i.status,
      priority: i.priority,
      assignee: who(i.assigneeId),
      reporter: who(i.reporterId),
      labels: i.labels,
      due_date: i.dueDate,
      account: i.accountId ? { id: i.accountId, name: r.accountName } : null,
      parent_id: i.parentId,
      position: i.position,
      completed_at: i.completedAt?.toISOString() ?? null,
      created_at: i.createdAt.toISOString(),
      updated_at: i.updatedAt.toISOString(),
    }));
  };
  const oneIssue = async (workspaceId: string, id: string) => (await issueRows(workspaceId, [eq(issues.id, id)]))[0];

  // ---- Projects ----
  app.get("/tracker/projects", async (request) => {
    const ctx = ctxOf(request);
    const rows = await db
      .select({
        p: projects,
        open: sql<number>`(select count(*)::int from cops_tracker_issues i where i.project_id = "cops_tracker_projects"."id" and i.status <> 'done')`,
      })
      .from(projects)
      .where(and(eq(projects.workspaceId, ctx.workspaceId), isNull(projects.archivedAt)))
      .orderBy(asc(projects.department), asc(projects.key));
    return { data: rows.map(({ p, open }) => ({ id: p.id, key: p.key, name: p.name, department: p.department, description: p.description, open_issues: open, created_at: p.createdAt.toISOString() })) };
  });

  // ---- Departments: the built-in ones plus any this workspace added ----
  const departmentList = async (workspaceId: string) => {
    const custom = await db.select().from(departments).where(eq(departments.workspaceId, workspaceId)).orderBy(asc(departments.name));
    const members = await db
      .select({ department: deptMembers.department, id: users.id, name: users.fullName, email: users.email })
      .from(deptMembers)
      .innerJoin(users, eq(users.id, deptMembers.userId))
      .where(eq(deptMembers.workspaceId, workspaceId));
    const people = (key: string) => members.filter((m) => m.department === key).map((m) => ({ id: m.id, name: m.name ?? m.email }));
    return [
      ...DEPARTMENTS.map((key) => ({ key, name: schema.TRACKER_DEPARTMENT_LABELS[key] ?? key, custom: false, members: people(key) })),
      ...custom.map((d) => ({ key: d.key, name: d.name, custom: true, members: people(d.key) })),
    ];
  };
  // Replace who is in a department. Only people in this workspace can be added.
  app.put<{ Params: { key: string } }>("/tracker/departments/:key/members", async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = z.object({ user_ids: z.array(z.string().regex(UUID)).max(200) }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const key = request.params.key;
    const list = await departmentList(ctx.workspaceId);
    const dept = list.find((d) => d.key === key);
    if (!dept) return fail(reply, ctx.requestId, "NOT_FOUND", "Department not found");
    const ids = [...new Set(parsed.data.user_ids)];
    if (ids.length) {
      const ok = await db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), inArray(workspaceMembers.userId, ids)));
      if (ok.length !== ids.length) return fail(reply, ctx.requestId, "VALIDATION_FAILED", "Everyone must be a member of this workspace", { field: "user_ids" });
    }
    const before = dept.members.map((m) => m.id);
    await db.transaction(async (tx) => {
      await tx.delete(deptMembers).where(and(eq(deptMembers.workspaceId, ctx.workspaceId), eq(deptMembers.department, key)));
      if (ids.length) await tx.insert(deptMembers).values(ids.map((userId) => ({ workspaceId: ctx.workspaceId, department: key, userId })));
    });
    await audit(ctx, "tracker_department", ctx.workspaceId, "tracker_department.members_changed", { department: key, user_ids: before }, { department: key, user_ids: ids });
    return { data: (await departmentList(ctx.workspaceId)).find((d) => d.key === key) };
  });
  app.get("/tracker/departments", async (request) => ({ data: await departmentList(ctxOf(request).workspaceId) }));
  app.post("/tracker/departments", async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = z.object({ name: z.string().trim().min(2).max(40) }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const name = parsed.data.name;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(?=[0-9])/, "d_").slice(0, 40);
    if (key.length < 2) return fail(reply, ctx.requestId, "VALIDATION_FAILED", "Use at least two letters", { field: "name" });
    const existing = await departmentList(ctx.workspaceId);
    if (existing.some((d) => d.key === key || d.name.toLowerCase() === name.toLowerCase())) return fail(reply, ctx.requestId, "BUSINESS_STATE_CONFLICT", `${name} already exists`, { field: "name" });
    const [row] = await db.insert(departments).values({ workspaceId: ctx.workspaceId, key, name, createdBy: ctx.userId }).onConflictDoNothing().returning();
    if (!row) return fail(reply, ctx.requestId, "BUSINESS_STATE_CONFLICT", `${name} already exists`, { field: "name" });
    await audit(ctx, "tracker_department", row.id, "tracker_department.created", null, { key, name });
    return reply.status(201).send({ data: { key, name, custom: true, members: [] } });
  });

  app.post("/tracker/projects", async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = projectCreate.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const b = parsed.data;
    if (!(await departmentList(ctx.workspaceId)).some((d) => d.key === b.department)) return fail(reply, ctx.requestId, "VALIDATION_FAILED", "Unknown department", { field: "department" });
    const [row] = await db
      .insert(projects)
      .values({ workspaceId: ctx.workspaceId, key: b.key, name: b.name, department: b.department, description: b.description ?? null, createdBy: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (!row) return fail(reply, ctx.requestId, "BUSINESS_STATE_CONFLICT", `A project with key ${b.key} already exists`, { field: "key" });
    await audit(ctx, "tracker_project", row.id, "tracker_project.created", null, { key: row.key, name: row.name, department: row.department });
    return reply.status(201).send({ data: { id: row.id, key: row.key, name: row.name, department: row.department, description: row.description, open_issues: 0 } });
  });

  app.patch<{ Params: { id: string } }>("/tracker/projects/:id", async (request, reply) => {
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return fail(reply, ctx.requestId, "NOT_FOUND", "Project not found");
    const parsed = projectPatch.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const b = parsed.data;
    const [row] = await db
      .update(projects)
      .set({ ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}), ...(b.archived !== undefined ? { archivedAt: b.archived ? new Date() : null } : {}) })
      .where(and(eq(projects.id, request.params.id), eq(projects.workspaceId, ctx.workspaceId)))
      .returning();
    if (!row) return fail(reply, ctx.requestId, "NOT_FOUND", "Project not found");
    await audit(ctx, "tracker_project", row.id, "tracker_project.updated", null, b);
    return { data: { id: row.id, key: row.key, name: row.name, department: row.department, description: row.description, archived: !!row.archivedAt } };
  });

  // ---- Issues ----
  app.get<{ Querystring: Record<string, string> }>("/tracker/issues", async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = listQuery.safeParse(request.query ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const q = parsed.data;
    const where: SQL[] = [];
    if (q.project_id) where.push(eq(issues.projectId, q.project_id));
    if (q.department) where.push(eq(projects.department, q.department));
    if (q.status) where.push(eq(issues.status, q.status));
    else if (q.include_done !== "true") where.push(or(sql`${issues.status} <> 'done'`, sql`${issues.completedAt} > now() - interval '14 days'`)!);
    if (q.priority) where.push(eq(issues.priority, q.priority));
    if (q.assignee_id) where.push(eq(issues.assigneeId, q.assignee_id));
    if (q.mine === "true") where.push(eq(issues.assigneeId, ctx.userId));
    if (q.account_id) where.push(eq(issues.accountId, q.account_id));
    if (q.label) where.push(sql`${q.label} = any(${issues.labels})`);
    if (q.q) {
      const m = q.q.match(/^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/);
      where.push(m ? and(eq(projects.key, m[1]!.toUpperCase()), eq(issues.number, Number(m[2])))! : or(ilike(issues.title, `%${q.q}%`), ilike(issues.description, `%${q.q}%`))!);
    }
    return { data: await issueRows(ctx.workspaceId, where) };
  });

  app.post("/tracker/issues", async (request, reply) => {
    const ctx = ctxOf(request);
    const parsed = issueCreate.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const b = parsed.data;
    if (b.assignee_id && !(await isMember(ctx.workspaceId, b.assignee_id))) return fail(reply, ctx.requestId, "VALIDATION_FAILED", "Assign it to someone on the team", { field: "assignee_id" });
    const id = await db.transaction(async (tx) => {
      // Takes the project's next number atomically, so two people never get ENG-12 at once.
      const [p] = await tx
        .update(projects)
        .set({ nextNumber: sql`${projects.nextNumber} + 1` })
        .where(and(eq(projects.id, b.project_id), eq(projects.workspaceId, ctx.workspaceId), isNull(projects.archivedAt)))
        .returning({ number: sql<number>`${projects.nextNumber} - 1` });
      if (!p) return null;
      const status = b.status ?? "todo";
      const [top] = await tx.select({ pos: sql<number>`coalesce(min(${issues.position}), 0)` }).from(issues).where(and(eq(issues.projectId, b.project_id), eq(issues.status, status)));
      const [row] = await tx
        .insert(issues)
        .values({
          workspaceId: ctx.workspaceId,
          projectId: b.project_id,
          number: Number(p.number),
          title: b.title,
          description: b.description ?? null,
          type: b.type ?? "task",
          status,
          priority: b.priority ?? "medium",
          assigneeId: b.assignee_id ?? null,
          reporterId: ctx.userId,
          labels: b.labels ?? [],
          dueDate: b.due_date ?? null,
          accountId: b.account_id ?? null,
          parentId: b.parent_id ?? null,
          // New work goes to the top of its column.
          position: b.position ?? Number(top?.pos ?? 0) - 1,
          completedAt: status === "done" ? new Date() : null,
        })
        .returning({ id: issues.id });
      return row!.id;
    });
    if (!id) return fail(reply, ctx.requestId, "NOT_FOUND", "Project not found");
    const created = await oneIssue(ctx.workspaceId, id);
    await audit(ctx, "tracker_issue", id, "tracker_issue.created", null, { key: created!.key, title: created!.title, status: created!.status });
    return reply.status(201).send({ data: created });
  });

  app.get<{ Params: { id: string } }>("/tracker/issues/:id", async (request, reply) => {
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    const issue = await oneIssue(ctx.workspaceId, request.params.id);
    if (!issue) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    const [thread, history, children] = await Promise.all([
      db
        .select({ id: comments.id, body: comments.body, at: comments.createdAt, authorId: comments.authorId, name: users.fullName, email: users.email })
        .from(comments)
        .leftJoin(users, eq(users.id, comments.authorId))
        .where(and(eq(comments.issueId, issue.id), eq(comments.workspaceId, ctx.workspaceId)))
        .orderBy(asc(comments.createdAt)),
      db
        .select({ action: auditLogs.action, before: auditLogs.beforeState, after: auditLogs.afterState, at: auditLogs.createdAt, name: users.fullName, email: users.email })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorId))
        .where(and(eq(auditLogs.workspaceId, ctx.workspaceId), eq(auditLogs.entityType, "tracker_issue"), eq(auditLogs.entityId, issue.id)))
        .orderBy(desc(auditLogs.createdAt))
        .limit(50),
      issueRows(ctx.workspaceId, [eq(issues.parentId, issue.id)]),
    ]);
    return {
      data: {
        ...issue,
        comments: thread.map((c) => ({ id: c.id, body: c.body, author: c.authorId ? { id: c.authorId, name: c.name?.trim() || c.email } : null, created_at: c.at.toISOString() })),
        activity: history.map((h) => ({ action: h.action, before: h.before, after: h.after, by: h.name?.trim() || h.email || "System", at: h.at.toISOString() })),
        subtasks: children,
      },
    };
  });

  app.patch<{ Params: { id: string } }>("/tracker/issues/:id", async (request, reply) => {
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    const parsed = issuePatch.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const b = parsed.data;
    const before = await oneIssue(ctx.workspaceId, request.params.id);
    if (!before) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    if (b.assignee_id && !(await isMember(ctx.workspaceId, b.assignee_id))) return fail(reply, ctx.requestId, "VALIDATION_FAILED", "Assign it to someone on the team", { field: "assignee_id" });
    if (b.parent_id && b.parent_id === before.id) return fail(reply, ctx.requestId, "VALIDATION_FAILED", "An issue cannot be its own parent", { field: "parent_id" });
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (b.title !== undefined) set.title = b.title;
    if (b.description !== undefined) set.description = b.description;
    if (b.type !== undefined) set.type = b.type;
    if (b.priority !== undefined) set.priority = b.priority;
    if (b.assignee_id !== undefined) set.assigneeId = b.assignee_id;
    if (b.labels !== undefined) set.labels = b.labels;
    if (b.due_date !== undefined) set.dueDate = b.due_date;
    if (b.account_id !== undefined) set.accountId = b.account_id;
    if (b.parent_id !== undefined) set.parentId = b.parent_id;
    if (b.position !== undefined) set.position = b.position;
    if (b.status !== undefined) {
      set.status = b.status;
      if (b.status !== before.status) set.completedAt = b.status === "done" ? new Date() : null;
    }
    await db.update(issues).set(set).where(and(eq(issues.id, before.id), eq(issues.workspaceId, ctx.workspaceId)));
    // History keeps what changed, not board re-ordering.
    const changed = Object.keys(b).filter((k) => k !== "position");
    if (changed.length) {
      const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, k === "assignee_id" ? (o.assignee as { name?: string } | null)?.name ?? null : o[k]]));
      const after = await oneIssue(ctx.workspaceId, before.id);
      await audit(ctx, "tracker_issue", before.id, b.status && b.status !== before.status ? "tracker_issue.moved" : "tracker_issue.updated", pick(before as never), pick(after as never));
    }
    return { data: await oneIssue(ctx.workspaceId, before.id) };
  });

  app.delete<{ Params: { id: string } }>("/tracker/issues/:id", async (request, reply) => {
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    const issue = await oneIssue(ctx.workspaceId, request.params.id);
    if (!issue) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    // Whoever raised it, or a workspace Owner/Admin.
    const [me] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, ctx.userId))).limit(1);
    if (issue.reporter?.id !== ctx.userId && !["owner", "admin"].includes(me?.role ?? "")) return fail(reply, ctx.requestId, "FORBIDDEN", "Only whoever raised it, or an Owner or Admin, can delete it");
    await db.delete(issues).where(and(eq(issues.id, issue.id), eq(issues.workspaceId, ctx.workspaceId)));
    await audit(ctx, "tracker_issue", issue.id, "tracker_issue.deleted", { key: issue.key, title: issue.title }, null);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/tracker/issues/:id/comments", async (request, reply) => {
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    const parsed = z.object({ body: z.string().trim().min(1).max(10000) }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    const issue = await oneIssue(ctx.workspaceId, request.params.id);
    if (!issue) return fail(reply, ctx.requestId, "NOT_FOUND", "Issue not found");
    const [row] = await db.insert(comments).values({ workspaceId: ctx.workspaceId, issueId: issue.id, authorId: ctx.userId, body: parsed.data.body }).returning();
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    return reply.status(201).send({ data: { id: row!.id, body: row!.body, created_at: row!.createdAt.toISOString() } });
  });
}
