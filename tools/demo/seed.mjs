// Наполняет демо сценариями YT-08…YT-16 в «Производстве» от имени суперадмина (через API, как интерфейс).
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const executablePath = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ baseURL: "http://localhost:3300", locale: "ru-RU" });
await page.goto("/login");
await page.getByRole("link", { name: "Войти по логину и паролю" }).click();
await page.getByLabel("Логин / Login").fill("admin");
await page.getByLabel("Пароль / Password").fill("yourspace");
await page.getByRole("button", { name: "Войти / Sign in" }).click();
await page.getByLabel("Код / Code").fill("123456");
await page.getByRole("button", { name: "Подтвердить / Verify" }).click();
await page.getByRole("heading", { name: "Пространства" }).waitFor();

const api = (method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const me = await (await fetch("/api/v1/me")).json();
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json", "x-yourtask-csrf": me.csrfToken },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text}`);
      return text ? JSON.parse(text) : null;
    },
    { method, path, body },
  );

const people = (await api("GET", "/api/v1/people")).items;
const who = (login) => people.find((person) => person.catalog?.username === login);
const toads = await api("POST", "/api/v1/feature-teams", { name: "Жабы", key: "Frogs", memberIds: [who("anna").id] });
const pigs = await api("POST", "/api/v1/feature-teams", { name: "Хрюшки", key: "Pigs" });
const gd = await api("POST", "/api/v1/guilds", {
  name: "ГД",
  key: "GD",
  leadId: who("ben").id,
  memberIds: [who("ben").id],
});
const types = (await api("GET", "/api/v1/ticket-types")).items;
const type = (key) => types.find((item) => item.key === key).id;
const make = (title, key, extra = {}) =>
  api("POST", "/api/v1/tickets", { spaceId: "space-production", typeId: type(key), title, ...extra });
const patch = async (ticket, body) => {
  const fresh = await api("GET", `/api/v1/tickets/${ticket.key}`);
  return api("PATCH", `/api/v1/tickets/${ticket.key}`, { version: fresh.version, ...body });
};
const move = async (ticket, name) => {
  const fresh = await api("GET", `/api/v1/tickets/${ticket.key}`);
  const scheme = await api("GET", `/api/v1/ticket-types/${fresh.typeId}/scheme?spaceId=${fresh.spaceId}`);
  const status = scheme.statuses.find((item) => item.name === name);
  const outcome = status.outcomes.find((item) => item !== "cancelled");
  return api("POST", `/api/v1/tickets/${ticket.key}/transition`, {
    version: fresh.version,
    statusId: status.id,
    ...(outcome ? { outcome } : {}),
  });
};

// YT-09/10/11: цель → эпик → стори → задачи; стори под двумя эпиками; пункт-ребёнок; свёртки.
const combat = await make("Боевая система", "epic");
await patch(combat, { values: { team: toads.id } });
await make("Альфа к марту", "goal", { childKey: combat.key });
const ui = await make("Интерфейс боя", "epic");
const story = await make("Переключение персонажа в бою", "story", { parentKey: combat.key });
await api("POST", `/api/v1/tickets/${story.key}/parents`, { parentKey: ui.key });
const combo = await make("Комбо при переключении героя", "story", { parentKey: combat.key });
const camera = await make("Скрипт смены камеры", "task", { parentKey: story.key });
const sound = await make("Звук смены героя", "task", { parentKey: story.key });
await patch(story, {
  values: { team: toads.id, stream: [gd.id] },
  priority: "high",
  description: "## Задача\nИгрок в бою переключается между героями партии **без паузы**.",
  checklist: [
    { text: "Переключение не сбивает текущее действие героя", done: true },
    { text: "Состояние героя сохраняется при смене", done: true },
    { text: "Переключение доступно с геймпада", done: false },
    { text: "Скрипт смены камеры", done: false, childKey: camera.key },
  ],
});
await patch(camera, { startDate: "2026-11-03", endDate: "2026-11-14" });
await patch(sound, { startDate: "2026-11-10", endDate: "2026-11-21" });
await move(sound, "Creation");
await move(sound, "Done");

