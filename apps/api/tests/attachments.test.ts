import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  Attachment,
  AttachmentSettings,
  HistoryEntry,
  Ticket,
  TicketType,
  UploadSession,
} from "@yourtask/contracts";
import { createTestApp, csrf, signIn, type Client } from "./helpers.js";

/** YT-13: вложения через API. */
let app: FastifyInstance;
let admin: Client;
afterEach(async () => app?.close());
beforeEach(async () => {
  app = await createTestApp();
  admin = (await signIn(app, { login: "admin" })).user;
});

type Body<T> = T & { code?: string; refusal?: { reason: string }; offset?: number };
async function send<T>(
  user: Client,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await user.request(method, url, body, { ...(await csrf(user)), ...headers });
  return { status: response.statusCode, body: (response.body ? response.json() : undefined) as Body<T> };
}
const get = async <T>(user: Client, url: string) => (await user.request("GET", url)).json() as T;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
/** «Видео» MP4: сигнатура ftyp и заданный размер. */
const mp4 = (size: number) => {
  const data = Buffer.alloc(size, 1);
  data.write("ftypisom", 4, "latin1");
  return data;
};

async function ticket(space = "space-production", title = "Камера дёргается") {
  const types = (await get<{ items: TicketType[] }>(admin, "/api/v1/ticket-types")).items;
  const typeId = (types.find((item) => item.key === "bug") as TicketType).id;
  return (await send<Ticket>(admin, "POST", "/api/v1/tickets", { spaceId: space, typeId, title })).body;
}

const chunk = (user: Client, id: string, offset: number, data: Buffer) =>
  send<UploadSession>(user, "PUT", `/api/v1/uploads/${id}?offset=${offset}`, data, {
    "content-type": "application/octet-stream",
  });

async function upload(user: Client, key: string, name: string, data: Buffer) {
  const started = await send<UploadSession>(user, "POST", `/api/v1/tickets/${key}/uploads`, {
    name,
    size: data.length,
  });
  if (started.status !== 201) return started;
  let offset = 0;
  let last = started;
  while (offset < data.length) {
    last = await chunk(user, started.body.id, offset, data.subarray(offset, offset + started.body.chunkSize));
    if (last.status !== 200) return last;
    offset = last.body.offset;
  }
  return last;
}

