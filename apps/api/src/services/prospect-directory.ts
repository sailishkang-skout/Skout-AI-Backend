import {
  buildDemoCorpus,
  countProspects,
  filterDemoCorpus,
  getProspectsByIds,
  matchingProspectsAfter,
  matchingProspectsPage,
  prospectIdsStillMatching,
  runSmartListQuery,
  searchProspects,
  type ProspectDocument,
  type SearchFilters,
} from "@skout/opensearch";
import type { Env } from "../config/env.js";
import { osConfigFromEnv, resolveFiltersForSearch } from "./smart-list.service.js";

/**
 * The shared prospect index every workspace searches, as workbooks read it (WB2-021). Reading it costs nothing. Without
 * a search index, local development uses the same demo prospects Search shows; production uses nothing.
 */
export interface ProspectDirectory {
  /** False when there is no search index to read in production. */
  readonly available: boolean;
  /** Documents by id. An id the index does not have is absent. */
  byIds(ids: string[]): Promise<Map<string, ProspectDocument>>;
  /** One page of a smart list's matches, in a stable order. */
  page(filters: SearchFilters, page: number, pageSize: number): Promise<{ hits: ProspectDocument[]; total: number }>;
  count(filters: SearchFilters): Promise<number>;
  /** Every match's id in a stable order, in batches, at most `cap` of them. */
  matching(filters: SearchFilters, cap: number): AsyncGenerator<string[]>;
  /** Which of these ids match the filters. */
  matchingAmong(filters: SearchFilters, ids: string[]): Promise<Set<string>>;
}

/** The furthest result the index will page to by number. */
export const SEARCH_WINDOW = 10_000;
const BATCH = 1_000;
/** The most a filter set that must be post-processed is read (as Search does). */
const POST_PROCESS_CAP = 20_000;

const postProcessed = (filters: SearchFilters) => Boolean(filters.excludeDuplicates || (filters.maxPerCompany != null && filters.maxPerCompany > 0));
const byId = (docs: ProspectDocument[]) => new Map(docs.map((doc) => [doc.prospectId, doc]));

/** Local development's demo prospects, built once. */
const demo = new Map<number | undefined, ProspectDocument[]>();
function demoPeople(size?: number): ProspectDocument[] {
  let people = demo.get(size);
  if (!people) demo.set(size, (people = buildDemoCorpus(size)));
  return people;
}

export function prospectDirectory(config: Env): ProspectDirectory {
  const search = osConfigFromEnv(config);
  if (search) {
    const resolve = (filters: SearchFilters) => resolveFiltersForSearch(search, filters);
    return {
      available: true,
      byIds: async (ids) => byId(await getProspectsByIds(search, ids)),
      async page(filters, page, pageSize) {
        const resolved = await resolve(filters);
        return postProcessed(resolved) ? searchProspects(search, resolved, page, pageSize) : matchingProspectsPage(search, resolved, page, pageSize);
      },
      count: async (filters) => countProspects(search, await resolve(filters)),
      async *matching(filters, cap) {
        const resolved = await resolve(filters);
        if (postProcessed(resolved)) {
          const { hits } = await runSmartListQuery(search, resolved, Math.min(cap, POST_PROCESS_CAP));
          for (let i = 0; i < hits.length; i += BATCH) yield hits.slice(i, i + BATCH).map((h) => h.prospectId);
          return;
        }
        let after: unknown[] | null = null;
        let sent = 0;
        do {
          const found: Awaited<ReturnType<typeof matchingProspectsAfter>> = await matchingProspectsAfter(search, resolved, BATCH, after);
          const ids = found.hits.slice(0, cap - sent).map((h) => h.prospectId);
          if (ids.length) yield ids;
          sent += ids.length;
          after = found.next;
        } while (after && sent < cap);
      },
      matchingAmong: async (filters, ids) => prospectIdsStillMatching(search, await resolve(filters), ids),
    };
  }

  const available = config.NODE_ENV !== "production";
  // Search shows a corpus of the configured size and smart lists the default one; ids are the same in both.
  const everyone = () => (available ? [...demoPeople(), ...demoPeople(config.DEMO_CORPUS_SIZE)] : []);
  const matches = async (filters: SearchFilters) => (available ? filterDemoCorpus(demoPeople(), await resolveFiltersForSearch(null, filters), Number.MAX_SAFE_INTEGER) : []);
  return {
    available,
    async byIds(ids) {
      if (!ids.length) return new Map();
      const wanted = new Set(ids);
      return byId(everyone().filter((doc) => wanted.has(doc.prospectId)));
    },
    async page(filters, page, pageSize) {
      const hits = await matches(filters);
      return { hits: hits.slice((page - 1) * pageSize, page * pageSize), total: hits.length };
    },
    count: async (filters) => (await matches(filters)).length,
    async *matching(filters, cap) {
      const hits = (await matches(filters)).slice(0, cap);
      for (let i = 0; i < hits.length; i += BATCH) yield hits.slice(i, i + BATCH).map((h) => h.prospectId);
    },
    async matchingAmong(filters, ids) {
      const found = new Set((await matches(filters)).map((doc) => doc.prospectId));
      return new Set(ids.filter((id) => found.has(id)));
    },
  };
}
