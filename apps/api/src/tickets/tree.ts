import type { Database } from "../db/index.js";
import { placeholders } from "../ticket-types/common.js";

/**
 * Дерево тикетов (R-2.8; docs/adr/0015): связи родитель–ребёнок и замыкание «предок–потомок».
 * Замыкание обновляется в той же транзакции, что и связь, поэтому циклы, ветки прав, наследование
 * видимости, охват и свёртки читаются одним запросом без рекурсии.
 */
export function treeStore(db: Database) {
  const store = {
    /** Новый тикет — сам себе предок на глубине 0. */
    addNode(id: string) {
      db.prepare("INSERT OR IGNORE INTO ticket_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)").run(
        id,
        id,
      );
    },

    parents(id: string): string[] {
      return (
        db.prepare("SELECT parent_id AS id FROM ticket_parents WHERE child_id = ? ORDER BY created_at").all(id) as {
          id: string;
        }[]
      ).map((row) => row.id);
    },

    children(id: string): string[] {
      return (
        db.prepare("SELECT child_id AS id FROM ticket_parents WHERE parent_id = ? ORDER BY position").all(id) as {
          id: string;
        }[]
      ).map((row) => row.id);
    },

    /** Предки (без самого тикета). */
    ancestors(ids: readonly string[]): string[] {
      if (ids.length === 0) return [];
      return (
        db
          .prepare(
            `SELECT DISTINCT ancestor_id AS id FROM ticket_closure WHERE descendant_id IN (${placeholders([...ids])}) AND depth > 0`,
          )
          .all(...ids) as { id: string }[]
      ).map((row) => row.id);
    },

    /** Потомки вместе с самими тикетами. */
    subtree(ids: readonly string[]): string[] {
      if (ids.length === 0) return [];
      return [
        ...new Set([
          ...ids,
          ...(
            db
              .prepare(
                `SELECT DISTINCT descendant_id AS id FROM ticket_closure WHERE ancestor_id IN (${placeholders([...ids])})`,
              )
              .all(...ids) as { id: string }[]
          ).map((row) => row.id),
        ]),
      ];
    },

    /** a — предок b или сам b. */
    isAncestorOrSelf(a: string, b: string) {
      return (
        a === b ||
        Boolean(db.prepare("SELECT 1 FROM ticket_closure WHERE ancestor_id = ? AND descendant_id = ?").get(a, b))
      );
    },

    /** Порядок «родители раньше детей» внутри набора (алгоритм Кана по связям внутри набора). */
    topo(ids: readonly string[]): string[] {
      const set = new Set(ids);
      if (set.size <= 1) return [...set];
      const list = [...set];
      const edges: { p: string; c: string }[] = [];
      for (let index = 0; index < list.length; index += 400) {
        const chunk = list.slice(index, index + 400);
        edges.push(
          ...(db
            .prepare(
              `SELECT parent_id AS p, child_id AS c FROM ticket_parents WHERE child_id IN (${placeholders(chunk)})`,
            )
            .all(...chunk) as { p: string; c: string }[]),
        );
      }
      const indegree = new Map(list.map((id) => [id, 0]));
      const next = new Map<string, string[]>();
      for (const edge of edges) {
        if (!set.has(edge.p)) continue;
        indegree.set(edge.c, (indegree.get(edge.c) ?? 0) + 1);
        next.set(edge.p, [...(next.get(edge.p) ?? []), edge.c]);
      }
      const queue = list.filter((id) => indegree.get(id) === 0);
      const order: string[] = [];
      while (queue.length) {
        const id = queue.shift() as string;
        order.push(id);
        for (const child of next.get(id) ?? []) {
          const left = (indegree.get(child) ?? 0) - 1;
          indegree.set(child, left);
          if (left === 0) queue.push(child);
        }
      }
      return order;
    },

    /** Позиция «перед этим ребёнком» у родителя; без ключа или с чужим ключом — undefined (в конец). */
    positionBefore(parentId: string, beforeKey: string | null | undefined) {
      if (!beforeKey) return undefined;
      const rows = db
        .prepare(
          "SELECT t.key, p.position FROM ticket_parents p JOIN tickets t ON t.id = p.child_id WHERE p.parent_id = ? ORDER BY p.position, p.created_at",
        )
        .all(parentId) as { key: string; position: number }[];
      const index = rows.findIndex((row) => row.key === beforeKey.toUpperCase());
      if (index < 0) return undefined;
      const previous = index > 0 ? (rows[index - 1]?.position ?? 0) : (rows[0]?.position ?? 1) - 1;
      return (previous + (rows[index]?.position ?? 0)) / 2;
    },

    /** Связь parent → child (цикл проверяет вызывающий). position — порядок среди детей. */
    link(parentId: string, childId: string, userId: string | null, position?: number) {
      const at =
        position ??
        ((
          db.prepare("SELECT max(position) AS p FROM ticket_parents WHERE parent_id = ?").get(parentId) as {
            p: number | null;
          }
        ).p ?? 0) + 1;
      db.prepare(
        "INSERT OR IGNORE INTO ticket_parents (parent_id, child_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(parentId, childId, at, userId, Date.now());
      db.prepare(
        `INSERT INTO ticket_closure (ancestor_id, descendant_id, depth)
         SELECT a.ancestor_id, d.descendant_id, a.depth + d.depth + 1
         FROM ticket_closure a, ticket_closure d WHERE a.descendant_id = ? AND d.ancestor_id = ?
         ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = min(depth, excluded.depth)`,
      ).run(parentId, childId);
    },

    /** Снимает связи и пересобирает замыкание затронутых веток. */
    unlink(pairs: readonly { parentId: string; childId: string }[]) {
      if (pairs.length === 0) return;
      const remove = db.prepare("DELETE FROM ticket_parents WHERE parent_id = ? AND child_id = ?");
      for (const pair of pairs) remove.run(pair.parentId, pair.childId);
      store.rebuild([...new Set(pairs.map((pair) => pair.childId))]);
    },

    /**
     * Пересобирает «внешних» предков для веток: внутри ветки пути не меняются, поэтому удаляются
     * только пары (внешний предок, узел ветки) и считаются заново сверху вниз.
     */
    rebuild(rootIds: readonly string[]) {
      const subtree = store.subtree(rootIds);
      const inside = JSON.stringify(subtree);
      db.prepare(
        `DELETE FROM ticket_closure WHERE descendant_id IN (SELECT value FROM json_each(?))
           AND ancestor_id NOT IN (SELECT value FROM json_each(?))`,
      ).run(inside, inside);
      const parentsOf = db.prepare("SELECT parent_id AS id FROM ticket_parents WHERE child_id = ?");
      const copy = db.prepare(
        `INSERT INTO ticket_closure (ancestor_id, descendant_id, depth)
         SELECT a.ancestor_id, ?, a.depth + 1 FROM ticket_closure a WHERE a.descendant_id = ?
         ON CONFLICT (ancestor_id, descendant_id) DO UPDATE SET depth = min(depth, excluded.depth)`,
      );
      // Сверху вниз: к моменту узла его родители внутри ветки уже знают своих внешних предков.
      for (const id of store.topo(subtree)) {
        for (const parent of parentsOf.all(id) as { id: string }[]) copy.run(id, parent.id);
      }
    },
  };
  return store;
}

export type TreeStore = ReturnType<typeof treeStore>;
