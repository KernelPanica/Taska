import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import {
  CHILDREN_MODES,
  type ChecklistItem,
  type ChildrenMode,
  type PersonRef,
  type RelinkInput,
  type RelinkResult,
  type RestoreInput,
  type RestoreResult,
  type TrashInput,
  type TrashItem,
  type TrashResult,
  type TrashSettings,
  type TrashTicketRef,
} from "@yourtask/contracts";
import type { Database } from "../db/index.js";
import { AppError, problemResponses } from "../errors.js";
import { requireAuth, requireSuperadmin, type UserRow } from "../auth/sessions.js";
import { forbidden, type TicketAccess } from "../access/service.js";
import { personRefSchema, visibleSql } from "../directory/common.js";
import { json, placeholders } from "../ticket-types/common.js";
import type { HistoryActor } from "./history.js";
import { ticketService, type TicketRow, type TicketService } from "./service.js";
import { notifier } from "../notifications/service.js";

/**
 * Корзина (R-2.22), удаление родителя с выбором для детей и след родителя (R-2.8), права R-5.2
 * (YT-14, docs/adr/0020).
 *
 * Удалённый тикет остаётся строкой с признаком deleted_at: ключ не переиспользуется (R-2.6),
 * история неизменяема (R-2.25). Его связи снимаются в той же транзакции и запоминаются в trash_relations —
 * восстановление возвращает те, у которых вторая сторона жива. Связи, созданные самим удалением
 * (дети к другому родителю), запоминаются в trash_added_links: восстановление их снимает, это и есть «Отменить».
 */
const DAY = 24 * 60 * 60 * 1000;
const SYSTEM: HistoryActor = { id: null, name: null, source: "system", detail: "trash" };

interface Relation {
  ticket_id: string;
  batch_id: string;
  kind: "parent" | "child" | "link" | "checklist";
  other_id: string;
  position: number | null;
  link_type_id: string | null;
  from_side: number | null;
  item_id: string | null;
}

const ref = (row: Pick<TicketRow, "key" | "title">): TrashTicketRef => ({ key: row.key, title: row.title });

