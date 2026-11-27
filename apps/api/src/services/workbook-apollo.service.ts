import type { CrmAccess, CrmConnectionStatus } from "./workbook-crm-access.js";
import { crmMessage, providerCode } from "./workbook-crm-access.js";
import { CrmSourceError, type CrmField } from "./crm-record-source.js";
import { WorkbookV2Error } from "./workbook-v2.service.js";

/**
 * What can be imported from a workspace's Apollo account (WB2-024). The preview and everything after it are the record
 * import's own (`workbook-crm.service.ts`), with Apollo's contact source.
 */
export interface ApolloChoices<T> {
  available: boolean;
  /** Why they can't be listed, when they can't. */
  reason: string | null;
  items: T[];
}

export interface ApolloSourceDto {
  connection: { status: CrmConnectionStatus };
  fields: Array<Pick<CrmField, "name" | "label">>;
  defaultFields: string[];
  /** Null until Apollo is connected. */
  lists: ApolloChoices<{ id: string; name: string; count: number | null }> | null;
  stages: ApolloChoices<{ id: string; name: string }> | null;
  note: string;
  maxRecords: number;
}

export async function describeApollo(access: CrmAccess, workspaceId: string): Promise<ApolloSourceDto> {
  const source = access.source("apollo")!;
  const status = await access.status(workspaceId, "apollo");
  const described: ApolloSourceDto = {
    connection: { status },
    fields: (await source.listFields("", "contact")).map(({ name, label }) => ({ name, label })),
    defaultFields: [...source.defaultFields("contact")],
    lists: null,
    stages: null,
    note: source.views.note,
    maxRecords: source.maxRecords!,
  };
  if (status !== "connected") return described;
  const refused = (failure: CrmSourceError["failure"]) => crmMessage("apollo", failure, access.label("apollo"));
  /** A key without access to one of these can still import by the other, or by keywords. */
  async function choices<T>(read: (key: string) => Promise<T[]>): Promise<ApolloChoices<T>> {
    try {
      const { accessToken } = await access.open(workspaceId, "apollo");
      return { available: true, reason: null, items: await read(accessToken) };
    } catch (error) {
      if (!(error instanceof CrmSourceError)) throw error;
      // A rejected key can read nothing at all.
      if (error.failure === "reauth") throw new WorkbookV2Error(providerCode("apollo", "CRM_RECONNECT_REQUIRED"), 409, refused("reauth"));
      return { available: false, reason: refused(error.failure), items: [] };
    }
  }
  const [lists, stages] = await Promise.all([choices((key) => source.listViews(key, "contact")), choices((key) => source.listStages!(key))]);
  return { ...described, lists, stages };
}
