import { EventEmitter } from "node:events";
import type { Database } from "./db/index.js";

/**
 * Шина изменений тикетов для живых обновлений (R-2.18 «изменения других видны без перезагрузки», R-3.3).
 * Одна на базу: сервисы тикетов создаются в нескольких модулях, но пишут в одну базу.
 * В событии нет данных тикета — только «что-то поменялось»; клиент перечитывает то, что видит, через API с правами.
 */
const buses = new WeakMap<Database, EventEmitter>();

export function changeBus(db: Database) {
  let bus = buses.get(db);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(0);
    buses.set(db, bus);
  }
  return bus;
}

/** Сообщить о смене тикетов; userId — кто поменял (его вкладке событие не нужно, она уже знает). */
export function ticketsChanged(db: Database, userId: string | null) {
  changeBus(db).emit("tickets", { userId, at: Date.now() });
}
