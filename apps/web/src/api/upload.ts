import type { Attachment, UploadRefusal, UploadSession } from "@yourtask/contracts";
import { api, ApiError } from "./client";

/**
 * Загрузка вложения частями с докачкой (R-2.24; YT-13, docs/adr/0019).
 * После обрыва связи загрузчик спрашивает сервер, сколько байт уже дошло, и продолжает с этого места;
 * сеть пропала надолго — ждёт и пробует снова (до 8 попыток подряд на одну часть).
 */
export class UploadRefusedError extends Error {
  constructor(readonly refusal: UploadRefusal) {
    super(refusal.reason);
  }
}

export interface UploadProgress {
  sent: number;
  size: number;
  /** Сколько раз продолжали после обрыва. */
  resumed: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function uploadFile(
  ticketKey: string,
  file: File,
  onProgress: (progress: UploadProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<Attachment> {
  let session: UploadSession;
  try {
    session = await api<UploadSession>(`/api/v1/tickets/${encodeURIComponent(ticketKey)}/uploads`, {
      method: "POST",
      body: JSON.stringify({ name: file.name, size: file.size }),
    });
  } catch (error) {
    const refusal =
      error instanceof ApiError ? (error.problem as { refusal?: UploadRefusal } | undefined)?.refusal : undefined;
    if (refusal) throw new UploadRefusedError(refusal);
    throw error;
  }
  let offset = session.offset;
  let resumed = 0;
  let failures = 0;
  onProgress({ sent: offset, size: file.size, resumed });
  while (offset < file.size) {
    if (signal?.aborted) {
      await api(`/api/v1/uploads/${session.id}`, { method: "DELETE" }).catch(() => undefined);
      throw new DOMException("Upload cancelled", "AbortError");
    }
    try {
      session = await api<UploadSession>(`/api/v1/uploads/${session.id}?offset=${offset}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file.slice(offset, offset + session.chunkSize),
      });
      offset = session.offset;
      failures = 0;
      onProgress({ sent: offset, size: file.size, resumed });
      if (session.attachment) return session.attachment;
    } catch (error) {
      // Ответ сервера по существу (тип не тот, лимит) — сразу наверх.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 409) throw error;
      failures += 1;
      if (failures > 8) throw error;
      await wait(Math.min(8000, 500 * 2 ** (failures - 1)));
      // Связь вернулась: где остановились по мнению сервера?
      try {
        offset = (await api<UploadSession>(`/api/v1/uploads/${session.id}`)).offset;
        resumed += 1;
        onProgress({ sent: offset, size: file.size, resumed });
      } catch {
        // Ещё нет связи — следующая попытка.
      }
    }
  }
  throw new Error("The upload ended without a file");
}
