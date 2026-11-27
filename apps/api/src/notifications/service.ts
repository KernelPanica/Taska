import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  NOTIFICATION_KINDS,
  type AppNotification,
  type NotificationEntry,
  type NotificationKind,
  type NotificationSetting,
  type PersonRef,
} from "@yourtask/contracts";
import { orm, type Database } from "../db/index.js";
import { users } from "../db/schema.js";
import type { UserRow } from "../auth/sessions.js";
import { accessService, type TicketAccess } from "../access/service.js";
import { changeBus } from "../events.js";

/**
 * Уведомления и очередь событий (R-2.27, R-2.20), docs/adr/0024.
 *
 * Событие → получатели (без автора, без отключивших этот вид, только кто видит тикет) → пакет запроса
 * (одно сообщение на получателя и вид) → очередь: строка на каждый канал → канал доставляет.
 * Колокольчик — такой же канал, как будущие почта и Telegram; тестовый адаптер получает те же сообщения.
 */

/** Событие, как его сообщает предметная область. */
export interface NotifyEvent {
  kind: NotificationKind;
  actorId: string | null;
  recipients: readonly string[];
  entries: {
    ticketId: string;
    from?: string | null;
    to?: string | null;
    excerpt?: string | null;
    commentId?: string | null;
  }[];
  batchId?: string | null;
}

type StoredEntry = NotifyEvent["entries"][number];

/** Сообщение в очереди: уже на одного получателя, сгруппированное. */
export interface QueuedMessage {
  id: string;
  channel: string;
  userId: string;
  kind: NotificationKind;
  actorId: string | null;
  entries: StoredEntry[];
  batch: boolean;
  batchId: string | null;
  liveKey: string | null;
  createdAt: number;
}

/** Канал доставки. Новый канал (почта, Telegram) — ещё одна реализация, события не меняются. */
export interface Channel {
  readonly name: string;
  deliver(message: QueuedMessage): void | Promise<void>;
}

/** Тестовый адаптер очереди: запоминает всё, что получил (автотесты, демо). */
export class TestChannel implements Channel {
  readonly name = "test";
  readonly received: QueuedMessage[] = [];
  deliver(message: QueuedMessage) {
    this.received.push(message);
    if (this.received.length > 500) this.received.splice(0, this.received.length - 500);
  }
}

interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_id: string | null;
  payload: string;
  created_at: number;
  updated_at: number | null;
  read_at: number | null;
  live_key: string | null;
}

/** Живые записи: смена статуса и комментарии одного тикета, пока не прочитаны, — одна запись. */
const LIVE_KINDS = new Set<NotificationKind>(["status_changed", "commented"]);
const MAX_ENTRIES = 50;
const pending = new AsyncLocalStorage<NotifyEvent[]>();
const instances = new WeakMap<Database, ReturnType<typeof create>>();

export function notifier(db: Database) {
  let instance = instances.get(db);
  if (!instance) {
    instance = create(db);
    instances.set(db, instance);
  }
  return instance;
}

export type Notifier = ReturnType<typeof notifier>;