// YT-08: тикет стрима ГД в чужой команде; эпик «только заголовок»; Дирекция; онбординг с ребёнком в Дирекции.
const scenario = await make("Сценарий боя с боссом", "story");
await patch(scenario, { values: { team: pigs.id, stream: [gd.id] } });
const secret = await make("Секретный эпик: сиквел", "epic");
await make("Сюжет второй части", "task", { parentKey: secret.key });
const hidden = await api("GET", `/api/v1/tickets/${secret.key}`);
await api("PUT", `/api/v1/tickets/${secret.key}/visibility`, {
  version: hidden.version,
  visibility: "title_only",
  allow: [],
});
await api("POST", "/api/v1/tickets", {
  spaceId: "space-direction",
  typeId: type("task"),
  title: "Бюджет студии на 2027",
});
const onboarding = await api("POST", "/api/v1/tickets", {
  spaceId: "space-core",
  typeId: type("task"),
  title: "Онбординг Веры",
});
await api("POST", "/api/v1/tickets", {
  spaceId: "space-direction",
  typeId: type("task"),
  title: "Договор с Верой",
  parentKey: onboarding.key,
});

// YT-11: поток из 10 шагов и две вставки перед пятым.
const release = await make("Поток релиза", "epic");
const steps = [];
for (let index = 1; index <= 10; index += 1) steps.push(await make(`Шаг ${index}`, "task", { parentKey: release.key }));
await make("Срочный фикс", "task", { parentKey: release.key, beforeKey: steps[4].key });
await make("Ревью", "task", { parentKey: release.key, beforeKey: steps[4].key });

// YT-12: стори блокирует «Комбо», баг вызван стори, ссылки на ГДД, ТехГДД и внешний референс.
const linkTypes = (await api("GET", "/api/v1/link-types")).items;
const linkType = (key) => linkTypes.find((item) => item.key === key).id;
await api("POST", `/api/v1/tickets/${story.key}/links`, { typeId: linkType("blocks"), targetKey: combo.key });
const bug = await make("Камера дёргается при переключении", "bug");
await api("POST", `/api/v1/tickets/${bug.key}/links`, {
  typeId: linkType("causes"),
  targetKey: story.key,
  direction: "in",
});
for (const url of [
  "http://localhost:3300/dev/yourwiki/documents/gdd-combat",
  "http://localhost:3300/dev/yourwiki/documents/tech-camera",
  "http://localhost:3300/dev/pages/reference",
]) {
  await api("POST", `/api/v1/tickets/${story.key}/web-links`, { url });
}

// YT-13: настоящий скриншот (PNG) и запись бага (WebM, 3 с) — рисуются в браузере, без внешних файлов.
const media = await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  const frame = (shift) => {
    context.fillStyle = "#101820";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#4f9cf9";
    context.fillRect(260 + shift, 140, 120, 80);
    context.fillStyle = "#ffffff";
    context.font = "24px sans-serif";
    context.fillText("Камера дёргается при смене героя", 120, 60);
  };
  frame(0);
  const png = new Uint8Array(await (await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))).arrayBuffer());
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start(200);
  for (let index = 0; index < 90; index += 1) {
    frame(index % 10 < 5 ? 0 : 18);
    await new Promise((resolve) => setTimeout(resolve, 33));
  }
  recorder.stop();
  await stopped;
  const webm = new Uint8Array(await new Blob(chunks).arrayBuffer());
  return { png: [...png], webm: [...webm] };
});
const attach = (key, name, bytes) =>
  page.evaluate(
    async ({ key, name, bytes }) => {
      const me = await (await fetch("/api/v1/me")).json();
      const headers = { "x-yourtask-csrf": me.csrfToken };
      const data = new Uint8Array(bytes);
      const start = await fetch(`/api/v1/tickets/${key}/uploads`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name, size: data.length }),
      }).then((response) => response.json());
      let session = start;
      while (!session.attachment) {
        session = await fetch(`/api/v1/uploads/${start.id}?offset=${session.offset}`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: data.slice(session.offset, session.offset + start.chunkSize),
        }).then((response) => response.json());
      }
      return session.attachment;
    },
    { key, name, bytes },
  );
await attach(bug.key, "скриншот камеры.png", media.png);
const recording = await attach(bug.key, "запись бага.webm", media.webm);
await patch(bug, { description: `Камера дёргается при смене героя.\n\n![запись бага.webm](${recording.url})` });

