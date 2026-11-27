import type { MoveInput, StatusCategory, TicketTree, TreeNode, WrapInput } from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import type { UserRow } from "../auth/sessions.js";
import { forbidden } from "../access/service.js";
import { AppError } from "../errors.js";
import { visibleSql } from "../directory/common.js";
import { requireVisibleSpace } from "../spaces/routes.js";
import { placeholders } from "../ticket-types/common.js";
import { progressOf, type TicketRow, type TicketService } from "./service.js";

/**
 * Операции над деревом (R-2.8, R-2.17; YT-09, docs/adr/0015). Каждая операция — одна транзакция:
 * связи, замыкание, видимость ветки, история всех затронутых тикетов и свёртки предков.
 */
export function hierarchyService(db: Database, tickets: TicketService) {
  const { tree, access, rollups, numbering } = tickets;
  const isRoot = (id: string) => tree.parents(id).length === 0;

  /** Ребёнок, которого зритель может перемещать (право «Перемещать»). */
  function movable(viewer: UserRow, key: string, ctx: ReturnType<typeof access.context>) {
    const loaded = tickets.load(viewer, key, ctx);
    tickets.requireRight(loaded.acc, "move");
    return loaded;
  }

  /** Несколько тикетов за раз — массовая операция (R-5.2). */
  function requireBulk(viewer: UserRow, loaded: { acc: { rights: Set<string> } }[]) {
    if (loaded.length > 1 && loaded.some((item) => !item.acc.rights.has("bulk"))) throw forbidden("bulk");
  }

  const service = {
    addParent(viewer: UserRow, childKey: string, parentKey: string) {
      const ctx = access.context(viewer);
      const child = movable(viewer, childKey, ctx);
      const parent = tickets.load(viewer, parentKey, ctx);
      if (tree.parents(child.row.id).includes(parent.row.id)) return tickets.get(viewer, child.row.id);
      db.transaction(() => {
        const wasRoot = isRoot(child.row.id);
        tickets.attach(viewer, parent.row, child.row);
        numbering.renumber(
          { tickets: [child.row.id], parents: [parent.row.id], spaces: wasRoot ? [child.row.space_id] : [] },
          { kind: "inserted", key: child.row.key },
        );
        rollups.recompute([parent.row.id, child.row.id]);
      })();
      return tickets.get(viewer, child.row.id);
    },

    /** Снять связь с одним родителем, не трогая других (R-2.8). */
    removeParent(viewer: UserRow, childKey: string, parentKey: string) {
      const ctx = access.context(viewer);
      const child = movable(viewer, childKey, ctx);
      const parentRow = tickets.baseRow(viewer, parentKey);
      if (!parentRow || !tree.parents(child.row.id).includes(parentRow.id)) {
        throw new AppError(404, "not_found", "This ticket has no such parent");
      }
      db.transaction(() => {
        tickets.detach(viewer, [{ parent: parentRow, child: child.row }]);
        if (isRoot(child.row.id)) {
          // Стал верхним — в конец ручного порядка пространства.
          db.prepare("UPDATE tickets SET root_position = ? WHERE id = ?").run(
            numbering.rootPosition(child.row.space_id),
            child.row.id,
          );
        }
        numbering.renumber(
          {
            tickets: [child.row.id],
            parents: [parentRow.id],
            spaces: isRoot(child.row.id) ? [child.row.space_id] : [],
          },
          { kind: "removed", key: child.row.key },
        );
        rollups.recompute([parentRow.id, child.row.id]);
      })();
      return tickets.get(viewer, child.row.id);
    },

    /**
     * Массовая смена родителя и перенос ветки: ветка переезжает вместе с корнем одной операцией.
     * fromParentKey — заменить одну связь; без него заменяются все родители.
     */
    move(viewer: UserRow, input: MoveInput) {
      const ctx = access.context(viewer);
      const keys = [...new Set(input.keys.map((key) => key.toUpperCase()))];
      const items = keys.map((key) => movable(viewer, key, ctx));
      requireBulk(viewer, items);
      const target = input.toParentKey ? tickets.load(viewer, input.toParentKey, ctx).row : null;
      const from = input.fromParentKey ? tickets.baseRow(viewer, input.fromParentKey) : null;
      if (input.fromParentKey && !from) throw new AppError(404, "not_found", "The old parent is not found");
      const touched = new Set<string>();
      const spaces = new Set<string>();
      db.transaction(() => {
        let position = target ? tree.positionBefore(target.id, input.beforeKey) : undefined;
        for (const { row } of items) {
          const current = tree.parents(row.id);
          if (current.length === 0) spaces.add(row.space_id);
          const drop = (from ? current.filter((id) => id === from.id) : current).filter((id) => id !== target?.id);
          if (drop.length) {
            tickets.detach(
              viewer,
              drop.map((id) => ({ parent: tickets.byId(id), child: row })),
            );
            drop.forEach((id) => touched.add(id));
          }
          if (target) {
            if (current.includes(target.id)) {
              // Тот же родитель — только порядок.
              if (position !== undefined) {
                db.prepare("UPDATE ticket_parents SET position = ? WHERE parent_id = ? AND child_id = ?").run(
                  position,
                  target.id,
                  row.id,
                );
              }
            } else {
              tickets.attach(viewer, target, row, position);
            }
            if (position !== undefined) position += 1e-6;
            touched.add(target.id);
          } else {
            // Без родителя — верхний уровень: ручной порядок в пространстве, beforeKey — перед кем встать.
            const before = input.beforeKey ? tickets.baseRow(viewer, input.beforeKey) : null;
            db.prepare("UPDATE tickets SET root_position = ? WHERE id = ?").run(
              numbering.rootPosition(row.space_id, before?.id ?? null),
              row.id,
            );
            spaces.add(row.space_id);
          }
          touched.add(row.id);
        }
        // Номера: соседи у старых и новых родителей, верхние тикеты затронутых пространств и ветки перенесённых.
        numbering.renumber(
          { tickets: items.map(({ row }) => row.id), parents: [...touched], spaces: [...spaces] },
          { kind: "moved", key: (items[0] as { row: TicketRow }).row.key },
        );
        rollups.recompute([...touched]);
      })();
      return { items: items.map(({ row }) => tickets.get(viewer, row.id)) };
    },

    /**
     * «Обернуть в родителя»: новый тикет встаёт между тикетами и их родителем fromParentKey;
     * без него — просто становится родителем выше (в том числе над самым верхним тикетом).
     */
    wrap(viewer: UserRow, input: WrapInput) {
      const ctx = access.context(viewer);
      const keys = [...new Set(input.keys.map((key) => key.toUpperCase()))];
      if (keys.length === 0) throw new AppError(400, "validation_failed", "Choose tickets to wrap");
      let items = keys.map((key) => movable(viewer, key, ctx));
      requireBulk(viewer, items);
      const from = input.fromParentKey ? tickets.load(viewer, input.fromParentKey, ctx).row : null;
      if (from) {
        // Порядок под новым уровнем — как был у прежнего родителя, а не как отмечали.
        const order = new Map(
          (
            db.prepare("SELECT child_id AS id, position FROM ticket_parents WHERE parent_id = ?").all(from.id) as {
              id: string;
              position: number;
            }[]
          ).map((row) => [row.id, row.position]),
        );
        items = [...items].sort((a, b) => (order.get(a.row.id) ?? 0) - (order.get(b.row.id) ?? 0));
        const outside = items.filter(({ row }) => !tree.parents(row.id).includes(from.id));
        if (outside.length) {
          throw new AppError(400, "validation_failed", `Not all tickets are children of ${from.key}`, [
            { field: "keys", message: outside.map(({ row }) => row.key).join(", ") },
          ]);
        }
      }
      const spaceId = input.spaceId ?? from?.space_id ?? (items[0] as { row: TicketRow }).row.space_id;
      tickets.requireCreate(viewer, spaceId, ctx);
      let id = "";
      db.transaction(() => {
        const created = tickets.insertTicket(
          viewer,
          { spaceId, typeId: input.typeId, title: input.title },
          spaceId,
          "wrap",
        );
        id = created.id;
        if (from) {
          const position = (
            db
              .prepare("SELECT position FROM ticket_parents WHERE parent_id = ? AND child_id = ?")
              .get(from.id, (items[0] as { row: TicketRow }).row.id) as { position: number }
          ).position;
          tickets.detach(
            viewer,
            items.map(({ row }) => ({ parent: from, child: row })),
            "wrap",
          );
          tickets.attach(viewer, from, created, position, "wrap");
        }
        const roots = items.filter(({ row }) => isRoot(row.id)).map(({ row }) => row.space_id);
        for (const { row } of items) tickets.attach(viewer, created, row, undefined, "wrap");
        numbering.renumber(
          { tickets: [created.id], parents: from ? [from.id] : [], spaces: [...roots, created.space_id] },
          { kind: "inserted", key: created.key },
        );
        rollups.recompute([created.id, ...(from ? [from.id] : []), ...items.map(({ row }) => row.id)]);
      })();
      return tickets.get(viewer, id);
    },

    /**
     * Дерево (R-2.8): пространство или ветка. Общий тикет — под каждым родителем (parentCount > 1).
     * Недоступный узел — без ключа и названия (R-2.17); дети «только заголовка» не показываются (R-2.20).
     */
    tree(viewer: UserRow, query: { spaceId?: string; rootKey?: string }): TicketTree {
      const ctx = access.context(viewer);
      let roots: string[];
      if (query.rootKey) {
        roots = [tickets.load(viewer, query.rootKey, ctx).row.id];
      } else {
        if (!query.spaceId) throw new AppError(400, "validation_failed", "Choose a space or a root ticket");
        const space = requireVisibleSpace(db, viewer, query.spaceId);
        roots = (
          db
            .prepare(
              `SELECT t.id FROM tickets t WHERE t.space_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL AND ${visibleSql(viewer, "t.is_test")}
               AND NOT EXISTS (SELECT 1 FROM ticket_parents p JOIN tickets pt ON pt.id = p.parent_id
                 WHERE p.child_id = t.id AND pt.space_id = t.space_id AND pt.archived_at IS NULL)
               ORDER BY t.number LIMIT 2000`,
            )
            .all(space.id) as { id: string }[]
        ).map((row) => row.id);
      }
      const all = tree.subtree(roots).slice(0, 5000);
      const rows = new Map<string, TicketRow & { status_name: string; category: StatusCategory }>();
      for (let index = 0; index < all.length; index += 500) {
        const chunk = all.slice(index, index + 500);
        for (const row of db
          .prepare(
            `SELECT t.*, s.name AS status_name, s.category FROM tickets t JOIN scheme_statuses s ON s.id = t.status_id
             WHERE t.id IN (${placeholders(chunk)}) AND t.archived_at IS NULL`,
          )
          .all(...chunk) as (TicketRow & { status_name: string; category: StatusCategory; is_test: number })[]) {
          if (row.is_test === 1 && !viewer.isTest) continue;
          rows.set(row.id, row);
        }
      }
      const accs = access.evaluateMany(viewer, [...rows.keys()], ctx);
      const reach = tickets.coverage([...rows.keys()]);
      const edges = new Map<string, string[]>();
      const parentCount = new Map<string, number>();
      for (let index = 0; index < all.length; index += 500) {
        const chunk = all.slice(index, index + 500);
        for (const edge of db
          .prepare(
            `SELECT parent_id AS p, child_id AS c FROM ticket_parents WHERE parent_id IN (${placeholders(chunk)}) ORDER BY position`,
          )
          .all(...chunk) as { p: string; c: string }[]) {
          if (!rows.has(edge.c)) continue;
          edges.set(edge.p, [...(edges.get(edge.p) ?? []), edge.c]);
        }
      }
      for (const id of rows.keys()) parentCount.set(id, tree.parents(id).length);

      // Недоступным — непрозрачные id: по ответу нельзя узнать даже идентификатор тикета.
      const opaque = new Map<string, string>();
      const idOf = (id: string) => {
        const level = accs.get(id)?.level ?? "none";
        if (level !== "none") return id;
        let hidden = opaque.get(id);
        if (!hidden) {
          hidden = `hidden-${opaque.size + 1}`;
          opaque.set(id, hidden);
        }
        return hidden;
      };
      const flow = tickets.numbering.numbers([...rows.keys()]);
      const numbersOf = (id: string) =>
        (flow.get(id) ?? []).map((entry) => ({
          number: entry.number,
          parentId: entry.parentId && rows.has(entry.parentId) ? idOf(entry.parentId) : null,
        }));
      const nodes: Record<string, TreeNode> = {};
      const children: Record<string, string[]> = {};
      for (const [id, row] of rows) {
        const level = accs.get(id)?.level ?? "none";
        const nodeId = idOf(id);
        const count = parentCount.get(id) ?? 0;
        if (level === "none") {
          nodes[nodeId] = { id: nodeId, available: false, parentCount: count, numbers: numbersOf(id) };
        } else {
          nodes[nodeId] = {
            id: nodeId,
            available: true,
            key: row.key,
            title: row.title,
            typeId: row.type_id,
            spaceId: row.space_id,
            statusName: level === "full" ? row.status_name : "",
            category: level === "full" ? row.category : "queue",
            titleOnly: level === "title",
            progress: progressOf(row),
            coverage: reach.get(id) ?? 0,
            parentCount: count,
            numbers: numbersOf(id),
          };
        }
        if (level !== "title") {
          const list = (edges.get(id) ?? []).map(idOf);
          if (list.length) children[nodeId] = list;
        }
      }
      return { nodes, roots: roots.filter((id) => rows.has(id)).map(idOf), children };
    },
  };
  return service;
}