describe("attachments (R-2.24)", () => {
  test("a screenshot is attached, listed, shown inline with safe headers and recorded in the history; deleting too", async () => {
    const bug = await ticket();
    const done = await upload(admin, bug.key, "../../скриншот <камера>.png", PNG);
    expect(done.status).toBe(200);
    const attachment = done.body.attachment as Attachment;
    expect(attachment).toMatchObject({ name: "скриншот камера.png", kind: "png", group: "image", size: PNG.length });

    const file = await admin.request("GET", attachment.url);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(file.headers["content-disposition"]).toMatch(/^inline;/);
    expect(file.rawPayload.equals(PNG)).toBe(true);

    expect((await get<{ items: Attachment[] }>(admin, `/api/v1/tickets/${bug.key}/attachments`)).items).toHaveLength(1);
    expect((await send(admin, "DELETE", attachment.url)).status).toBe(204);
    expect((await admin.request("GET", attachment.url)).statusCode).toBe(404);
    const history = (await get<{ items: HistoryEntry[] }>(admin, `/api/v1/tickets/${bug.key}/history`)).items.filter(
      (entry) => entry.field === "attachments",
    );
    expect(history.map((entry) => [entry.from?.text ?? null, entry.to?.text ?? null])).toEqual([
      ["скриншот камера.png", null],
      [null, "скриншот камера.png"],
    ]);
  });

  test("a big video uploads in chunks and continues from the break after a lost connection; it plays with Range", async () => {
    const bug = await ticket();
    const video = mp4(9 * 1024 * 1024 + 123);
    const started = await send<UploadSession>(admin, "POST", `/api/v1/tickets/${bug.key}/uploads`, {
      name: "запись бага.mp4",
      size: video.length,
    });
    const { id, chunkSize } = started.body;
    expect((await chunk(admin, id, 0, video.subarray(0, chunkSize))).body.offset).toBe(chunkSize);
    // Обрыв: клиент не знает, дошла ли вторая часть, и спрашивает сервер.
    expect((await get<UploadSession>(admin, `/api/v1/uploads/${id}`)).offset).toBe(chunkSize);
    // Повтор с неверного места — 409 и место, откуда продолжать.
    const wrong = await chunk(admin, id, 0, video.subarray(0, chunkSize));
    expect(wrong.status).toBe(409);
    expect(wrong.body.offset).toBe(chunkSize);
    let offset = chunkSize;
    let last = wrong;
    while (offset < video.length) {
      last = await chunk(admin, id, offset, video.subarray(offset, offset + chunkSize));
      offset = last.body.offset;
    }
    const attachment = last.body.attachment as Attachment;
    expect(attachment).toMatchObject({ kind: "mp4", group: "video", size: video.length });
    const part = await admin.request("GET", attachment.url, undefined, { range: "bytes=4-11" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 4-11/${video.length}`);
    expect(part.body).toBe("ftypisom");
  });

  test("too big or a forbidden type is refused before the upload starts, with a clear reason, not 413", async () => {
    const bug = await ticket();
    const settings = await get<AttachmentSettings>(admin, "/api/v1/attachment-settings");
    const big = await send(admin, "POST", `/api/v1/tickets/${bug.key}/uploads`, {
      name: "огромное.mp4",
      size: settings.maxFileBytes + 1,
    });
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({
      code: "upload_refused",
      refusal: { reason: "file_size", limit: settings.maxFileBytes },
    });
    const exe = await send(admin, "POST", `/api/v1/tickets/${bug.key}/uploads`, { name: "setup.exe", size: 10 });
    expect(exe.body.refusal).toMatchObject({ reason: "type" });
    const svg = await send(admin, "POST", `/api/v1/tickets/${bug.key}/uploads`, { name: "logo.svg", size: 10 });
    expect(svg.body.refusal).toMatchObject({ reason: "type" });
  });

  test("a file with a forged extension is refused at the first chunk", async () => {
    const bug = await ticket();
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const forged = await upload(admin, bug.key, "картинка.png", html);
    expect(forged.status).toBe(422);
    expect(forged.body.code).toBe("file_type_mismatch");
    const text = await upload(admin, bug.key, "лог.txt", Buffer.from("<script>alert(1)</script>"));
    expect(text.body.code).toBe("file_type_mismatch");
    expect((await get<{ items: Attachment[] }>(admin, `/api/v1/tickets/${bug.key}/attachments`)).items).toEqual([]);
  });

  test("a direct link to a file without rights on the ticket is refused", async () => {
    const secret = await ticket("space-direction", "Договор");
    const done = await upload(admin, secret.key, "договор.pdf", Buffer.from("%PDF-1.7\n..."));
    const url = (done.body.attachment as Attachment).url;
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await anna.request("GET", url)).statusCode).toBe(404);
    expect((await anna.request("GET", `/api/v1/tickets/${secret.key}/attachments`)).statusCode).toBe(404);
    const anonymous = await app.inject({ method: "GET", url });
    expect(anonymous.statusCode).toBe(401);
    // Нельзя продолжить чужую загрузку.
    const started = await send<UploadSession>(admin, "POST", `/api/v1/tickets/${secret.key}/uploads`, {
      name: "a.png",
      size: PNG.length,
    });
    expect((await chunk(anna, started.body.id, 0, PNG)).status).toBe(404);
  });

  test("an admin changes the limit without a restart; members cannot", async () => {
    const bug = await ticket();
    const current = await get<AttachmentSettings>(admin, "/api/v1/attachment-settings");
    const changed = await send<AttachmentSettings>(admin, "PUT", "/api/v1/attachment-settings", {
      maxFileBytes: 1024,
      maxTicketBytes: current.maxTicketBytes,
      maxSpaceBytes: current.maxSpaceBytes,
      allowed: ["png"],
    });
    expect(changed.body).toMatchObject({ maxFileBytes: 1024, allowed: ["png"] });
    const bigPng = Buffer.concat([PNG, Buffer.alloc(2000)]);
    expect((await upload(admin, bug.key, "a.png", bigPng)).body.refusal).toMatchObject({
      reason: "file_size",
      limit: 1024,
    });
    expect((await upload(admin, bug.key, "a.png", PNG)).status).toBe(200);
    expect((await upload(admin, bug.key, "a.pdf", Buffer.from("%PDF-1"))).body.refusal).toMatchObject({
      reason: "type",
    });
    const anna = (await signIn(app, { login: "anna" })).user;
    expect((await send(anna, "PUT", "/api/v1/attachment-settings", { ...current, allowed: ["png"] })).status).toBe(403);
  });

  test("the ticket limit counts files and pending uploads", async () => {
    const bug = await ticket();
    const current = await get<AttachmentSettings>(admin, "/api/v1/attachment-settings");
    await send(admin, "PUT", "/api/v1/attachment-settings", {
      maxFileBytes: 1024,
      maxTicketBytes: 1100,
      maxSpaceBytes: current.maxSpaceBytes,
      allowed: current.allowed,
    });
    expect((await upload(admin, bug.key, "a.png", PNG)).status).toBe(200);
    const pending = await send(admin, "POST", `/api/v1/tickets/${bug.key}/uploads`, { name: "b.png", size: 700 });
    expect(pending.status).toBe(201);
    // Незавершённая загрузка тоже занимает место: третья не помещается.
    const third = await send(admin, "POST", `/api/v1/tickets/${bug.key}/uploads`, { name: "c.png", size: 300 });
    expect(third.body.refusal).toMatchObject({ reason: "ticket_size", limit: 1100 });
  });

  test("someone who only sees the ticket cannot delete another person's attachment", async () => {
    const bug = await ticket();
    const done = await upload(admin, bug.key, "a.png", PNG);
    const anna = (await signIn(app, { login: "anna" })).user;
    const listed = (await get<{ items: Attachment[] }>(anna, `/api/v1/tickets/${bug.key}/attachments`)).items;
    expect(listed[0]?.canDelete).toBe(false);
    expect((await send(anna, "DELETE", (done.body.attachment as Attachment).url)).status).toBe(403);
  });
});