function create(db: Database) {
  const access = accessService(db);
  const channels = new Map<string, Channel>();
  const drizzle = orm(db);

  const userRow = (id: string) => drizzle.select().from(users).where(eq(users.id, id)).get() as UserRow | undefined;

  function disabled(userId: string): Set<string> {
    return new Set(
      (
        db.prepare("SELECT kind FROM notification_prefs WHERE user_id = ? AND enabled = 0").all(userId) as {
          kind: string;
        }[]
      ).map((row) => row.kind),
    );
  }

  /** Получатели события: не автор, не отключивший вид, не деактивированный; только видимые им тикеты. */
  function resolve(event: NotifyEvent): { userId: string; event: NotifyEvent }[] {
    const result: { userId: string; event: NotifyEvent }[] = [];
    for (const userId of new Set(event.recipients)) {
      if (!userId || userId === event.actorId) continue;
      if (disabled(userId).has(event.kind)) continue;
      const user = userRow(userId);
      if (!user || user.deactivatedAt !== null) continue;
      const accs = access.evaluateMany(
        user,
        event.entries.map((entry) => entry.ticketId),
      );
      const entries = event.entries.filter((entry) => accs.get(entry.ticketId)?.level === "full");
      if (entries.length) result.push({ userId, event: { ...event, entries } });
    }
    return result;
  }

  /** Пакет: всё, что накопилось за запрос, — одно сообщение на получателя и вид (R-2.27). */
  function flush(events: readonly NotifyEvent[]) {
    const groups = new Map<string, { userId: string; kind: NotificationKind; events: NotifyEvent[] }>();
    for (const event of events) {
      for (const item of resolve(event)) {
        const key = `${item.userId}:${event.kind}`;
        const group = groups.get(key) ?? { userId: item.userId, kind: event.kind, events: [] };
        group.events.push(item.event);
        groups.set(key, group);
      }
    }
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO event_queue (id, channel, user_id, kind, payload, live_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const group of groups.values()) {
        const entries = group.events.flatMap((event) => event.entries).slice(0, 500);
        const tickets = new Set(entries.map((entry) => entry.ticketId));
        const actors = new Set(group.events.map((event) => event.actorId));
        const batch = tickets.size > 1;
        const liveKey = !batch && LIVE_KINDS.has(group.kind) ? `${group.kind}:${[...tickets][0]}` : null;
        const payload = {
          actorId: actors.size === 1 ? [...actors][0] : null,
          entries,
          batch,
          batchId: group.events.find((event) => event.batchId)?.batchId ?? null,
        };
        for (const channel of channels.keys()) {
          insert.run(randomUUID(), channel, group.userId, group.kind, JSON.stringify(payload), liveKey, now);
        }
      }
    })();
    dispatch();
  }

  /** Доставка из очереди: синхронные каналы — сразу; ошибка канала — в очереди, повтор позже. */
  function dispatch() {
    if (!channels.size) return;
    const rows = db
      .prepare(
        `SELECT * FROM event_queue WHERE delivered_at IS NULL AND attempts < 10 AND channel IN (SELECT value FROM json_each(?))
         ORDER BY created_at LIMIT 500`,
      )
      .all(JSON.stringify([...channels.keys()])) as {
      id: string;
      channel: string;
      user_id: string;
      kind: NotificationKind;
      payload: string;
      live_key: string | null;
      created_at: number;
    }[];
    const done = db.prepare("UPDATE event_queue SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?");
    const failed = db.prepare("UPDATE event_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?");
    for (const row of rows) {
      const channel = channels.get(row.channel);
      if (!channel) continue;
      const payload = JSON.parse(row.payload) as {
        actorId: string | null;
        entries: StoredEntry[];
        batch: boolean;
        batchId: string | null;
      };
      const message: QueuedMessage = {
        id: row.id,
        channel: row.channel,
        userId: row.user_id,
        kind: row.kind,
        actorId: payload.actorId,
        entries: payload.entries,
        batch: payload.batch,
        batchId: payload.batchId,
        liveKey: row.live_key,
        createdAt: row.created_at,
      };
      const fail = (error: unknown) => failed.run(String(error instanceof Error ? error.message : error), row.id);
      try {
        const result = channel.deliver(message);
        if (result instanceof Promise) result.then(() => done.run(Date.now(), row.id), fail);
        else done.run(Date.now(), row.id);
      } catch (error) {
        fail(error);
      }
    }
  }

  /** Колокольчик — канал очереди: живая запись обновляется на месте, остальное — новой записью. */
  const bell: Channel = {
    name: "bell",
    deliver(message) {
      const now = Date.now();
      const live = message.liveKey
        ? (db
            .prepare(
              "SELECT * FROM notifications WHERE user_id = ? AND live_key = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 1",
            )
            .get(message.userId, message.liveKey) as NotificationRow | undefined)
        : undefined;
      if (live) {
        const old = JSON.parse(live.payload) as { entries?: StoredEntry[] };
        const entries = [...(old.entries ?? []), ...message.entries].slice(-MAX_ENTRIES);
        db.prepare("UPDATE notifications SET payload = ?, actor_id = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify({ entries, batch: false, batchId: null, live: true }),
          message.actorId,
          now,
          live.id,
        );
      } else {
        db.prepare(
          `INSERT INTO notifications (id, user_id, kind, actor_id, payload, created_at, updated_at, live_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          message.userId,
          message.kind,
          message.actorId,
          JSON.stringify({ entries: message.entries, batch: message.batch, batchId: message.batchId, live: false }),
          now,
          now,
          message.liveKey,
        );
      }
      // Живой колокольчик и всплывающее уведомление: событие без содержимого, клиент перечитывает через API.
      changeBus(db).emit("notifications", { userId: message.userId });
    },
  };
  channels.set(bell.name, bell);

  function settings(userId: string): NotificationSetting[] {
    const off = disabled(userId);
    return NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: !off.has(kind) }));
  }

  const personRef = (id: string | null): PersonRef | null => {
    if (!id) return null;
    const row = db.prepare("SELECT id, name, email, deactivated_at FROM users WHERE id = ?").get(id) as
      | { id: string; name: string; email: string | null; deactivated_at: number | null }
      | undefined;
    return row ? { id: row.id, name: row.name, email: row.email, deactivated: row.deactivated_at !== null } : null;
  };

  return {
    channels,
    register(channel: Channel) {
      channels.set(channel.name, channel);
    },
    dispatch,

    /** Событие предметной области. Внутри запроса копится до ответа (пакет), вне запроса — сразу. */
    publish(event: NotifyEvent) {
      if (!event.entries.length || !event.recipients.length) return;
      const buffer = pending.getStore();
      if (buffer) buffer.push(event);
      else flush([event]);
    },

    /** Пакет на время запроса: события отправляются после удачного ответа; при ошибке — отбрасываются. */
    scope<T>(run: () => T) {
      return pending.run([], run);
    },
    /** Начать пакет запроса: всё, что опубликуют обработчики, попадёт в buffer. */
    enter(buffer: NotifyEvent[], next: () => void) {
      pending.run(buffer, next);
    },
    flush,

    /**
     * Колокольчик получателя глазами зрителя: зритель — сам человек или выбранная роль «Режима показа».
     * Недоступный тикет — без ключа и названия; в «Режиме показа» скрытое не показывается вовсе (R-2.20).
     */
    list(recipientId: string, viewer: UserRow): AppNotification[] {
      const rows = db
        .prepare(
          "SELECT * FROM notifications WHERE user_id = ? ORDER BY coalesce(updated_at, created_at) DESC LIMIT 100",
        )
        .all(recipientId) as NotificationRow[];
      const parsed = rows.map((row) => {
        const payload = JSON.parse(row.payload) as {
          entries?: StoredEntry[];
          tickets?: { key: string; title: string }[];
          batch?: boolean;
          batchId?: string | null;
          live?: boolean;
        };
        // Старые записи корзины (YT-14) хранили ключи и названия — находим тикеты по ключу.
        const entries =
          payload.entries ??
          (payload.tickets ?? []).flatMap((ticket): StoredEntry[] => {
            const found = db.prepare("SELECT id FROM tickets WHERE key = ?").get(ticket.key) as
              | { id: string }
              | undefined;
            return found ? [{ ticketId: found.id }] : [];
          });
        return { row, payload, entries };
      });
      const ids = [...new Set(parsed.flatMap((item) => item.entries.map((entry) => entry.ticketId)))];
      const accs = access.evaluateMany(viewer, ids);
      const info = new Map(
        (
          db
            .prepare("SELECT t.id, t.key, t.title, t.purged_at FROM json_each(?) j JOIN tickets t ON t.id = j.value")
            .all(JSON.stringify(ids)) as { id: string; key: string; title: string; purged_at: number | null }[]
        ).map((item) => [item.id, item]),
      );
      const lens = Boolean(viewer.lensProfileId);
      const level = (id: string): TicketAccess["level"] =>
        info.get(id)?.purged_at ? "none" : (accs.get(id)?.level ?? "none");
      const result: AppNotification[] = [];
      for (const { row, payload, entries } of parsed) {
        const shown = entries
          .filter((entry) => !lens || level(entry.ticketId) !== "none")
          .map((entry): NotificationEntry => {
            const seen = level(entry.ticketId);
            const ticket = info.get(entry.ticketId);
            const open = seen === "full";
            return {
              ticket: {
                id: entry.ticketId,
                key: seen === "none" ? null : (ticket?.key ?? null),
                title: seen === "none" ? null : (ticket?.title ?? null),
                available: seen !== "none",
              },
              from: open ? (entry.from ?? null) : null,
              to: open ? (entry.to ?? null) : null,
              excerpt: open ? (entry.excerpt ?? null) : null,
              commentId: open ? (entry.commentId ?? null) : null,
            };
          });
        if (!shown.length) continue;
        const tickets = [...new Map(shown.map((entry) => [entry.ticket.id, entry.ticket])).values()];
        result.push({
          id: row.id,
          kind: row.kind,
          actor: personRef(row.actor_id),
          tickets,
          entries: shown,
          batch: Boolean(payload.batch) || tickets.length > 1,
          live: Boolean(row.live_key),
          batchId: payload.batchId ?? null,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at ?? row.created_at).toISOString(),
          read: row.read_at !== null,
        });
      }
      return result;
    },

    markRead(recipientId: string, ids?: readonly string[]) {
      if (ids?.length) {
        db.prepare(
          `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
        ).run(Date.now(), recipientId, JSON.stringify(ids));
      } else {
        db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(
          Date.now(),
          recipientId,
        );
      }
    },

    settings,

    saveSettings(userId: string, list: readonly NotificationSetting[]) {
      const upsert = db.prepare(
        `INSERT INTO notification_prefs (user_id, kind, enabled) VALUES (?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE SET enabled = excluded.enabled`,
      );
      db.transaction(() => {
        for (const item of list) {
          if ((NOTIFICATION_KINDS as readonly string[]).includes(item.kind)) {
            upsert.run(userId, item.kind, item.enabled ? 1 : 0);
          }
        }
      })();
      return settings(userId);
    },
  };
}

/** Отрывок комментария для уведомления: без разметки, до 160 символов. */
export function excerptOf(markdown: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
