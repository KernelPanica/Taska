import type { Database } from "../db/index.js";
import { placeholders } from "../ticket-types/common.js";
import type { historyService } from "./history.js";
import type { TreeStore } from "./tree.js";

/**
 * Номер в потоке (R-2.9; YT-11, docs/adr/0017): путь от верхнего предка по порядку детей — 1.3.2.
 * Верхние тикеты нумеруются ручным порядком в своём пространстве. У тикета с несколькими родителями —
 * номер на каждый путь. Ссылки всегда по ключу (R-2.6): номер меняется, ключ — никогда.
 *
 * Пересчёт идёт сверху вниз только по затронутым веткам; изменившиеся номера пишутся в историю
 * системной строкой «номер 1.3 → 1.4, вставлен AOS-…». Уведомлений об этом нет.
 */
export type NumberCause = { kind: "inserted" | "moved" | "removed" | "reordered"; key: string } | null;

export interface FlowNumber {
  number: string;
  parentId: string | null;
}

const pad = (part: number) => String(part).padStart(5, "0");

export function numberingService(db: Database, tree: TreeStore, history: ReturnType<typeof historyService>) {
  const childrenOf = db.prepare(
    "SELECT child_id AS id FROM ticket_parents WHERE parent_id = ? ORDER BY position, created_at, child_id",
  );
  const parentsOf = db.prepare("SELECT parent_id AS id FROM ticket_parents WHERE child_id = ?");
  const rootsOf = db.prepare(
    `SELECT t.id FROM tickets t WHERE t.space_id = ? AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ticket_parents p WHERE p.child_id = t.id)
     ORDER BY t.root_position, t.number`,
  );
  const spaceOf = db.prepare("SELECT space_id AS id FROM tickets WHERE id = ?");
  const stored = db.prepare(
    "SELECT number, parent_id, sort_key FROM ticket_numbers WHERE ticket_id = ? ORDER BY sort_key",
  );

  function read(id: string) {
    return stored.all(id) as { number: string; parent_id: string | null; sort_key: string }[];
  }

  /**
   * Пересчитывает номера: seeds — тикеты, у которых мог поменяться порядок среди соседей
   * (все дети затронутых родителей и верхние тикеты затронутых пространств), и всех их потомков.
   */
  function renumber(
    seeds: { parents?: readonly string[]; spaces?: readonly string[]; tickets?: readonly string[] },
    cause: NumberCause,
    record = true,
  ) {
    const start = new Set<string>(seeds.tickets ?? []);
    for (const parent of seeds.parents ?? [])
      for (const row of childrenOf.all(parent) as { id: string }[]) start.add(row.id);
    for (const space of seeds.spaces ?? []) for (const row of rootsOf.all(space) as { id: string }[]) start.add(row.id);
    if (start.size === 0) return 0;
    const affected = tree.subtree([...start]);
    const inside = new Set(affected);
    const result = new Map<string, { number: string; parentId: string | null; sortKey: string }[]>();
    const rankCache = new Map<string, Map<string, number>>();
    const rankIn = (parentId: string | null, spaceId: string, id: string) => {
      const cacheKey = parentId ?? `space:${spaceId}`;
      let ranks = rankCache.get(cacheKey);
      if (!ranks) {
        const rows = (parentId ? childrenOf.all(parentId) : rootsOf.all(spaceId)) as { id: string }[];
        ranks = new Map(rows.map((row, index) => [row.id, index + 1]));
        rankCache.set(cacheKey, ranks);
      }
      return ranks.get(id) ?? 1;
    };
    const numbersOf = (id: string) =>
      inside.has(id)
        ? (result.get(id) ?? [])
        : read(id).map((row) => ({ number: row.number, parentId: row.parent_id, sortKey: row.sort_key }));

    // Сверху вниз: к моменту узла номера его родителей уже посчитаны.
    for (const id of tree.topo(affected)) {
      const parents = (parentsOf.all(id) as { id: string }[]).map((row) => row.id);
      const next: { number: string; parentId: string | null; sortKey: string }[] = [];
      if (parents.length === 0) {
        const space = (spaceOf.get(id) as { id: string }).id;
        const rank = rankIn(null, space, id);
        next.push({ number: String(rank), parentId: null, sortKey: pad(rank) });
      } else {
        for (const parent of parents) {
          const space = (spaceOf.get(parent) as { id: string }).id;
          const rank = rankIn(parent, space, id);
          for (const base of numbersOf(parent)) {
            next.push({ number: `${base.number}.${rank}`, parentId: parent, sortKey: `${base.sortKey}.${pad(rank)}` });
          }
        }
      }
      next.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      result.set(id, next);
    }

    const remove = db.prepare("DELETE FROM ticket_numbers WHERE ticket_id = ?");
    const insert = db.prepare(
      "INSERT OR IGNORE INTO ticket_numbers (ticket_id, number, parent_id, sort_key) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    let changed = 0;
    for (const [id, next] of result) {
      const before = read(id);
      const text = (list: { number: string }[]) => list.map((item) => item.number).join(", ");
      const same =
        before.length === next.length &&
        before.every((row, index) => row.number === next[index]?.number && row.parent_id === next[index]?.parentId);
      if (same) continue;
      changed += 1;
      remove.run(id);
      for (const item of next) insert.run(id, item.number, item.parentId, item.sortKey);
      // Сам вставленный или перенесённый тикет получает свою запись о связи; строку о номере пишем соседям и потомкам.
      if (record && before.length && cause && !(cause.key && isCauseTicket(id, cause.key))) {
        history.record(
          id,
          { id: null, name: null, source: "system", detail: `number:${cause.kind}:${cause.key}` },
          [
            {
              field: "number",
              from: { raw: before.map((row) => row.number), text: text(before) },
              to: { raw: next.map((row) => row.number), text: text(next) },
            },
          ],
          now,
        );
      }
    }
    return changed;
  }

  const keyOf = db.prepare("SELECT key FROM tickets WHERE id = ?");
  function isCauseTicket(id: string, key: string) {
    return (keyOf.get(id) as { key: string } | undefined)?.key === key;
  }

  return {
    renumber,

    /** Номера тикетов для показа, по порядку путей. */
    numbers(ids: readonly string[]): Map<string, FlowNumber[]> {
      const map = new Map<string, FlowNumber[]>();
      for (let index = 0; index < ids.length; index += 500) {
        const chunk = ids.slice(index, index + 500);
        if (!chunk.length) continue;
        for (const row of db
          .prepare(
            `SELECT ticket_id AS id, number, parent_id FROM ticket_numbers WHERE ticket_id IN (${placeholders(chunk)}) ORDER BY sort_key`,
          )
          .all(...chunk) as { id: string; number: string; parent_id: string | null }[]) {
          map.set(row.id, [...(map.get(row.id) ?? []), { number: row.number, parentId: row.parent_id }]);
        }
      }
      return map;
    },

    /** Место нового верхнего тикета в пространстве: в конец или перед указанным. */
    rootPosition(spaceId: string, beforeId?: string | null) {
      const rows = db
        .prepare(
          `SELECT t.id, t.root_position AS p FROM tickets t WHERE t.space_id = ? AND t.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM ticket_parents x WHERE x.child_id = t.id) ORDER BY t.root_position, t.number`,
        )
        .all(spaceId) as { id: string; p: number | null }[];
      const index = beforeId ? rows.findIndex((row) => row.id === beforeId) : -1;
      if (index < 0) return (rows.at(-1)?.p ?? 0) + 1;
      const previous = index > 0 ? (rows[index - 1]?.p ?? 0) : (rows[0]?.p ?? 1) - 1;
      return (previous + (rows[index]?.p ?? 0)) / 2;
    },

    /** Первое заполнение (после миграции): все пространства без записей в историю. */
    ensure() {
      const tickets = (db.prepare("SELECT count(*) AS n FROM tickets WHERE deleted_at IS NULL").get() as { n: number })
        .n;
      const numbered = (db.prepare("SELECT count(DISTINCT ticket_id) AS n FROM ticket_numbers").get() as { n: number })
        .n;
      if (tickets === numbered) return;
      const spaces = (db.prepare("SELECT id FROM spaces").all() as { id: string }[]).map((row) => row.id);
      db.transaction(() => renumber({ spaces }, null, false))();
    },
  };
}

export type NumberingService = ReturnType<typeof numberingService>;