export function trashService(db: Database, tickets: TicketService, attachmentsRoot: string) {
  const { tree, access, rollups, numbering, history } = tickets;
  const byIds = (ids: readonly string[]) =>
    ids.length
      ? (db.prepare(`SELECT * FROM tickets WHERE id IN (${placeholders(ids)})`).all(...ids) as TicketRow[])
      : [];
  const isDeleted = (id: string) =>
    (db.prepare("SELECT deleted_at FROM tickets WHERE id = ?").get(id) as { deleted_at: number | null } | undefined)
      ?.deleted_at !== null;
  const isRoot = (id: string) => tree.parents(id).length === 0;

  function settings(): TrashSettings & { retentionDays: number } {
    const row = db.prepare("SELECT retention_days, last_purge_at FROM trash_settings WHERE id = 1").get() as {
      retention_days: number;
      last_purge_at: number | null;
    };
    return {
      retentionDays: row.retention_days,
      lastPurgeAt: row.last_purge_at === null ? null : new Date(row.last_purge_at).toISOString(),
      canPurge: false,
    };
  }

  /** Подпись связи R-2.13 со стороны тикета: «блокирует AOS-1 …» / «заблокирован AOS-1 …». */
  function linkText(typeId: string, outgoing: boolean, other: TicketRow) {
    const type = db.prepare("SELECT name, inverse_name, symmetric FROM link_types WHERE id = ?").get(typeId) as
      | { name: string; inverse_name: string; symmetric: number }
      | undefined;
    const label = !type ? "" : outgoing || type.symmetric === 1 ? type.name : type.inverse_name;
    return { raw: { typeId, ticketId: other.id }, text: `${label} ${other.key} ${other.title}`.trim() };
  }

  /** Уведомление ПМу, если тикет его команды удалил лид колодца (R-2.27, R-5.2): одно сообщение на пакет. */
  function notifyPms(viewer: UserRow, batchId: string, deleted: readonly TicketRow[]): PersonRef[] {
    const led = new Set(
      (db.prepare("SELECT id FROM guilds WHERE lead_id = ?").all(viewer.id) as { id: string }[]).map((row) => row.id),
    );
    if (!led.size) return [];
    const byPm = new Map<string, TicketRow[]>();
    for (const row of deleted) {
      const values = json<Record<string, unknown>>(row.field_values, {});
      const team = typeof values.team === "string" ? values.team : null;
      const streams = Array.isArray(values.stream) ? values.stream : values.stream ? [values.stream] : [];
      if (!team || !streams.some((stream) => typeof stream === "string" && led.has(stream))) continue;
      const pm = (db.prepare("SELECT pm_id FROM feature_teams WHERE id = ?").get(team) as { pm_id: string | null })
        ?.pm_id;
      if (!pm || pm === viewer.id) continue;
      byPm.set(pm, [...(byPm.get(pm) ?? []), row]);
    }
    // Через общую очередь (YT-18): колокольчик и другие каналы получают одно сообщение на пакет.
    const notified: PersonRef[] = [];
    for (const [pm, rows] of byPm) {
      notifier(db).publish({
        kind: "team_ticket_trashed",
        actorId: viewer.id,
        recipients: [pm],
        entries: rows.map((row) => ({ ticketId: row.id })),
        batchId,
      });
      const person = tickets.personRef(pm);
      if (person) notified.push(person);
    }
    return notified;
  }

  /** Право на каждый тикет; недоступные называем без ключа (R-2.17). */
  function requireOn(accs: Map<string, TicketAccess>, rows: readonly TicketRow[], right: "trash" | "move") {
    const denied = rows.filter((row) => !accs.get(row.id)?.rights.has(right));
    if (!denied.length) return;
    const shown = denied.filter((row) => (accs.get(row.id)?.level ?? "none") !== "none").map((row) => row.key);
    throw new AppError(
      403,
      "forbidden",
      right === "trash"
        ? `You cannot delete ${shown.length ? shown.join(", ") : "some of these tickets"}`
        : `You cannot move ${shown.length ? shown.join(", ") : "some of the children"}`,
      [{ field: right === "trash" ? "keys" : "children", message: `the «${right}» right is missing` }],
    );
  }

  const service = {
    settings,

    /**
     * В корзину (R-2.22): без подтверждения для одного тикета, с подтверждением для нескольких.
     * Если у удаляемых есть дети вне выделения — спрашиваем, что с ними (R-2.8). У детей остаётся след.
     */
    trash(viewer: UserRow, realUser: UserRow, input: TrashInput): TrashResult {
      const ctx = access.context(viewer);
      const keys = [...new Set(input.keys.map((key) => key.trim().toUpperCase()).filter(Boolean))];
      if (!keys.length) throw new AppError(400, "validation_failed", "Choose tickets to delete");
      const selected = keys.map((key) => tickets.load(viewer, key, ctx));
      for (const item of selected) tickets.requireRight(item.acc, "trash");
      if (selected.length > 1 && selected.some((item) => !item.acc.rights.has("bulk"))) throw forbidden("bulk");
      const mode: ChildrenMode | undefined = input.children;
      const ids = new Set(selected.map((item) => item.row.id));
      if (mode === "delete") for (const id of tree.subtree([...ids])) ids.add(id);
      const doomed = byIds([...ids]).filter((row) => row.deleted_at === null);
      const accs = access.evaluateMany(viewer, [...ids], ctx);
      requireOn(accs, doomed, "trash");
      if (doomed.length > 1 && !input.confirm) {
        throw new AppError(409, "bulk_confirm_required", `Confirm deleting ${doomed.length} tickets`, undefined, {
          count: doomed.length,
        });
      }

      // Дети вне удаляемого набора — о них спрашиваем.
      const orphanIds = [
        ...new Set(doomed.flatMap((row) => tree.children(row.id)).filter((id) => !ids.has(id) && !isDeleted(id))),
      ];
      const orphans = byIds(orphanIds);
      const grandparents = [...new Set(doomed.flatMap((row) => tree.parents(row.id)).filter((id) => !ids.has(id)))];
      if (orphans.length && !mode) {
        const orphanAccs = access.evaluateMany(viewer, orphanIds, ctx);
        throw new AppError(409, "children_choice_required", "Choose what happens to the children", undefined, {
          choice: {
            children: orphans.filter((row) => (orphanAccs.get(row.id)?.level ?? "none") !== "none").map(ref),
            hasGrandparents: grandparents.length > 0,
          },
        });
      }
      const effective: ChildrenMode = orphans.length ? (mode as ChildrenMode) : "keep";
      let target: TicketRow | null = null;
      if (orphans.length && (effective === "relink" || effective === "grandparent")) {
        requireOn(access.evaluateMany(viewer, orphanIds, ctx), orphans, "move");
      }
      if (orphans.length && effective === "relink") {
        if (input.targetKey) {
          target = tickets.load(viewer, input.targetKey, ctx).row;
          if (ids.has(target.id)) {
            throw new AppError(400, "validation_failed", "The new parent is being deleted too", [
              { field: "targetKey", message: "choose a ticket that stays" },
            ]);
          }
        } else if (!input.newParentTitle?.trim()) {
          throw new AppError(400, "validation_failed", "Choose the new parent", [
            { field: "targetKey", message: "a key or a title for a new parent" },
          ]);
        }
      }
      if (orphans.length && effective === "grandparent" && !grandparents.length) {
        throw new AppError(400, "validation_failed", "The deleted ticket has no parent to move the children to", [
          { field: "children", message: "choose another option" },
        ]);
      }

      const batchId = randomUUID();
      let notified: PersonRef[] = [];
      const first = selected[0]?.row as TicketRow;
      db.transaction(() => {
        const now = Date.now();
        if (orphans.length && effective === "relink" && !target) {
          tickets.requireCreate(viewer, first.space_id, ctx);
          target = tickets.insertTicket(
            viewer,
            { spaceId: first.space_id, typeId: first.type_id, title: (input.newParentTitle as string).trim() },
            first.space_id,
            "trash",
          );
          numbering.renumber({ tickets: [target.id], spaces: [first.space_id] }, { kind: "inserted", key: target.key });
        }
        db.prepare(
          "INSERT INTO trash_batches (id, deleted_by, deleted_at, children_mode, target_id) VALUES (?, ?, ?, ?, ?)",
        ).run(batchId, viewer.id, now, effective, target?.id ?? null);

        // 1. Что было связано — запоминаем для восстановления.
        const remember = db.prepare(
          `INSERT INTO trash_relations (ticket_id, batch_id, kind, other_id, position, link_type_id, from_side, item_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const parentEdges: { parent_id: string; child_id: string; position: number }[] = [];
        const links: { id: string; type_id: string; from_id: string; to_id: string }[] = [];
        const checklists = new Map<string, Set<string>>();
        for (const row of doomed) {
          for (const edge of db
            .prepare("SELECT parent_id, child_id, position FROM ticket_parents WHERE child_id = ? OR parent_id = ?")
            .all(row.id, row.id) as { parent_id: string; child_id: string; position: number }[]) {
            const asChild = edge.child_id === row.id;
            remember.run(
              row.id,
              batchId,
              asChild ? "parent" : "child",
              asChild ? edge.parent_id : edge.child_id,
              edge.position,
              null,
              null,
              null,
            );
            if (!parentEdges.some((item) => item.parent_id === edge.parent_id && item.child_id === edge.child_id)) {
              parentEdges.push(edge);
            }
            // Пункт-ребёнок у живого родителя: снимаем ссылку на удалённого и запоминаем пункт.
            if (asChild && !ids.has(edge.parent_id)) {
              const parent = tickets.byId(edge.parent_id);
              for (const item of json<ChecklistItem[]>(parent.checklist, [])) {
                if (item.childKey !== row.key) continue;
                remember.run(row.id, batchId, "checklist", parent.id, null, null, null, item.id);
                checklists.set(parent.id, (checklists.get(parent.id) ?? new Set()).add(row.key));
              }
            }
          }
          for (const link of db
            .prepare("SELECT id, type_id, from_id, to_id FROM ticket_links WHERE from_id = ? OR to_id = ?")
            .all(row.id, row.id) as { id: string; type_id: string; from_id: string; to_id: string }[]) {
            const outgoing = link.from_id === row.id;
            remember.run(
              row.id,
              batchId,
              "link",
              outgoing ? link.to_id : link.from_id,
              null,
              link.type_id,
              outgoing ? 1 : 0,
              null,
            );
            if (!links.some((item) => item.id === link.id)) links.push(link);
          }
        }

        // 2. Следы родителя у детей — навсегда (R-2.8).
        const trace = db.prepare(
          `INSERT INTO parent_traces (id, child_id, parent_id, parent_key, parent_title, batch_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const doomedById = new Map(doomed.map((row) => [row.id, row]));
        for (const edge of parentEdges) {
          const parent = doomedById.get(edge.parent_id);
          if (parent && !ids.has(edge.child_id)) {
            trace.run(randomUUID(), edge.child_id, parent.id, parent.key, parent.title, batchId, viewer.id, now);
          }
        }

        // 3. Снимаем связи (история обеих сторон с пометкой «trash»), затем — новый дом детям.
        tickets.detach(
          viewer,
          parentEdges.map((edge) => ({ parent: tickets.byId(edge.parent_id), child: tickets.byId(edge.child_id) })),
          "trash",
        );
        const addLink = db.prepare(
          "INSERT INTO trash_added_links (batch_id, parent_id, child_id, removed_parent_id) VALUES (?, ?, ?, ?)",
        );
        const newParents = new Set<string>();
        if (effective === "relink" || effective === "grandparent") {
          for (const child of orphans) {
            const removed = parentEdges.filter((edge) => edge.child_id === child.id && ids.has(edge.parent_id));
            for (const edge of removed) {
              const homes =
                effective === "relink"
                  ? [(target as TicketRow).id]
                  : parentEdges
                      .filter((item) => item.child_id === edge.parent_id && !ids.has(item.parent_id))
                      .map((item) => item.parent_id);
              for (const home of homes) {
                if (tree.parents(child.id).includes(home)) continue;
                tickets.attach(viewer, tickets.byId(home), tickets.byId(child.id), undefined, "trash");
                addLink.run(batchId, home, child.id, edge.parent_id);
                newParents.add(home);
              }
            }
          }
        }
        for (const link of links) {
          db.prepare("DELETE FROM ticket_links WHERE id = ?").run(link.id);
          for (const [self, other, outgoing] of [
            [link.from_id, link.to_id, true],
            [link.to_id, link.from_id, false],
          ] as const) {
            if (ids.has(self)) continue;
            history.record(
              self,
              { ...tickets.actorOf(viewer, "trash") },
              [{ field: "links", from: linkText(link.type_id, outgoing, tickets.byId(other)), to: null }],
              now,
            );
          }
        }
        for (const [parentId, removedKeys] of checklists) {
          const parent = tickets.byId(parentId);
          const items = json<ChecklistItem[]>(parent.checklist, []).map((item) =>
            item.childKey && removedKeys.has(item.childKey) ? { id: item.id, text: item.text, done: item.done } : item,
          );
          db.prepare("UPDATE tickets SET checklist = ?, version = version + 1 WHERE id = ?").run(
            JSON.stringify(items),
            parentId,
          );
        }

        // 4. Сам признак удаления и запись в историю.
        const mark = db.prepare(
          `UPDATE tickets SET deleted_at = ?, deleted_by = ?, trash_batch_id = ?, version = version + 1 WHERE id = ?`,
        );
        for (const row of doomed) {
          mark.run(now, viewer.id, batchId, row.id);
          db.prepare("DELETE FROM ticket_numbers WHERE ticket_id = ?").run(row.id);
          history.record(row.id, tickets.actorOf(viewer), [
            { field: "trash", from: null, to: { raw: batchId, text: "trash" } },
          ]);
        }
        for (const child of orphans) {
          if (isRoot(child.id)) {
            db.prepare("UPDATE tickets SET root_position = ? WHERE id = ?").run(
              numbering.rootPosition(child.space_id),
              child.id,
            );
          }
        }

        // 5. Номера и свёртки живых.
        const aliveParents = [...new Set([...grandparents, ...newParents])];
        numbering.renumber(
          {
            tickets: orphanIds,
            parents: aliveParents,
            spaces: [...new Set([...doomed, ...orphans].map((row) => row.space_id))],
          },
          { kind: "removed", key: first.key },
        );
        rollups.recompute([...aliveParents, ...orphanIds, ...checklists.keys()]);
        notified = notifyPms(viewer, batchId, doomed);
        access.log(realUser, "ticket.trash", { keys: doomed.map((row) => row.key), children: effective });
      })();

      return { batchId, deleted: doomed.map(ref), children: orphans.map(ref), notified };
    },

    /**
     * Восстановление со связями (R-2.22): удаливший, ПМ команды и админы — в пределах своих прав.
     * Связи, которые создало удаление, снимаются: «Отменить» возвращает всё как было.
     */
    restore(viewer: UserRow, realUser: UserRow, input: RestoreInput): RestoreResult {
      const ctx = access.context(viewer);
      let rows: TicketRow[];
      if (input.batchId) {
        rows = db
          .prepare(
            `SELECT * FROM tickets WHERE trash_batch_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL
             AND ${visibleSql(viewer, "is_test")}`,
          )
          .all(input.batchId) as TicketRow[];
        if (!rows.length) throw new AppError(404, "not_found", "Nothing to restore from this deletion");
      } else {
        const keys = [...new Set((input.keys ?? []).map((key) => key.trim().toUpperCase()).filter(Boolean))];
        if (!keys.length) throw new AppError(400, "validation_failed", "Choose tickets to restore");
        rows = keys.map((key) => {
          const row = tickets.deletedRow(viewer, key);
          if (!row) throw new AppError(404, "not_found", `${key} is not in the trash`);
          return row;
        });
      }
      const purged = rows.filter((row) => row.purged_at !== null);
      if (purged.length) {
        throw new AppError(410, "ticket_purged", `${purged.map((row) => row.key).join(", ")} was deleted for good`);
      }
      const accs = access.evaluateMany(
        viewer,
        rows.map((row) => row.id),
        ctx,
      );
      const denied = rows.filter((row) => !accs.get(row.id)?.rights.has("restore"));
      if (denied.length) {
        const hidden = denied.some((row) => (accs.get(row.id)?.level ?? "none") === "none");
        if (hidden) throw new AppError(404, "not_found", "Ticket not found");
        throw new AppError(
          403,
          "forbidden",
          `Only the person who deleted it, the team PM or an admin can restore ${denied.map((row) => row.key).join(", ")}`,
          [{ field: "keys", message: "the «restore» right is missing" }],
        );
      }

      const ids = new Set(rows.map((row) => row.id));
      const skipped: RestoreResult["skipped"] = [];
      const touched = new Set<string>();
      db.transaction(() => {
        const now = Date.now();
        for (const row of rows) {
          db.prepare(
            `UPDATE tickets SET deleted_at = NULL, deleted_by = NULL, trash_batch_id = NULL, version = version + 1,
               root_position = ? WHERE id = ?`,
          ).run(numbering.rootPosition(row.space_id), row.id);
          history.record(row.id, tickets.actorOf(viewer, "restore"), [
            { field: "trash", from: { raw: row.trash_batch_id, text: "trash" }, to: null },
          ]);
        }
        // Связи, созданные удалением (дети у другого родителя), — снимаем.
        const added = db
          .prepare(`SELECT * FROM trash_added_links WHERE removed_parent_id IN (${placeholders([...ids])})`)
          .all(...ids) as { batch_id: string; parent_id: string; child_id: string; removed_parent_id: string }[];
        const undo = added.filter(
          (item) => !isDeleted(item.child_id) && tree.parents(item.child_id).includes(item.parent_id),
        );
        if (undo.length) {
          tickets.detach(
            viewer,
            undo.map((item) => ({ parent: tickets.byId(item.parent_id), child: tickets.byId(item.child_id) })),
            "restore",
          );
          undo.forEach((item) => touched.add(item.parent_id));
        }
        db.prepare(`DELETE FROM trash_added_links WHERE removed_parent_id IN (${placeholders([...ids])})`).run(...ids);

        const relations = db
          .prepare(`SELECT * FROM trash_relations WHERE ticket_id IN (${placeholders([...ids])})`)
          .all(...ids) as Relation[];
        const reported = new Set<string>();
        const skip = (other: TicketRow, reason: RestoreResult["skipped"][number]["reason"]) => {
          const mark = `${other.key}:${reason}`;
          if (reported.has(mark)) return;
          reported.add(mark);
          skipped.push({ key: other.key, reason });
        };
        const tryAttach = (parent: TicketRow, child: TicketRow, position: number | null, other: TicketRow) => {
          if (tree.parents(child.id).includes(parent.id)) return;
          try {
            tickets.attach(viewer, parent, child, position ?? undefined, "restore");
            touched.add(parent.id);
            touched.add(child.id);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            if (error.code === "hierarchy_cycle") skip(other, "cycle");
            else if (error.code === "subordination_violation") skip(other, "rules");
            else throw error;
          }
        };
        // Сначала дерево, потом пункты чеклиста (им нужен ребёнок).
        const order = { parent: 0, child: 0, link: 1, checklist: 2 } as const;
        for (const relation of relations.sort((a, b) => order[a.kind] - order[b.kind])) {
          const self = tickets.byId(relation.ticket_id);
          const other = tickets.byId(relation.other_id);
          if (!other) continue;
          if (other.deleted_at !== null) {
            skip(other, other.purged_at !== null ? "purged" : "deleted");
            continue;
          }
          if (relation.kind === "parent") tryAttach(other, self, relation.position, other);
          if (relation.kind === "child") tryAttach(self, other, relation.position, other);
          if (relation.kind === "link" && relation.link_type_id) {
            const [from, to] = relation.from_side ? [self, other] : [other, self];
            const exists = db
              .prepare("SELECT 1 FROM ticket_links WHERE type_id = ? AND from_id = ? AND to_id = ?")
              .get(relation.link_type_id, from.id, to.id);
            if (!exists) {
              db.prepare(
                "INSERT INTO ticket_links (id, type_id, from_id, to_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              ).run(randomUUID(), relation.link_type_id, from.id, to.id, viewer.id, now);
              for (const [side, partner, outgoing] of [
                [from, to, true],
                [to, from, false],
              ] as const) {
                history.record(
                  side.id,
                  tickets.actorOf(viewer, "restore"),
                  [{ field: "links", from: null, to: linkText(relation.link_type_id, outgoing, partner) }],
                  now,
                );
              }
              touched.add(from.id);
            }
          }
          if (relation.kind === "checklist" && relation.item_id && tree.parents(self.id).includes(other.id)) {
            const items = json<ChecklistItem[]>(other.checklist, []);
            if (items.some((item) => item.id === relation.item_id)) {
              db.prepare("UPDATE tickets SET checklist = ?, version = version + 1 WHERE id = ?").run(
                JSON.stringify(
                  items.map((item) => (item.id === relation.item_id ? { ...item, childKey: self.key } : item)),
                ),
                other.id,
              );
              touched.add(other.id);
            }
          }
        }
        db.prepare(`DELETE FROM trash_relations WHERE ticket_id IN (${placeholders([...ids])})`).run(...ids);
        // Дети, снова привязанные к восстановленному родителю, — след закрыт.
        db.prepare(
          `UPDATE parent_traces SET relinked_at = ?, relinked_to = parent_id
           WHERE relinked_at IS NULL AND parent_id IN (${placeholders([...ids])})
             AND EXISTS (SELECT 1 FROM ticket_parents p WHERE p.parent_id = parent_traces.parent_id AND p.child_id = parent_traces.child_id)`,
        ).run(now, ...ids);

        const spaces = new Set(rows.map((row) => row.space_id));
        for (const id of touched) spaces.add(tickets.byId(id).space_id);
        numbering.renumber(
          { tickets: [...ids, ...touched], parents: [...touched], spaces: [...spaces] },
          { kind: "inserted", key: (rows[0] as TicketRow).key },
        );
        rollups.recompute([...ids, ...touched]);
        access.log(realUser, "ticket.restore", { keys: rows.map((row) => row.key) });
      })();
      return { restored: rows.map(ref), skipped };
    },

    /** Корзина глазами зрителя: что он видит и что может вернуть или очистить. */
    list(viewer: UserRow, query: { spaceId?: string }): TrashItem[] {
      const ctx = access.context(viewer);
      const rows = db
        .prepare(
          `SELECT t.*, sp.name AS space_name FROM tickets t JOIN spaces sp ON sp.id = t.space_id
           WHERE t.deleted_at IS NOT NULL AND t.purged_at IS NULL AND ${visibleSql(viewer, "t.is_test")}
             ${query.spaceId ? "AND t.space_id = ?" : ""}
           ORDER BY t.deleted_at DESC LIMIT 1000`,
        )
        .all(...(query.spaceId ? [query.spaceId] : [])) as (TicketRow & { space_name: string })[];
      const accs = access.evaluateMany(
        viewer,
        rows.map((row) => row.id),
        ctx,
      );
      const retention = settings().retentionDays * DAY;
      const alive = db.prepare(
        `SELECT count(*) AS n FROM trash_relations r JOIN tickets o ON o.id = r.other_id
         WHERE r.ticket_id = ? AND r.kind <> 'checklist' AND o.deleted_at IS NULL`,
      );
      return rows
        .filter((row) => (accs.get(row.id)?.level ?? "none") !== "none" || row.deleted_by === viewer.id)
        .map((row) => {
          const rights = accs.get(row.id)?.rights ?? new Set();
          return {
            key: row.key,
            title: row.title,
            typeId: row.type_id,
            spaceId: row.space_id,
            spaceName: row.space_name,
            deletedAt: new Date(row.deleted_at as number).toISOString(),
            deletedBy: tickets.personRef(row.deleted_by),
            batchId: row.trash_batch_id ?? "",
            purgeAt: new Date((row.deleted_at as number) + retention).toISOString(),
            relations: (alive.get(row.id) as { n: number }).n,
            canRestore: rights.has("restore"),
            canPurge: rights.has("purge"),
          };
        });
    },

    /** Досрочная окончательная очистка — только суперадмин (R-5.2). */
    async purge(viewer: UserRow, realUser: UserRow, keys: readonly string[]) {
      const ctx = access.context(viewer);
      const rows = [...new Set(keys.map((key) => key.trim().toUpperCase()))].map((key) => {
        const row = tickets.deletedRow(viewer, key);
        if (!row || row.purged_at !== null) throw new AppError(404, "not_found", `${key} is not in the trash`);
        return row;
      });
      const accs = access.evaluateMany(
        viewer,
        rows.map((row) => row.id),
        ctx,
      );
      if (rows.some((row) => !accs.get(row.id)?.rights.has("purge"))) {
        throw new AppError(403, "forbidden", "Only a superadmin can delete for good before the scheduled clean-up", [
          { field: "keys", message: "the «purge» right is missing" },
        ]);
      }
      await service.purgeRows(rows, tickets.actorOf(viewer, "purge"));
      access.log(realUser, "ticket.purge", { keys: rows.map((row) => row.key) });
      return { purged: rows.map(ref) };
    },

    /**
     * Очистка: содержимое, люди, файлы и комментарии уходят; остаются ключ и название (как в следах детей),
     * и история (R-2.22, R-2.25). Ключ не переиспользуется — счётчик только растёт (R-2.6).
     */
    async purgeRows(rows: readonly TicketRow[], actor: HistoryActor) {
      const files: string[] = [];
      const uploads: string[] = [];
      db.transaction(() => {
        const now = Date.now();
        for (const row of rows) {
          files.push(
            ...(
              db.prepare("SELECT storage_key AS k FROM attachments WHERE ticket_id = ?").all(row.id) as { k: string }[]
            ).map((item) => item.k),
          );
          uploads.push(
            ...(
              db.prepare("SELECT id FROM attachment_uploads WHERE ticket_id = ?").all(row.id) as { id: string }[]
            ).map((item) => item.id),
          );
          db.prepare(
            `UPDATE tickets SET purged_at = ?, description = '', checklist = '[]', field_values = '{}', tags = '[]',
               blocked_reason = NULL, cancel_reason = NULL, version = version + 1 WHERE id = ?`,
          ).run(now, row.id);
          for (const table of [
            "ticket_people",
            "attachments",
            "attachment_uploads",
            "ticket_web_links",
            "ticket_visibility_allow",
            "trash_relations",
          ]) {
            db.prepare(`DELETE FROM ${table} WHERE ticket_id = ?`).run(row.id);
          }
          db.prepare("DELETE FROM trash_added_links WHERE removed_parent_id = ?").run(row.id);
          db.prepare(
            "UPDATE ticket_comments SET body = '', deleted_at = coalesce(deleted_at, ?) WHERE ticket_id = ?",
          ).run(now, row.id);
          history.record(
            row.id,
            actor,
            [{ field: "trash", from: { raw: null, text: "trash" }, to: { raw: null, text: "purged" } }],
            now,
          );
        }
      })();
      const fileOf = (key: string) => join(attachmentsRoot, "files", key.slice(0, 2), key);
      for (const key of files) await rm(fileOf(key), { force: true });
      for (const id of uploads) await rm(join(attachmentsRoot, "uploads", `${id}.part`), { force: true });
      return rows.length;
    },

    /** Системное правило: всё, что пролежало дольше срока, очищается (R-2.22). */
    async purgeExpired(now = Date.now()) {
      const cutoff = now - settings().retentionDays * DAY;
      const rows = db
        .prepare("SELECT * FROM tickets WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at <= ?")
        .all(cutoff) as TicketRow[];
      if (rows.length) await service.purgeRows(rows, SYSTEM);
      db.prepare("UPDATE trash_settings SET last_purge_at = ? WHERE id = 1").run(now);
      return rows.length;
    },

    updateSettings(viewer: UserRow, retentionDays: number) {
      db.prepare("UPDATE trash_settings SET retention_days = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(
        retentionDays,
        viewer.id,
        Date.now(),
      );
      access.log(viewer, "trash.settings", { retentionDays });
      return settings();
    },

    /**
     * «Связать заново» (R-2.8): всех бывших детей по следу — к новому родителю или к восстановленному прежнему.
     * Каждому ребёнку нужно право «Перемещать»; кого нельзя — пропускаем и называем.
     */
    relink(viewer: UserRow, input: RelinkInput): RelinkResult {
      const ctx = access.context(viewer);
      const parentKey = input.parentKey.trim().toUpperCase();
      const former = db
        .prepare(`SELECT * FROM tickets WHERE key = ? AND ${visibleSql(viewer, "is_test")}`)
        .get(parentKey) as TicketRow | undefined;
      if (!former) throw new AppError(404, "not_found", "No such parent");
      const target = input.toKey
        ? tickets.load(viewer, input.toKey, ctx).row
        : former.deleted_at === null
          ? tickets.load(viewer, former.key, ctx).row
          : null;
      if (!target) {
        throw new AppError(400, "validation_failed", `${former.key} is not back from the trash: choose a new parent`, [
          { field: "toKey", message: "a ticket that will become the parent" },
        ]);
      }
      const traces = db
        .prepare(
          `SELECT tr.id AS trace_id, c.* FROM parent_traces tr JOIN tickets c ON c.id = tr.child_id
           WHERE tr.parent_id = ? AND tr.relinked_at IS NULL AND c.deleted_at IS NULL AND ${visibleSql(viewer, "c.is_test")}`,
        )
        .all(former.id) as (TicketRow & { trace_id: string })[];
      const accs = access.evaluateMany(
        viewer,
        traces.map((row) => row.id),
        ctx,
      );
      const relinked: TrashTicketRef[] = [];
      const skipped: RelinkResult["skipped"] = [];
      const spaces = new Set<string>();
      db.transaction(() => {
        const now = Date.now();
        const close = db.prepare("UPDATE parent_traces SET relinked_at = ?, relinked_to = ? WHERE id = ?");
        for (const child of traces) {
          const acc = accs.get(child.id);
          if (!acc || acc.level === "none") continue;
          if (!acc.rights.has("move")) {
            skipped.push({ key: child.key, reason: "forbidden" });
            continue;
          }
          if (!tree.parents(child.id).includes(target.id)) {
            try {
              if (isRoot(child.id)) spaces.add(child.space_id);
              tickets.attach(viewer, target, tickets.byId(child.id), undefined, "trace");
            } catch (error) {
              if (error instanceof AppError && error.code === "hierarchy_cycle")
                skipped.push({ key: child.key, reason: "cycle" });
              else if (error instanceof AppError && error.code === "subordination_violation")
                skipped.push({ key: child.key, reason: "rules" });
              else throw error;
              continue;
            }
          }
          close.run(now, target.id, child.trace_id);
          relinked.push(ref(child));
        }
        if (relinked.length) {
          const ids = traces.filter((row) => relinked.some((item) => item.key === row.key)).map((row) => row.id);
          numbering.renumber(
            { tickets: ids, parents: [target.id], spaces: [...spaces] },
            {
              kind: "moved",
              key: (relinked[0] as TrashTicketRef).key,
            },
          );
          rollups.recompute([target.id, ...ids]);
        }
      })();
      return { relinked, skipped };
    },
  };
  return service;
}

// ---- HTTP ----

const tags = ["trash"];
const refSchema = {
  type: "object",
  required: ["key", "title"],
  properties: { key: { type: "string" }, title: { type: "string" } },
} as const;
const refs = { type: "array", items: refSchema } as const;
const keysSchema = { type: "array", minItems: 1, maxItems: 500, items: { type: "string", maxLength: 40 } } as const;
const settingsSchema = {
  type: "object",
  required: ["retentionDays", "lastPurgeAt", "canPurge"],
  properties: {
    retentionDays: { type: "integer" },
    lastPurgeAt: { type: ["string", "null"] },
    canPurge: { type: "boolean" },
  },
} as const;
const nullablePerson = { anyOf: [{ type: "null" }, personRefSchema] } as const;

export const trashRoutes: FastifyPluginAsync<{
  service: TrashService;
  /** Как часто проверять просроченное (мс); 0 — не запускать (тесты зовут purgeExpired сами). */
  sweepMs: number;
}> = async (app, { service, sweepMs }) => {
  if (sweepMs > 0) {
    const sweep = () =>
      service.purgeExpired().catch((error: unknown) => app.log.error({ err: error }, "trash clean-up failed"));
    const timer = setInterval(sweep, sweepMs);
    timer.unref();
    app.addHook("onReady", async () => void sweep());
    app.addHook("onClose", async () => clearInterval(timer));
  }

  app.post(
    "/api/v1/tickets/trash",
    {
      schema: {
        tags,
        summary: "Move tickets to the trash; asks about children (409 children_choice_required) and confirms bulk",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keys"],
          properties: {
            keys: keysSchema,
            children: { type: "string", enum: CHILDREN_MODES },
            targetKey: { type: "string", maxLength: 40 },
            newParentTitle: { type: "string", maxLength: 300 },
            confirm: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["batchId", "deleted", "children", "notified"],
            properties: {
              batchId: { type: "string" },
              deleted: refs,
              children: refs,
              notified: { type: "array", items: personRefSchema },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return service.trash(auth.user, auth.realUser, request.body as TrashInput);
    },
  );

  app.get(
    "/api/v1/trash",
    {
      schema: {
        tags,
        summary: "Deleted tickets the viewer can see, newest first, with the scheduled clean-up date",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { spaceId: { type: "string", maxLength: 64 } },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "settings"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    title: { type: "string" },
                    typeId: { type: "string" },
                    spaceId: { type: "string" },
                    spaceName: { type: "string" },
                    deletedAt: { type: "string" },
                    deletedBy: nullablePerson,
                    batchId: { type: "string" },
                    purgeAt: { type: "string" },
                    relations: { type: "integer" },
                    canRestore: { type: "boolean" },
                    canPurge: { type: "boolean" },
                  },
                },
              },
              settings: settingsSchema,
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      return {
        items: service.list(user, request.query as { spaceId?: string }),
        settings: { ...service.settings(), canPurge: user.role === "superadmin" },
      };
    },
  );

  app.post(
    "/api/v1/trash/restore",
    {
      schema: {
        tags,
        summary:
          "Restore by keys or a whole deletion (batchId, the «Undo» button) with every link whose other side is alive",
        body: {
          type: "object",
          additionalProperties: false,
          properties: { keys: keysSchema, batchId: { type: "string", maxLength: 64 } },
        },
        response: {
          200: {
            type: "object",
            required: ["restored", "skipped"],
            properties: {
              restored: refs,
              skipped: {
                type: "array",
                items: {
                  type: "object",
                  properties: { key: { type: "string" }, reason: { type: "string" } },
                },
              },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return service.restore(auth.user, auth.realUser, request.body as RestoreInput);
    },
  );

  app.post(
    "/api/v1/trash/purge",
    {
      schema: {
        tags,
        summary: "Delete for good before the scheduled clean-up (superadmin); the key and the parent traces stay",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keys"],
          properties: { keys: keysSchema },
        },
        response: {
          200: { type: "object", required: ["purged"], properties: { purged: refs } },
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return service.purge(auth.user, auth.realUser, (request.body as { keys: string[] }).keys);
    },
  );

  app.get(
    "/api/v1/trash-settings",
    { schema: { tags, summary: "Trash clean-up rule", response: { 200: settingsSchema, ...problemResponses } } },
    async (request) => {
      const { user } = requireAuth(request);
      return { ...service.settings(), canPurge: user.role === "superadmin" };
    },
  );

  app.put(
    "/api/v1/trash-settings",
    {
      schema: {
        tags,
        summary: "How many days deleted tickets stay in the trash (superadmin); applies at the next clean-up",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["retentionDays"],
          properties: { retentionDays: { type: "integer", minimum: 1, maximum: 3650 } },
        },
        response: { 200: settingsSchema, ...problemResponses },
      },
    },
    async (request) => {
      const { realUser } = requireSuperadmin(request);
      return {
        ...service.updateSettings(realUser, (request.body as { retentionDays: number }).retentionDays),
        canPurge: true,
      };
    },
  );

  app.post(
    "/api/v1/traces/relink",
    {
      schema: {
        tags,
        summary: "«Relink»: every former child of a deleted parent to a new or the restored parent, in one action",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["parentKey"],
          properties: { parentKey: { type: "string", maxLength: 40 }, toKey: { type: "string", maxLength: 40 } },
        },
        response: {
          200: {
            type: "object",
            required: ["relinked", "skipped"],
            properties: {
              relinked: refs,
              skipped: {
                type: "array",
                items: { type: "object", properties: { key: { type: "string" }, reason: { type: "string" } } },
              },
            },
          },
          ...problemResponses,
        },
      },
    },
    async (request) => service.relink(requireAuth(request).user, request.body as RelinkInput),
  );
};

export type TrashService = ReturnType<typeof trashService>;

/** Корзина поверх общего сервиса тикетов. */
export const createTrash = (db: Database, keyPrefix: string, attachmentsRoot: string) =>
  trashService(db, ticketService(db, keyPrefix), attachmentsRoot);

declare module "fastify" {
  interface FastifyInstance {
    /** Корзина — для служебных задач и автотестов (очистка по сроку). */
    trash: TrashService;
  }
}
