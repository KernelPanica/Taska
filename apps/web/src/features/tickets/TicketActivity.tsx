import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { HistoryEntry, HistoryValue, Ticket, TicketComment } from "@yourtask/contracts";
import { useAttachments, useCommentAction, useComments, usePeople, useTicketHistory } from "../../api/hooks";
import { attachmentMarkdown, UploadRow, useTicketUploads } from "./Attachments";
import { Badge, Button, Card, Input, Select, Tabs } from "../../components/ui";
import { Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";
import { MarkdownPreview, Textarea } from "../setup/shared";

/** Вкладки «Комментарии» и «Действия» внизу карточки тикета (R-2.25, YT-07). */
export function TicketActivity({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n();
  const comments = useComments(ticket.key);
  const count = comments.data?.items.filter((comment) => !comment.deleted).length ?? 0;
  return (
    <Card className="ticket-section ticket-activity">
      <Tabs
        aria-label={t("activity.tabs")}
        tabs={[
          {
            id: "comments",
            label: t("activity.comments", { count }),
            content: <Comments items={comments.data?.items} loading={comments.isPending} ticket={ticket} />,
          },
          { id: "actions", label: t("activity.actions"), content: <Actions ticket={ticket} /> },
        ]}
      />
    </Card>
  );
}

// ---- Комментарии ----

function Comments({
  ticket,
  items,
  loading,
}: {
  ticket: Ticket;
  items: TicketComment[] | undefined;
  loading: boolean;
}) {
  const { t } = useI18n();
  if (loading) return <Loading />;
  return (
    <div className="comments">
      {items?.length ? (
        <ol className="comment-list">
          {items.map((comment) => (
            <CommentItem comment={comment} key={comment.id} ticket={ticket} />
          ))}
        </ol>
      ) : (
        <p className="ui-field__hint">{t("activity.noComments")}</p>
      )}
      <Composer ticket={ticket} />
    </div>
  );
}

/** Поле комментария с подсказкой @-упоминаний людей по логину или имени. */
export interface MentionExtra {
  /** Что ищется по набранному после @. */
  search: string;
  label: string;
  hint: string;
  /** Что вставить вместо @… */
  insert: string;
}

export function MentionTextarea({
  value,
  onChange,
  label,
  extra = [],
  rows = 3,
  hint,
  onFiles,
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  /** Кроме людей: тикеты и документы YourWiki (R-2.24). */
  extra?: MentionExtra[];
  rows?: number;
  hint?: string;
  /** Файл вставили из буфера или перетащили в поле: загрузить и вернуть Markdown для вставки (R-2.24). */
  onFiles?: (files: File[]) => Promise<string[]>;
}) {
  const { t } = useI18n();
  const people = usePeople();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const word = /(^|\s)@([\p{L}\w.-]*)$/u.exec(value.slice(0, caret));
  const query = word?.[2]?.toLocaleLowerCase("ru") ?? null;
  const suggestions =
    query === null
      ? []
      : (people.data?.items ?? [])
          .filter((person) => person.catalog?.username)
          .filter((person) => `${person.catalog?.username} ${person.name}`.toLocaleLowerCase("ru").includes(query))
          .slice(0, 6);
  const others =
    query === null ? [] : extra.filter((item) => item.search.toLocaleLowerCase("ru").includes(query)).slice(0, 6);

  function insert(login: string) {
    replaceWith(`@${login} `);
  }

  /** Загрузить файлы и вставить их Markdown там, где стоял курсор. */
  async function attach(files: File[], at: number) {
    const snippets = (await onFiles?.(files)) ?? [];
    if (!snippets.length) return;
    const text = `${snippets.join("\n")}\n`;
    const latest = ref.current?.value ?? value;
    onChange(latest.slice(0, at) + text + latest.slice(at));
    setCaret(at + text.length);
  }

  function replaceWith(text: string) {
    const before = value.slice(0, caret).replace(/@[\p{L}\w.-]*$/u, text);
    const next = before + value.slice(caret);
    onChange(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
    });
  }

  return (
    <div className="mention-field">
      <Textarea
        hint={hint ?? t("comment.hint")}
        label={label}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!onFiles || !files.length) return;
          event.preventDefault();
          void attach(files, event.currentTarget.selectionStart);
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          if (!onFiles || !files.length) return;
          event.preventDefault();
          void attach(files, event.currentTarget.selectionStart);
        }}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        ref={ref}
        rows={rows}
        value={value}
      />
      {suggestions.length || others.length ? (
        <ul aria-label={t("comment.mentionSuggest")} className="mention-suggestions">
          {suggestions.map((person) => (
            <li key={person.id}>
              <button onClick={() => insert(person.catalog?.username ?? "")} type="button">
                @{person.catalog?.username} <span className="data-table__sub">{person.name}</span>
              </button>
            </li>
          ))}
          {others.map((item) => (
            <li key={item.insert}>
              <button onClick={() => replaceWith(`${item.insert} `)} type="button">
                {item.label} <span className="data-table__sub">{item.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Composer({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [body, setBody] = useState("");
  const { uploads, add, dismiss } = useTicketUploads(ticket.key);
  const attachments = useAttachments(ticket.key);
  const create = useCommentAction<string>(ticket.key, (text) => [
    "POST",
    `/api/v1/tickets/${ticket.key}/comments`,
    { body: text },
  ]);
  return (
    <form
      className="form-stack comment-composer"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (body.trim()) create.mutate(body, { onSuccess: () => setBody("") });
      }}
    >
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <MentionTextarea
        label={t("comment.new")}
        onChange={setBody}
        onFiles={async (files) => (await add(files)).map(attachmentMarkdown)}
        value={body}
      />
      {uploads.map((upload) => (
        <UploadRow key={upload.id} onDismiss={() => dismiss(upload.id)} upload={upload} />
      ))}
      {body.trim() ? (
        <MarkdownPreview
          mentions={{ people: [], tickets: [], attachments: attachments.data?.items ?? [] }}
          source={body}
        />
      ) : null}
      <div className="page-actions">
        <Button disabled={!body.trim()} loading={create.isPending} type="submit">
          {t("comment.send")}
        </Button>
      </div>
    </form>
  );
}

function CommentItem({ comment, ticket }: { comment: TicketComment; ticket: Ticket }) {
  const { t, locale } = useI18n();
  const attachments = useAttachments(ticket.key);
  const errorText = useErrorText();
  const people = usePeople();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [making, setMaking] = useState(false);
  const [title, setTitle] = useState(
    () =>
      comment.body
        .split("\n")[0]
        ?.replace(/[#*>`]/g, "")
        .trim()
        .slice(0, 120) ?? "",
  );
  const [assigneeId, setAssigneeId] = useState("");
  const update = useCommentAction<string>(ticket.key, (body) => ["PATCH", `/api/v1/comments/${comment.id}`, { body }]);
  const remove = useCommentAction<void>(ticket.key, () => ["DELETE", `/api/v1/comments/${comment.id}`]);
  const make = useCommentAction<{ title: string; assigneeId: string | null }, { ticketKey: string }>(
    ticket.key,
    (input) => ["POST", `/api/v1/comments/${comment.id}/make-ticket`, input],
  );
  const error = update.error ?? remove.error ?? make.error;

  return (
    <li className="comment" id={`comment-${comment.id}`}>
      <p className="comment__meta">
        <strong>{comment.authorName}</strong>
        <span className="ui-field__hint">
          {new Date(comment.createdAt).toLocaleString(locale)}
          {comment.editedAt ? ` · ${t("comment.edited")}` : ""}
        </span>
      </p>
      {error ? (
        <Notice error={errorText(error)} onDismiss={() => [update, remove, make].forEach((m) => m.reset())} />
      ) : null}
      {comment.deleted ? (
        <p className="ui-field__hint">{t("comment.deleted")}</p>
      ) : editing ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(text, { onSuccess: () => setEditing(false) });
          }}
        >
          <MentionTextarea label={t("comment.edit")} onChange={setText} value={text} />
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("comment.save")}
            </Button>
            <Button onClick={() => setEditing(false)} variant="secondary">
              {t("comment.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <MarkdownPreview
          mentions={{ ...comment.mentions, attachments: attachments.data?.items ?? [] }}
          source={comment.body}
        />
      )}
      {comment.createdTicket ? (
        <p className="comment__task">
          <Link to={`/tickets/${comment.createdTicket.key}`}>
            {t("comment.task", { key: comment.createdTicket.key })}
          </Link>{" "}
          {comment.createdTicket.title}{" "}
          {comment.createdTicket.statusName ? (
            <Badge variant={comment.createdTicket.category === "done" ? "success" : "info"}>
              {comment.createdTicket.statusName}
            </Badge>
          ) : null}
        </p>
      ) : null}
      {!comment.deleted && !editing ? (
        <div className="comment__actions">
          {comment.canEdit ? (
            <Button
              onClick={() => {
                setText(comment.body);
                setEditing(true);
              }}
              variant="ghost"
            >
              {t("comment.edit")}
            </Button>
          ) : null}
          {comment.canDelete ? (
            <Button
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(t("comment.deleteConfirm"))) remove.mutate();
              }}
              variant="ghost"
            >
              {t("comment.delete")}
            </Button>
          ) : null}
          {!comment.createdTicket ? (
            <Button onClick={() => setMaking(!making)} variant="ghost">
              {t("comment.makeTicket")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {making && !comment.createdTicket ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            make.mutate({ title, assigneeId: assigneeId || null }, { onSuccess: () => setMaking(false) });
          }}
        >
          <Input
            label={t("comment.taskTitle")}
            maxLength={500}
            onChange={(e) => setTitle(e.target.value)}
            required
            value={title}
          />
          <Select label={t("comment.taskAssignee")} onChange={(e) => setAssigneeId(e.target.value)} value={assigneeId}>
            <option value="">{t("ticket.nobody")}</option>
            {(people.data?.items ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
          <Button loading={make.isPending} type="submit">
            {t("comment.create")}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

// ---- Действия ----

function Actions({ ticket }: { ticket: Ticket }) {
  const { t, locale } = useI18n();
  const history = useTicketHistory(ticket.key);
  const describe = useDescribe();
  if (history.isPending) return <Loading />;
  const items = history.data?.items ?? [];
  return (
    <div className="actions-log">
      {items.length === 0 ? <p className="ui-field__hint">{t("activity.noActions")}</p> : null}
      <ol className="history-list">
        {items.map((entry) => (
          <li key={entry.id}>
            <span className="history-list__when">
              {new Date(entry.at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })} ·{" "}
              {entry.source === "person"
                ? (entry.actor?.name ?? entry.actorName ?? "—")
                : t(`history.source.${entry.source}` as MessageKey)}
              {entry.source !== "person" && entry.sourceDetail === "rollup" ? ` · ${t("history.rollup")}` : ""}
              {entry.source !== "person" && entry.sourceDetail?.startsWith("number:")
                ? ` · ${t("history.renumber")}`
                : ""}
            </span>
            <span className="history-list__what">{describe(entry)}</span>
          </li>
        ))}
      </ol>
      {ticket.permissions.export ? (
        <a className="ui-field__hint" download href={`/api/v1/tickets/${ticket.key}/status-history?format=csv`}>
          {t("history.export")}
        </a>
      ) : null}
    </div>
  );
}

/** «Поле: было → стало» человеческим языком. Значения — снимок на момент изменения. */
function useDescribe() {
  const { t, locale } = useI18n();
  const label = (entry: HistoryEntry) =>
    entry.field.startsWith("values.")
      ? (entry.fieldLabel ?? entry.field.slice(7))
      : t(`history.field.${entry.field}` as MessageKey);
  const show = (entry: HistoryEntry, value: HistoryValue | null) => {
    if (value === null || value.text === "") return t("history.empty");
    if (entry.field === "priority") return t(`ticket.priority.${String(value.raw)}` as MessageKey);
    if (entry.field === "archived") return t(`ticket.archive.${String(value.raw)}` as MessageKey);
    if (entry.field === "blocked") return value.text ? `${t("history.yes")}: ${value.text}` : t("history.no");
    if (/^\d{4}-\d{2}-\d{2}$/.test(value.text)) return new Date(`${value.text}T00:00:00`).toLocaleDateString(locale);
    return value.text.length > 120 ? `${value.text.slice(0, 117)}…` : value.text;
  };
  return useMemo(
    () => (entry: HistoryEntry) => {
      if (entry.field === "created") return `${label(entry)}: ${entry.to?.text ?? ""}`;
      if (entry.field === "trash") {
        // Корзина (YT-14): удалён, восстановлен, очищен окончательно.
        if (entry.to?.text === "purged") return t("history.trash.purged");
        return entry.to ? t("history.trash.deleted") : t("history.trash.restored");
      }
      if (entry.field === "parents" || entry.field === "children") {
        // Недоступный связанный тикет не раскрывается (R-2.17): сервер отдаёт пустой текст.
        const linked = (value: HistoryValue | null) => (value?.text ? value.text : t("relations.unavailable"));
        // Связь снята удалением в корзину: у ребёнка остался след родителя (R-2.8).
        if (!entry.to && entry.sourceDetail === "trash") {
          return t(`history.link.${entry.field}.trashed` as MessageKey, { ticket: linked(entry.from) });
        }
        const via =
          entry.sourceDetail === "restore"
            ? ` · ${t("history.viaRestore")}`
            : entry.sourceDetail === "trace"
              ? ` · ${t("history.viaTrace")}`
              : "";
        return entry.to
          ? t(`history.link.${entry.field}.added` as MessageKey, { ticket: linked(entry.to) }) + via
          : t(`history.link.${entry.field}.removed` as MessageKey, { ticket: linked(entry.from) }) + via;
      }
      if (entry.field === "links") {
        // «Блокирует: AOS-5 …»; недоступный связанный тикет — без ключа и названия (R-2.17).
        const linked = (value: HistoryValue | null) => (value?.text ? value.text : t("relations.unavailable"));
        if (entry.from && entry.to)
          return t("history.link.links.changed", { from: linked(entry.from), to: linked(entry.to) });
        return entry.to
          ? t("history.link.links.added", { ticket: linked(entry.to) })
          : t("history.link.links.removed", { ticket: linked(entry.from) });
      }
      if (entry.field === "attachments") {
        return entry.to
          ? t("history.attachments.added", { name: entry.to.text })
          : t("history.attachments.removed", { name: entry.from?.text ?? "" });
      }
      if (entry.field === "webLinks") {
        return entry.to
          ? t("history.webLinks.added", { link: entry.to.text })
          : t("history.webLinks.removed", { link: entry.from?.text ?? "" });
      }
      if (entry.field === "number") {
        // «номер 1.3 → 1.4, вставлен AOS-…» — системная строка пересчёта (R-2.9).
        const [, kind, key] = (entry.sourceDetail ?? "").split(":");
        const base = t("history.number", { from: entry.from?.text ?? "—", to: entry.to?.text ?? "—" });
        return kind && key ? `${base}, ${t(`history.number.${kind}` as MessageKey, { key })}` : base;
      }
      if (entry.field === "visibility") {
        const text = (value: HistoryValue | null) => {
          const [mode, ...names] = (value?.text ?? "inherit").split(": ");
          const name = t(`ticket.visibility.${mode}` as MessageKey);
          return names.length ? `${name} (${names.join(": ")})` : name;
        };
        return `${label(entry)}: ${text(entry.from)} → ${text(entry.to)}`;
      }
      if (entry.field === "description") return `${label(entry)} ${t("comment.edited")}`;
      return `${label(entry)}: ${show(entry, entry.from)} → ${show(entry, entry.to)}`;
    },
    [t, locale],
  );
}