// YT-14: «Прототип боя» с тремя детьми — для показа удаления; «Старый прототип» уже очищен: у детей след.
const prototype = await make("Прототип боя", "epic");
for (const title of ["Скрипт камеры прототипа", "Анимация смены героя", "Звук прототипа"]) {
  await make(title, "story", { parentKey: prototype.key });
}
const old = await make("Старый прототип боя", "epic");
for (const title of ["Черновик интерфейса боя", "Черновик комбо"]) await make(title, "story", { parentKey: old.key });
await api("POST", "/api/v1/tickets/trash", { keys: [old.key], children: "keep" });
await api("POST", "/api/v1/trash/purge", { keys: [old.key] });
const draft = await make("Черновик баланса", "task");
await api("POST", "/api/v1/tickets/trash", { keys: [draft.key] });

// YT-15: личный фильтр админа — пример запроса; общий фильтр в показе сохраняет лид.
await api("POST", "/api/v1/filters", { name: "Просроченные", query: "due < today() and statusCategory != done" });

// YT-16: доски. Мир макетов: Жабы (родители «Боевая система» и «Интерфейс боя»), Хрюшки, Ящеры, колодцы ГД, Код, Арт.
const lizards = await api("POST", "/api/v1/feature-teams", { name: "Ящеры", key: "Lizards" });
const guilds = (await api("GET", "/api/v1/guilds")).items;
const guild = async (name, key) => {
  const found = guilds.find((item) => item.name === name || item.key === key);
  return found ? api("PATCH", `/api/v1/guilds/${found.id}`, { key }) : api("POST", "/api/v1/guilds", { name, key });
};
const code = await guild("Код", "Code");
const art = await guild("Арт", "Art");
const day = (shift) => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
const statuses = [];
const card = async (title, kind, { parents = [], team, streams = [], status, assignees = [], due } = {}) => {
  const [first, ...others] = parents;
  const ticket = await make(title, kind, first ? { parentKey: first.key } : {});
  for (const parent of others) await api("POST", `/api/v1/tickets/${ticket.key}/parents`, { parentKey: parent.key });
  await patch(ticket, {
    values: { ...(team ? { team: team.id } : {}), ...(streams.length ? { stream: streams.map((g) => g.id) } : {}) },
    ...(assignees.length ? { people: { assigneeIds: assignees.map((login) => who(login).id) } } : {}),
    ...(due ? { endDate: due } : {}),
  });
  if (status) statuses.push([ticket.key, status]);
  return ticket;
};
await patch(ui, { values: { team: toads.id } });
await patch(story, { people: { assigneeIds: [who("anna").id] }, endDate: day(5) });
statuses.push([story.key, "Creation"]);
await patch(combo, { values: { team: toads.id, stream: [gd.id] } });
await patch(camera, { values: { team: toads.id, stream: [code.id] }, people: { assigneeIds: [who("anna").id] } });
statuses.push([camera.key, "Creation"]);
await patch(bug, { values: { team: toads.id, stream: [code.id] }, people: { assigneeIds: [who("ben").id] } });
statuses.push([bug.key, "Test"]);
await card("Баланс урона партии", "story", {
  parents: [combat],
  team: toads,
  streams: [gd, code],
  status: "Discovery",
  assignees: ["ben"],
});
await card("Агро врагов при смене героя", "story", {
  parents: [combat],
  team: toads,
  streams: [gd],
  status: "Analysis",
  assignees: ["ben"],
});
await card("Базовая атака ближнего боя", "story", { parents: [combat], team: toads, streams: [gd], status: "Done" });
await card("Подсказки управления партией", "story", { parents: [ui], team: toads, streams: [gd] });
await card("Индикатор активного героя", "story", {
  parents: [ui],
  team: toads,
  streams: [art],
  status: "To Do",
  assignees: ["anna"],
  due: day(9),
});
await card("HUD: портреты партии", "story", {
  parents: [ui],
  team: toads,
  streams: [art, code],
  status: "Implementation",
  assignees: ["anna"],
  due: day(-2),
});
await card("Иконки состояний героев", "task", {
  parents: [ui],
  team: toads,
  streams: [art],
  status: "Creation",
  assignees: ["ben"],
  due: day(3),
});
await card("Финализация HUD", "story", { parents: [ui], team: toads, streams: [gd], status: "Done" });
await card("Лут сундуков в локации", "task", { team: pigs, streams: [gd], status: "To Do" });
await card("Сцена дружбы с напарником", "story", { team: pigs, streams: [gd], status: "Analysis", assignees: ["ben"] });
await card("Экономика крепости", "story", {
  team: lizards,
  streams: [gd],
  status: "Discovery Done",
  assignees: ["ben"],
});
await card("Таблица наград квестов", "task", {
  team: lizards,
  streams: [code],
  status: "Creation",
  assignees: ["ben"],
});
await card("Правила дружбы напарников: черновик", "request", { streams: [gd] });
await card("Правки ГДД: интерфейс партии", "task", { streams: [gd], status: "Creation", assignees: ["ben"] });
// YT-17: срочная дорожка сверху и чип «Только люди колодца ГД» на доске лида.
const urgent = await card("Краш при смене героя в бою", "bug", {
  team: pigs,
  streams: [gd],
  status: "Implementation",
  assignees: ["ben"],
});
await patch(urgent, { priority: "highest" });
// Статусы — прямо в базе демо: условия входа (YT-05) здесь не предмет показа, а журнал не нужен.
const { default: Database } = await import("better-sqlite3");
const db = new Database(new URL("./data/yourtask.db", import.meta.url).pathname);
db.pragma("busy_timeout = 5000");
for (const [key, name] of statuses) {
  const row = db
    .prepare(
      `SELECT s.id, s.category FROM tickets t JOIN status_schemes sc ON sc.type_id = t.type_id AND sc.space_id IS NULL
       JOIN scheme_statuses s ON s.scheme_id = sc.id AND s.name = ? WHERE t.key = ?`,
    )
    .get(name, key);
  db.prepare(
    "UPDATE tickets SET status_id = ?, outcome = ?, status_changed_at = ?, version = version + 1 WHERE key = ?",
  ).run(row.id, row.category === "done" ? "done" : null, Date.now(), key);
}
db.close();
const frogsBoard = await api("POST", "/api/v1/boards", {
  name: "Жабы",
  query: "team = Frogs or involvedTeams = Frogs",
  spaceId: "space-production",
  lanes: "parent",
  sort: "manual",
  chips: ["stream", "type"],
});
await api("PUT", `/api/v1/boards/${frogsBoard.id}/zones`, {
  zones: frogsBoard.zones.map((zone) => (zone.id === "Production" ? { ...zone, wipLimit: 3 } : zone)),
});
for (const [name, key] of [
  ["Хрюшки", "Pigs"],
  ["Ящеры", "Lizards"],
]) {
  await api("POST", "/api/v1/boards", { name, query: `team = ${key}`, spaceId: "space-production", lanes: "parent" });
}
const leadBoard = await api("POST", "/api/v1/boards", {
  name: "Лид ГД",
  query: "stream = GD or assignee.guild = GD",
  spaceId: "space-production",
  lanes: "team",
  chips: ["team", "type"],
  tqlLanes: [{ id: "urgent", name: "Срочно", query: "priority = Urgent" }],
  tqlChips: [{ id: "gd-people", name: "Только люди колодца ГД", query: "assignee.guild = GD" }],
});

// YT-18: Бен — ПМ Жаб, Анна наблюдает за ключевыми тикетами: смена статуса ПМом зажжёт её колокольчик.
await api("PATCH", `/api/v1/feature-teams/${toads.id}`, { pmId: who("ben").id, memberIds: [who("anna").id] });
for (const ticket of [story, camera, bug]) {
  const fresh = await api("GET", `/api/v1/tickets/${ticket.key}`);
  await api("PATCH", `/api/v1/tickets/${ticket.key}`, {
    version: fresh.version,
    people: { watcherIds: [who("anna").id] },
  });
}

console.log(
  JSON.stringify({
    frogsBoard: frogsBoard.id,
    leadBoard: leadBoard.id,
    story: story.key,
    combat: combat.key,
    release: release.key,
    bug: bug.key,
    secret: secret.key,
    prototype: prototype.key,
    purged: old.key,
  }),
);
await browser.close();
