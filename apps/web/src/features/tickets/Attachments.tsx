import { DownloadSimple, FileText, Paperclip, TextAlignLeft, Trash } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { checkUpload, type Attachment, type Ticket, type UploadRefusal } from "@yourtask/contracts";
import { ApiError } from "../../api/client";
import {
  attachmentKeys,
  ticketKeys,
  useAttachmentSettings,
  useAttachments,
  useDeleteAttachment,
  useUpdateTicket,
} from "../../api/hooks";
import { uploadFile, UploadRefusedError } from "../../api/upload";
import { Button, Card } from "../../components/ui";
import { useI18n } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";

/** «12,4 МБ» — размер по-человечески. */
export function formatSize(bytes: number, locale: string) {
  const units = locale === "ru" ? ["Б", "КБ", "МБ", "ГБ", "ТБ"] : ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 && unit ? 1 : 0 })} ${units[unit]}`;
}

/** Вставка вложения в Markdown: картинка и видео показываются в тексте, документ — ссылкой. */
export const attachmentMarkdown = (attachment: Pick<Attachment, "name" | "url" | "group">) =>
  attachment.group === "document"
    ? `[${attachment.name}](${attachment.url})`
    : `![${attachment.name}](${attachment.url})`;

interface Upload {
  id: string;
  name: string;
  sent: number;
  size: number;
  resumed: number;
  error: string | null;
}

/** Загрузки тикета: проверка до начала, части с докачкой, понятные ошибки (R-2.24, R-3.3). */
export function useTicketUploads(ticketKey: string) {
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const client = useQueryClient();
  const settings = useAttachmentSettings();
  const attachments = useAttachments(ticketKey);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const patch = (id: string, change: Partial<Upload>) =>
    setUploads((list) => list.map((item) => (item.id === id ? { ...item, ...change } : item)));

  const refusalText = (refusal: UploadRefusal, name: string) => {
    const size = (bytes: number) => formatSize(bytes, locale);
    switch (refusal.reason) {
      case "type":
        return t("attachments.refused.type", {
          name,
          kind: refusal.kind || "?",
          allowed: (settings.data?.allowed ?? []).join(", "),
        });
      case "file_size":
        return t("attachments.refused.file", { name, limit: size(refusal.limit) });
      case "ticket_size":
        return t("attachments.refused.ticket", {
          name,
          free: size(Math.max(0, refusal.limit - refusal.used)),
          limit: size(refusal.limit),
        });
      case "space_size":
        return t("attachments.refused.space", { name, limit: size(refusal.limit) });
    }
  };

  async function add(files: File[]): Promise<Attachment[]> {
    const done: Attachment[] = [];
    let used = (attachments.data?.items ?? []).reduce((sum, item) => sum + item.size, 0);
    for (const file of files) {
      const id = crypto.randomUUID();
      setUploads((list) => [...list, { id, name: file.name, sent: 0, size: file.size, resumed: 0, error: null }]);
      // Проверка до начала загрузки — по тем же правилам, что на сервере.
      const refusal = settings.data ? checkUpload(settings.data, file, { ticket: used, space: 0 }) : null;
      if (refusal) {
        patch(id, { error: refusalText(refusal, file.name) });
        continue;
      }
      try {
        const attachment = await uploadFile(ticketKey, file, (progress) => patch(id, progress));
        used += attachment.size;
        done.push(attachment);
        setUploads((list) => list.filter((item) => item.id !== id));
      } catch (error) {
        patch(id, {
          error:
            error instanceof UploadRefusedError
              ? refusalText(error.refusal, file.name)
              : error instanceof ApiError && error.code === "file_type_mismatch"
                ? t("attachments.refused.mismatch", { name: file.name })
                : errorText(error),
        });
      }
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: attachmentKeys.list(ticketKey) }),
      client.invalidateQueries({ queryKey: ticketKeys.history(ticketKey) }),
    ]);
    return done;
  }

  return { uploads, add, dismiss: (id: string) => setUploads((list) => list.filter((item) => item.id !== id)) };
}

export function UploadRow({ upload, onDismiss }: { upload: Upload; onDismiss(): void }) {
  const { t, locale } = useI18n();
  if (upload.error) return <Notice error={upload.error} onDismiss={onDismiss} />;
  const percent = upload.size ? Math.round((upload.sent / upload.size) * 100) : 0;
  return (
    <div className="upload-row" role="status">
      <span>
        {upload.name} · {formatSize(upload.sent, locale)} / {formatSize(upload.size, locale)}
        {upload.resumed ? ` · ${t("attachments.resumed", { count: upload.resumed })}` : ""}
      </span>
      <div aria-label={upload.name} aria-valuenow={percent} className="progress__track" role="progressbar">
        <span className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Файлы, перетащенные или вставленные из буфера. */
export const filesFrom = (data: DataTransfer | null) => [...(data?.files ?? [])];

/**
 * Блок «Вложения» (R-2.24): перетаскивание и вставка из буфера, превью картинок и видео,
 * «В описание», удаление по правам. Загрузка и удаление попадают в историю.
 */
export function AttachmentsCard({ ticket }: { ticket: Ticket }) {
  const { t, locale } = useI18n();
  const attachments = useAttachments(ticket.key);
  const settings = useAttachmentSettings();
  const remove = useDeleteAttachment(ticket.key);
  const update = useUpdateTicket(ticket.key);
  const errorText = useErrorText();
  const { uploads, add, dismiss } = useTicketUploads(ticket.key);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const canUpload = ticket.permissions.comment;

  // Вставка из буфера на странице тикета, когда курсор не в поле ввода (там вставку обрабатывает само поле).
  useEffect(() => {
    if (!canUpload) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const files = filesFrom(event.clipboardData);
      if (files.length) {
        event.preventDefault();
        void add(files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (canUpload) void add(filesFrom(event.dataTransfer));
  };
  const items = attachments.data?.items ?? [];
  const hint = settings.data
    ? t("attachments.hint", {
        size: formatSize(settings.data.maxFileBytes, locale),
        types: settings.data.allowed.join(", "),
      })
    : "";

  return (
    <Card className="ticket-section">
      <section
        aria-label={t("attachments.title")}
        className={`attachments ${over ? "attachments--over" : ""}`}
        onDragLeave={() => setOver(false)}
        onDragOver={(event) => {
          if (!canUpload) return;
          event.preventDefault();
          setOver(true);
        }}
        onDrop={onDrop}
      >
        <div className="ticket-section__head">
          <h2>{t("attachments.title")}</h2>
          {canUpload ? (
            <>
              <Button onClick={() => input.current?.click()} variant="secondary">
                <Paperclip aria-hidden="true" size={16} /> {t("attachments.attach")}
              </Button>
              <input
                aria-label={t("attachments.attach")}
                className="visually-hidden"
                multiple
                onChange={(event) => {
                  void add([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
                ref={input}
                type="file"
              />
            </>
          ) : null}
        </div>
        {canUpload ? <p className="ui-field__hint">{hint}</p> : null}
        <Notice
          error={remove.isError ? errorText(remove.error) : update.isError ? errorText(update.error) : null}
          onDismiss={() => {
            remove.reset();
            update.reset();
          }}
        />
        {uploads.map((upload) => (
          <UploadRow key={upload.id} onDismiss={() => dismiss(upload.id)} upload={upload} />
        ))}
        {items.length ? (
          <ul className="attachment-grid">
            {items.map((item) => (
              <li className="attachment" key={item.id}>
                {item.group === "image" ? (
                  <a href={item.url} rel="noopener" target="_blank">
                    <img alt={item.name} className="attachment__preview" loading="lazy" src={item.url} />
                  </a>
                ) : item.group === "video" ? (
                  <video
                    aria-label={item.name}
                    className="attachment__preview"
                    controls
                    preload="metadata"
                    src={item.url}
                  />
                ) : (
                  <span className="attachment__doc">
                    <FileText aria-hidden="true" size={32} />
                  </span>
                )}
                <span className="attachment__name">{item.name}</span>
                <span className="ui-field__hint">
                  {formatSize(item.size, locale)} · {item.uploadedBy?.name ?? "—"}
                </span>
                <span className="attachment__actions">
                  <a
                    aria-label={t("attachments.download", { name: item.name })}
                    className="ui-icon-button"
                    href={`${item.url}?download=1`}
                  >
                    <DownloadSimple aria-hidden="true" size={16} />
                  </a>
                  {ticket.permissions.edit ? (
                    <Button
                      aria-label={t("attachments.toDescription", { name: item.name })}
                      loading={Boolean(update.isPending && update.variables?.description?.includes(item.url))}
                      onClick={() =>
                        update.mutate({
                          version: ticket.version,
                          description: `${ticket.description.trimEnd()}\n\n${attachmentMarkdown(item)}\n`.trimStart(),
                        })
                      }
                      variant="ghost"
                    >
                      <TextAlignLeft aria-hidden="true" size={16} />
                    </Button>
                  ) : null}
                  {item.canDelete ? (
                    <Button
                      aria-label={t("attachments.delete", { name: item.name })}
                      loading={remove.isPending && remove.variables === item.id}
                      onClick={() => remove.mutate(item.id)}
                      variant="ghost"
                    >
                      <Trash aria-hidden="true" size={16} />
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : attachments.isPending ? null : (
          <p className="ui-field__hint">{canUpload ? t("attachments.emptyDrop") : t("attachments.empty")}</p>
        )}
      </section>
    </Card>
  );
}
