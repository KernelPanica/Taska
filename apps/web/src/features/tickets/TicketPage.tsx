import { ArrowLeft, Prohibit, TreeStructure, Trash, UserPlus, Warning } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ARCHIVE_REASONS,
  CANCELLED_OUTCOME,
  canTransition,
  PRIORITIES,
  type ArchiveReason,
  type ChecklistItem,
  type FieldValue,
  type Priority,
  type Space,
  type StatusScheme,
  type Ticket,
  type TicketField,
  type TicketType,
  type TitleOnlyTicket,
} from "@yourtask/contracts";
import { ApiError } from "../../api/client";
import {
  useFields,
  useMe,
  usePeople,
  useScales,
  useScheme,
  useSpaces,
  useTicket,
  useTicketAction,
  useTicketTypes,
  useAttachments,
  useDescriptionMentions,
  useUpdateTicket,
  useWebLinks,
} from "../../api/hooks";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";
import { ValueEditor } from "../setup/fieldValues";
import { MarkdownPreview, TypeMark } from "../setup/shared";
import { MentionTextarea, TicketActivity, type MentionExtra } from "./TicketActivity";
import { attachmentMarkdown, AttachmentsCard, UploadRow, useTicketUploads } from "./Attachments";
import { ProgressBar, RelationsCard, TitleOnlyView, VisibilityCard, WebLinksCard } from "./TicketRelations";
import { DeletedTicketView, TrashButton } from "../trash/Trash";

/** Карточка тикета (YT-06): шапка, описание, чеклист, люди, поля, статус, отмена, архив, смена типа. */
export function TicketPage() {
  const { key = "" } = useParams();
  const ticket = useTicket(key);
  const types = useTicketTypes();
  const spaces = useSpaces();
  const { t } = useI18n();
  const type = types.data?.items.find((item) => item.id === ticket.data?.typeId);
  const space = spaces.data?.items.find((item) => item.id === ticket.data?.spaceId);
  return (
    <section className="page ticket-page">
      <div className="ticket-page__nav">
        <Link className="back-link" to={space ? `/spaces/${space.slug}` : "/"}>
          <ArrowLeft aria-hidden="true" size={16} />
          {space?.name ?? t("common.back")}
        </Link>
        {ticket.data ? (
          <Link className="nav-link" to={`/spaces/${space?.slug ?? ""}/tree?root=${ticket.data.key}`}>
            <TreeStructure aria-hidden="true" size={16} />
            {t("tree.branch")}
          </Link>
        ) : null}
      </div>
      {ticket.isPending || types.isPending ? <Loading /> : null}
      {ticket.isError && ticket.error instanceof ApiError && ticket.error.code === "ticket_title_only" ? (
        <TitleOnlyView ticket={ticket.error.problem?.ticket as TitleOnlyTicket} />
      ) : ticket.isError &&
        ticket.error instanceof ApiError &&
        (ticket.error.code === "ticket_in_trash" || ticket.error.code === "ticket_purged") ? (
        <DeletedTicketView error={ticket.error} />
      ) : ticket.isError ? (
        <ErrorState error={ticket.error} />
      ) : null}
      {ticket.data && type ? <TicketView key={ticket.data.id} space={space} ticket={ticket.data} type={type} /> : null}
    </section>
  );
}

const FIELD_LABELS: Record<string, MessageKey> = {
  title: "ticket.titleLabel",
  description: "ticket.description",
  checklist: "ticket.checklist",
  values: "ticket.fields",
  priority: "ticket.priority",
  tags: "ticket.tags",
  startDate: "ticket.startDate",
  endDate: "ticket.endDate",
  blocked: "ticket.blocked",
  people: "ticket.people",
  statusId: "ticket.status",
  typeId: "tickets.type",
};

/** Что изменилось между версией, с которой человек начал правку, и актуальной (R-3.1). */
function changedFields(before: Ticket, after: Ticket) {
  return Object.keys(FIELD_LABELS).filter(
    (field) => JSON.stringify(before[field as keyof Ticket]) !== JSON.stringify(after[field as keyof Ticket]),
  );
}

function TicketView({ ticket, type, space }: { ticket: Ticket; type: TicketType; space?: Space | undefined }) {
  const { t, locale } = useI18n();
  const scheme = useScheme(type.id, ticket.spaceId);
  const [conflict, setConflict] = useState<string | null>(null);
  const status = scheme.data?.statuses.find((item) => item.id === ticket.statusId);
  const outcome = type.outcomes.find((item) => item.key === ticket.outcome);

  /** Конфликт версий: показываем, кто и что поменял; черновики форм остаются. */
  const onError = (base: Ticket) => (error: unknown) => {
    if (error instanceof ApiError && error.code === "version_conflict" && error.problem?.current) {
      const current = error.problem.current as Ticket;
      setConflict(
        t("ticket.conflict", {
          name: current.updatedBy?.name ?? "?",
          fields: changedFields(base, current)
            .map((field) => t(FIELD_LABELS[field] as MessageKey))
            .join(", "),
        }),
      );
    }
  };

  return (
    <>
      <header className="ticket-header">
        <p className="ticket-header__meta">
          <TypeMark color={type.color} icon={type.icon} />
          <span>{type.name}</span>
          <span className="ticket-key">{ticket.key}</span>
          {ticket.numbers.map((entry) => (
            <span className="flow-number" key={`${entry.number}-${entry.parentKey ?? ""}`} title={t("flow.hint")}>
              {entry.parentKey
                ? t("flow.numberIn", { number: entry.number, key: entry.parentKey })
                : t("flow.number", { number: entry.number })}
            </span>
          ))}
          {status ? (
            <Badge
              variant={status.category === "done" ? "success" : status.category === "in_progress" ? "info" : "neutral"}
            >
              {status.name}
            </Badge>
          ) : null}
          {outcome ? (
            <Badge variant={ticket.outcome === CANCELLED_OUTCOME ? "warning" : "success"}>
              {t("ticket.outcomeShown", { outcome: outcome.label })}
            </Badge>
          ) : null}
          {ticket.blocked ? (
            <Badge variant="danger">
              <Prohibit aria-hidden="true" size={12} /> {t("tickets.blockedBadge")}
            </Badge>
          ) : null}
        </p>
        <div className="ticket-header__title">
          <TitleEditor onError={onError} ticket={ticket} />
          <div className="ticket-header__actions">
            <TrashButton space={space} ticket={ticket} />
          </div>
        </div>
        <p className="ui-field__hint">
          {t("ticket.created", {
            name: ticket.createdBy?.name ?? "—",
            date: new Date(ticket.createdAt).toLocaleString(locale),
          })}{" "}
          · {t("ticket.updated", { date: new Date(ticket.updatedAt).toLocaleString(locale) })}
        </p>
      </header>
      {ticket.rollup.progress ? <ProgressBar progress={ticket.rollup.progress} /> : null}
      {ticket.rollup.closeSuggested ? (
        <p className="ticket-banner ticket-banner--suggest" role="status">
          {t("ticket.closeSuggested")}
        </p>
      ) : null}
      {!ticket.permissions.edit && !ticket.permissions.status ? (
        <p className="ui-field__hint">{t("ticket.readOnly")}</p>
      ) : null}
      {conflict ? <Notice error={conflict} onDismiss={() => setConflict(null)} /> : null}
      {ticket.archived ? (
        <p className="ticket-banner" role="status">
          {t("ticket.archivedBanner", { reason: t(`ticket.archive.${ticket.archived.reason}` as MessageKey) })}
        </p>
      ) : null}
      {ticket.cancelReason && ticket.outcome === CANCELLED_OUTCOME ? (
        <p className="ticket-banner" role="status">
          {t("ticket.cancelledBecause", { reason: ticket.cancelReason })}
        </p>
      ) : null}
      <div className="ticket-layout">
        <div className="ticket-main">
          <DescriptionEditor onError={onError} ticket={ticket} />
          <AttachmentsCard ticket={ticket} />
          <ChecklistEditor onError={onError} ticket={ticket} />
          <RelationsCard spaceSlug={space?.slug} ticket={ticket} />
          <WebLinksCard ticket={ticket} />
          <TicketActivity ticket={ticket} />
        </div>
        <div className="ticket-side">
          {scheme.data ? <StatusCard onError={onError} scheme={scheme.data} ticket={ticket} type={type} /> : null}
          <PropertiesCard onError={onError} ticket={ticket} type={type} />
          <VisibilityCard key={`${ticket.id}-${ticket.version}`} ticket={ticket} />
        </div>
      </div>
    </>
  );
}

type OnError = (base: Ticket) => (error: unknown) => void;

/** Название правится явной кнопкой. */
function TitleEditor({ ticket, onError }: { ticket: Ticket; onError: OnError }) {
  const { t } = useI18n();
  const update = useUpdateTicket(ticket.key);
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(ticket.title);
  if (!editing) {
    return (
      <div className="ticket-title">
        <h1>{ticket.title}</h1>
        {ticket.permissions.edit ? (
          <Button
            onClick={() => {
              setTitle(ticket.title);
              setEditing(true);
            }}
            variant="ghost"
          >
            {t("ticket.edit")}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate(
          { version: ticket.version, title },
          { onSuccess: () => setEditing(false), onError: onError(ticket) },
        );
      }}
    >
      <Notice
        error={
          update.isError && !(update.error instanceof ApiError && update.error.code === "version_conflict")
            ? errorText(update.error)
            : null
        }
        onDismiss={() => update.reset()}
      />
      <Input
        label={t("ticket.titleLabel")}
        maxLength={500}
        onChange={(e) => setTitle(e.target.value)}
        required
        value={title}
      />
      <Button loading={update.isPending} type="submit">
        {t("ticket.save")}
      </Button>
      <Button onClick={() => setEditing(false)} variant="secondary">
        {t("ticket.cancelEdit")}
      </Button>
    </form>
  );
}

/**
 * Описание в Markdown: просмотр без HTML, правка явной кнопкой с живым предпросмотром.
 * Через @ — человек, связанный тикет или документ YourWiki из блока «Ссылки» (R-2.24).
 */
function DescriptionEditor({ ticket, onError }: { ticket: Ticket; onError: OnError }) {
  const { t } = useI18n();
  const update = useUpdateTicket(ticket.key);
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState(ticket);
  const [text, setText] = useState(ticket.description);
  const mentions = useDescriptionMentions(ticket.key, ticket.description);
  const webLinks = useWebLinks(ticket.key);
  const documents = (webLinks.data?.items ?? [])
    .filter((link) => link.kind === "yourwiki")
    .map((link) => ({ url: link.url, title: link.title }));
  const related = [
    ...ticket.relations.parents,
    ...ticket.relations.children,
    ...ticket.relations.links.map((link) => link.ticket),
  ].flatMap((item) => (item.available ? [item] : []));
  const extra: MentionExtra[] = [
    ...documents
      .filter((doc) => doc.title)
      .map((doc) => ({
        search: doc.title as string,
        label: doc.title as string,
        hint: "YourWiki",
        insert: `[${doc.title}](${doc.url})`,
      })),
    ...related.map((item) => ({
      search: `${item.key} ${item.title}`,
      label: item.key,
      hint: item.title,
      insert: item.key,
    })),
  ];
  const attachments = useAttachments(ticket.key);
  const { uploads, add, dismiss } = useTicketUploads(ticket.key);
  const preview = {
    people: mentions.data?.people ?? [],
    tickets: mentions.data?.tickets ?? [],
    documents,
    attachments: attachments.data?.items ?? [],
  };
  return (
    <Card className="ticket-section">
      <div className="ticket-section__head">
        <h2>{t("ticket.description")}</h2>
        {!editing && ticket.permissions.edit ? (
          <Button
            onClick={() => {
              setText(ticket.description);
              setBase(ticket);
              setEditing(true);
            }}
            variant="ghost"
          >
            {t("ticket.edit")}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(
              { version: ticket.version, description: text },
              { onSuccess: () => setEditing(false), onError: onError(base) },
            );
          }}
        >
          <div className="description-editor">
            <MentionTextarea
              extra={extra}
              hint={t("ticket.descriptionHint")}
              label={t("ticket.description")}
              onChange={setText}
              onFiles={async (files) => (await add(files)).map(attachmentMarkdown)}
              rows={16}
              value={text}
            />
            <div className="description-editor__preview" aria-label={t("ticket.preview")}>
              <span className="ui-field__label">{t("ticket.preview")}</span>
              <MarkdownPreview mentions={preview} source={text} />
            </div>
          </div>
          {uploads.map((upload) => (
            <UploadRow key={upload.id} onDismiss={() => dismiss(upload.id)} upload={upload} />
          ))}
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("ticket.save")}
            </Button>
            <Button onClick={() => setEditing(false)} variant="secondary">
              {t("ticket.cancelEdit")}
            </Button>
          </div>
        </form>
      ) : ticket.description.trim() ? (
        <MarkdownPreview mentions={preview} source={ticket.description} />
      ) : (
        <p className="ui-field__hint">{t("ticket.descriptionEmpty")}</p>
      )}
    </Card>
  );
}

/**
 * Чеклист: самостоятельные пункты (отметка сохраняется сразу) и пункты-дети (R-2.12):
 * пункт-ребёнок отмечается сам, когда ребёнка закроют, и в прогрессе учитывается один раз.
 */
function ChecklistEditor({ ticket, onError }: { ticket: Ticket; onError: OnError }) {
  const { t } = useI18n();
  const update = useUpdateTicket(ticket.key);
  const [text, setText] = useState("");
  const [childKey, setChildKey] = useState("");
  const canEdit = ticket.permissions.edit;
  // Отметка видна сразу; если сервер не принял — возвращаем как было.
  const [items, setItems] = useState(ticket.checklist);
  useEffect(() => setItems(ticket.checklist), [ticket.checklist]);
  const done = items.filter((item) => item.done).length;
  const children = ticket.relations.children.filter(
    (item): item is Extract<typeof item, { available: true }> => item.available,
  );
  const free = children.filter((child) => !items.some((item) => item.childKey === child.key));
  const save = (checklist: ChecklistItem[]) => {
    setItems(checklist);
    update.mutate(
      { version: ticket.version, checklist },
      {
        onError: (error) => {
          setItems(ticket.checklist);
          onError(ticket)(error);
        },
      },
    );
  };
  return (
    <Card className="ticket-section">
      <div className="ticket-section__head">
        <h2>{t("ticket.checklist")}</h2>
        {ticket.checklist.length ? (
          <span className="ui-field__hint">
            {t("ticket.checklistProgress", { done, total: ticket.checklist.length })}
          </span>
        ) : null}
      </div>
      <ul className="checklist">
        {items.map((item) => {
          const child = item.childKey ? children.find((entry) => entry.key === item.childKey) : undefined;
          return (
            <li className={item.childKey ? "checklist__child" : undefined} key={item.id}>
              <label className="checkbox-inline">
                <input
                  checked={item.done}
                  disabled={update.isPending || !canEdit || Boolean(item.childKey)}
                  onChange={(e) =>
                    save(
                      ticket.checklist.map((entry) =>
                        entry.id === item.id ? { ...entry, done: e.target.checked } : entry,
                      ),
                    )
                  }
                  type="checkbox"
                />
                {item.childKey ? (
                  <span className={item.done ? "checklist__done" : undefined}>
                    {t("ticket.checklistChild")} <Link to={`/tickets/${item.childKey}`}>{item.childKey}</Link>{" "}
                    {child?.title ?? item.text}
                  </span>
                ) : (
                  <span className={item.done ? "checklist__done" : undefined}>{item.text}</span>
                )}
              </label>
              {item.childKey ? (
                <span className="ui-field__hint">{t("ticket.checklistChildHint", { key: item.childKey })}</span>
              ) : null}
              {canEdit ? (
                <button
                  aria-label={t("ticket.checklistRemove", { text: item.childKey ?? item.text })}
                  className="ui-icon-button"
                  onClick={() => save(items.filter((entry) => entry.id !== item.id))}
                  type="button"
                >
                  <Trash aria-hidden="true" size={16} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canEdit ? (
        <form
          className="ticket-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            update.mutate(
              {
                version: ticket.version,
                checklist: [...ticket.checklist, { id: crypto.randomUUID(), text: text.trim(), done: false }],
              },
              { onSuccess: () => setText(""), onError: onError(ticket) },
            );
          }}
        >
          <Input
            label={t("ticket.checklistAdd")}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            value={text}
          />
          <Button loading={update.isPending} type="submit" variant="secondary">
            {t("ticket.checklistAddButton")}
          </Button>
        </form>
      ) : null}
      {canEdit && free.length ? (
        <form
          className="ticket-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const child = free.find((entry) => entry.key === childKey);
            if (!child) return;
            update.mutate(
              {
                version: ticket.version,
                checklist: [
                  ...ticket.checklist,
                  { id: crypto.randomUUID(), text: child.title, done: false, childKey: child.key },
                ],
              },
              { onSuccess: () => setChildKey(""), onError: onError(ticket) },
            );
          }}
        >
          <Select label={t("ticket.checklistAddChild")} onChange={(e) => setChildKey(e.target.value)} value={childKey}>
            <option value="">{t("access.choose")}</option>
            {free.map((child) => (
              <option key={child.key} value={child.key}>
                {child.key} {child.title}
              </option>
            ))}
          </Select>
          <Button disabled={!childKey} loading={update.isPending} type="submit" variant="secondary">
            {t("ticket.checklistAddButton")}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/** Статус по правилам схемы (YT-05), отмена с причиной, архив с причиной, смена типа. */
function StatusCard({
  ticket,
  type,
  scheme,
  onError,
}: {
  ticket: Ticket;
  type: TicketType;
  scheme: StatusScheme;
  onError: OnError;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const fields = useFields();
  const types = useTicketTypes();
  const transition = useTicketAction<{ version: number; statusId: string; outcome?: string }>(ticket.key, "transition");
  const cancel = useTicketAction<{ version: number; reason: string }>(ticket.key, "cancel");
  const archive = useTicketAction<{ version: number; reason: ArchiveReason }>(ticket.key, "archive");
  const unarchive = useTicketAction<{ version: number }>(ticket.key, "unarchive");
  const changeType = useTicketAction<{ version: number; typeId: string; statusId?: string }>(ticket.key, "change-type");
  const others = scheme.statuses.filter((status) => status.id !== ticket.statusId);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [archiveReason, setArchiveReason] = useState<ArchiveReason>("postponed");
  const [newType, setNewType] = useState("");
  const [choice, setChoice] = useState<string[] | null>(null);
  const [chosenStatus, setChosenStatus] = useState("");
  const newScheme = useScheme(newType, ticket.spaceId);
  useEffect(() => {
    if (!others.some((status) => status.id === target)) setTarget(others[0]?.id ?? "");
  }, [ticket.statusId]);
  const targetStatus = scheme.statuses.find((status) => status.id === target);
  const doneOutcomes = (targetStatus?.outcomes ?? []).filter((key) => key !== CANCELLED_OUTCOME);
  const fieldName = (key: string) => fields.data?.items.find((field) => field.key === key)?.name ?? key;

  /** Ошибка перехода человеческим языком: что заполнить, по полям. */
  const blocked =
    transition.error instanceof ApiError && transition.error.code === "transition_blocked" && targetStatus
      ? {
          title: t("ticket.blockedMove", { status: targetStatus.name }),
          items: (transition.error.problem?.errors ?? []).map((error) =>
            error.field.startsWith("values.")
              ? t("ticket.req.field", { name: fieldName(error.field.slice(7)) })
              : error.field.startsWith("people.")
                ? t(`ticket.req.people.${error.field.slice(7)}` as MessageKey)
                : error.field === "description" || error.field === "checklist_done"
                  ? t(`ticket.req.${error.field}` as MessageKey)
                  : error.message,
          ),
        }
      : null;

  if (!ticket.permissions.status) {
    const current = scheme.statuses.find((status) => status.id === ticket.statusId);
    return (
      <Card className="ticket-section">
        <h2>{t("ticket.status")}</h2>
        <p>{current?.name}</p>
        <p className="ui-field__hint">{t("ticket.statusReadOnly")}</p>
      </Card>
    );
  }

  return (
    <Card className="ticket-section">
      <h2>{t("ticket.status")}</h2>
      {ticket.archived ? (
        <Button
          loading={unarchive.isPending}
          onClick={() => unarchive.mutate({ version: ticket.version }, { onError: onError(ticket) })}
        >
          {t("ticket.unarchive")}
        </Button>
      ) : (
        <>
          <form
            className="form-stack"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              transition.mutate(
                {
                  version: ticket.version,
                  statusId: target,
                  ...(targetStatus?.category === "done" ? { outcome: outcome || doneOutcomes[0] } : {}),
                },
                { onError: onError(ticket) },
              );
            }}
          >
            <Select label={t("ticket.moveTo")} onChange={(e) => setTarget(e.target.value)} value={target}>
              {others.map((status) => (
                <option disabled={!canTransition(scheme, ticket.statusId, status.id)} key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </Select>
            {targetStatus?.category === "done" ? (
              <Select
                label={t("ticket.outcome")}
                onChange={(e) => setOutcome(e.target.value)}
                value={outcome || doneOutcomes[0]}
              >
                {doneOutcomes.map((key) => (
                  <option key={key} value={key}>
                    {type.outcomes.find((item) => item.key === key)?.label ?? key}
                  </option>
                ))}
              </Select>
            ) : null}
            {blocked ? (
              <div className="ticket-blocked" role="alert">
                <strong>{blocked.title}</strong>
                <ul>
                  {blocked.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : transition.isError &&
              !(transition.error instanceof ApiError && transition.error.code === "version_conflict") ? (
              <Notice error={errorText(transition.error)} onDismiss={() => transition.reset()} />
            ) : null}
            <Button loading={transition.isPending} type="submit">
              {t("ticket.move")}
            </Button>
          </form>

          <form
            className="form-stack ticket-danger"
            onSubmit={(event) => {
              event.preventDefault();
              cancel.mutate(
                { version: ticket.version, reason },
                { onSuccess: () => setReason(""), onError: onError(ticket) },
              );
            }}
          >
            <Input
              label={t("ticket.cancelReason")}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              required
              value={reason}
            />
            {cancel.isError && !(cancel.error instanceof ApiError && cancel.error.code === "version_conflict") ? (
              <Notice error={errorText(cancel.error)} onDismiss={() => cancel.reset()} />
            ) : null}
            <Button loading={cancel.isPending} type="submit" variant="danger">
              {t("ticket.cancel")}
            </Button>
          </form>

          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              archive.mutate({ version: ticket.version, reason: archiveReason }, { onError: onError(ticket) });
            }}
          >
            <Select
              label={t("ticket.archiveReason")}
              onChange={(e) => setArchiveReason(e.target.value as ArchiveReason)}
              value={archiveReason}
            >
              {ARCHIVE_REASONS.map((item) => (
                <option key={item} value={item}>
                  {t(`ticket.archive.${item}` as MessageKey)}
                </option>
              ))}
            </Select>
            <Button loading={archive.isPending} type="submit" variant="secondary">
              {t("ticket.archive")}
            </Button>
          </form>
        </>
      )}

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newType) return;
          changeType.mutate(
            { version: ticket.version, typeId: newType, ...(choice && chosenStatus ? { statusId: chosenStatus } : {}) },
            {
              onSuccess: () => {
                setChoice(null);
                setNewType("");
              },
              onError: (error) => {
                if (error instanceof ApiError && error.code === "status_choice_required") {
                  setChoice(error.problem?.candidates ?? []);
                  setChosenStatus(error.problem?.candidates?.[0] ?? "");
                } else onError(ticket)(error);
              },
            },
          );
        }}
      >
        <Select
          label={t("ticket.changeTypeTo")}
          onChange={(e) => {
            setNewType(e.target.value);
            setChoice(null);
          }}
          value={newType}
        >
          <option value="">—</option>
          {(types.data?.items ?? [])
            .filter((item) => item.id !== type.id)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </Select>
        {choice ? (
          <Select
            label={t("ticket.chooseStatus")}
            onChange={(e) => setChosenStatus(e.target.value)}
            value={chosenStatus}
          >
            {choice.map((id) => (
              <option key={id} value={id}>
                {newScheme.data?.statuses.find((status) => status.id === id)?.name ?? id}
              </option>
            ))}
          </Select>
        ) : null}
        <Button disabled={!newType} loading={changeType.isPending} type="submit" variant="secondary">
          {t("ticket.changeType")}
        </Button>
      </form>
    </Card>
  );
}

interface PropertiesForm {
  assigneeIds: string[];
  customerId: string;
  testerId: string;
  watcherIds: string[];
  priority: Priority;
  tags: string;
  startDate: string;
  endDate: string;
  blocked: boolean;
  blockedReason: string;
  values: Record<string, FieldValue>;
}

const toForm = (ticket: Ticket): PropertiesForm => ({
  assigneeIds: ticket.people.assignees.map((person) => person.id),
  customerId: ticket.people.customer?.id ?? "",
  testerId: ticket.people.tester?.id ?? "",
  watcherIds: ticket.people.watchers.map((person) => person.id),
  priority: ticket.priority,
  tags: ticket.tags.join(", "),
  startDate: ticket.startDate ?? "",
  endDate: ticket.endDate ?? "",
  blocked: ticket.blocked,
  blockedReason: ticket.blockedReason ?? "",
  values: ticket.values,
});

/** Люди, приоритет, теги, даты, блокировка и поля типа. Сохраняются явной кнопкой. */
function PropertiesCard({ ticket, type, onError }: { ticket: Ticket; type: TicketType; onError: OnError }) {
  const { t, locale } = useI18n();
  const people = usePeople();
  const fields = useFields();
  const me = useMe();
  const update = useUpdateTicket(ticket.key);
  const assignMe = useTicketAction<{ version: number }>(ticket.key, "assign-me");
  const errorText = useErrorText();
  const [form, setForm] = useState(() => toForm(ticket));
  const [base, setBase] = useState(ticket);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  // Чужие изменения подтягиваются в форму, только пока человек сам ничего не правит.
  useEffect(() => {
    if (!dirty) {
      setForm(toForm(ticket));
      setBase(ticket);
    }
  }, [ticket, dirty]);
  const edit = (change: Partial<PropertiesForm>) => {
    setDirty(true);
    setSaved(false);
    setForm({ ...form, ...change });
  };

  const typeFields = useMemo(
    () =>
      type.fieldIds
        .map((id) => fields.data?.items.find((field) => field.id === id))
        .filter((field): field is TicketField => Boolean(field))
        // Поля под маской зритель не видит и не отправляет (R-2.20).
        .filter((field) => !ticket.masked.includes(field.key)),
    [fields.data, type.fieldIds, ticket.masked],
  );
  const can = ticket.permissions;
  const scales = useScales();
  const rollupText = (key: string) => {
    const range = ticket.rollup.estimates[key];
    if (!range) return null;
    const scale = scales.data?.items.find((item) => item.id === range.scaleId);
    const label = range.valueId ? scale?.values.find((value) => value.id === range.valueId)?.label : null;
    const number = (value: number) => Math.round(value * 10) / 10;
    return label ?? (range.min === range.max ? `${number(range.min)}` : `${number(range.min)}–${number(range.max)}`);
  };
  const dateText = (value: string | null) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString(locale) : "…");
  const hidden = Object.keys(ticket.values).filter((key) => !typeFields.some((field) => field.key === key));
  const options = (people.data?.items ?? []).map((person) => ({
    id: person.id,
    label: person.name,
    hint: person.email ?? undefined,
  }));
  const datesWrong = Boolean(form.startDate && form.endDate && form.endDate < form.startDate);

  function submit(event: FormEvent) {
    event.preventDefault();
    const values = Object.fromEntries(typeFields.map((field) => [field.key, form.values[field.key] ?? null]));
    update.mutate(
      {
        version: ticket.version,
        priority: form.priority,
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        blocked: form.blocked,
        blockedReason: form.blocked ? form.blockedReason : null,
        values,
        people: {
          assigneeIds: form.assigneeIds,
          customerId: form.customerId || null,
          testerId: form.testerId || null,
          watcherIds: form.watcherIds,
        },
      },
      {
        onSuccess: () => {
          setDirty(false);
          setSaved(true);
        },
        onError: onError(base),
      },
    );
  }

  return (
    <Card className="ticket-section">
      <div className="ticket-section__head">
        <h2>{t("ticket.properties")}</h2>
        {can.assign && !ticket.people.assignees.some((person) => person.id === me.data?.user.id) ? (
          <Button
            loading={assignMe.isPending}
            onClick={() => assignMe.mutate({ version: ticket.version }, { onError: onError(ticket) })}
            variant="ghost"
          >
            <UserPlus aria-hidden="true" size={16} /> {t("ticket.assignMe")}
          </Button>
        ) : null}
      </div>
      <Notice
        error={
          update.isError && !(update.error instanceof ApiError && update.error.code === "version_conflict")
            ? errorText(update.error)
            : null
        }
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          update.reset();
          setSaved(false);
        }}
      />
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="plain-fieldset" disabled={!can.assign}>
          <CheckboxPicker
            label={t("ticket.assignees")}
            onChange={(assigneeIds) => edit({ assigneeIds })}
            options={options}
            value={form.assigneeIds}
          />
        </fieldset>
        <fieldset className="plain-fieldset form-stack" disabled={!can.edit}>
          <div className="form-row">
            <Select
              label={t("ticket.customer")}
              onChange={(e) => edit({ customerId: e.target.value })}
              value={form.customerId}
            >
              <option value="">{t("ticket.nobody")}</option>
              {options.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.label}
                </option>
              ))}
            </Select>
            <Select
              label={t("ticket.tester")}
              onChange={(e) => edit({ testerId: e.target.value })}
              value={form.testerId}
            >
              <option value="">{t("ticket.nobody")}</option>
              {options.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.label}
                </option>
              ))}
            </Select>
          </div>
          <CheckboxPicker
            label={t("ticket.watchers")}
            onChange={(watcherIds) => edit({ watcherIds })}
            options={options}
            value={form.watcherIds}
          />
          <div className="form-row">
            <Select
              label={t("ticket.priority")}
              onChange={(e) => edit({ priority: e.target.value as Priority })}
              value={form.priority}
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`ticket.priority.${priority}` as MessageKey)}
                </option>
              ))}
            </Select>
            <Input
              hint={t("ticket.tagsHint")}
              label={t("ticket.tags")}
              onChange={(e) => edit({ tags: e.target.value })}
              value={form.tags}
            />
          </div>
        </fieldset>
        <fieldset className="plain-fieldset form-stack" disabled={!can.dates}>
          <div className="form-row">
            <Input
              label={t("ticket.startDate")}
              onChange={(e) => edit({ startDate: e.target.value })}
              type="date"
              value={form.startDate}
            />
            <Input
              error={datesWrong ? t("ticket.datesWarning") : undefined}
              label={t("ticket.endDate")}
              onChange={(e) => edit({ endDate: e.target.value })}
              type="date"
              value={form.endDate}
            />
          </div>
          {ticket.rollup.startDate || ticket.rollup.endDate ? (
            <p className={`ui-field__hint ${ticket.rollup.datesDiffer ? "dates-differ" : ""}`}>
              {ticket.rollup.datesDiffer ? <Warning aria-hidden="true" size={14} /> : null}{" "}
              {t("ticket.rollupDates", {
                start: dateText(ticket.rollup.startDate),
                end: dateText(ticket.rollup.endDate),
              })}
              {ticket.rollup.datesDiffer ? ` — ${t("ticket.datesDiffer")}` : ""}
            </p>
          ) : null}
        </fieldset>
        <fieldset className="plain-fieldset form-stack" disabled={!can.edit}>
          <label className="checkbox-inline">
            <input checked={form.blocked} onChange={(e) => edit({ blocked: e.target.checked })} type="checkbox" />
            {t("ticket.blocked")}
          </label>
          {form.blocked ? (
            <Input
              label={t("ticket.blockedReason")}
              maxLength={500}
              onChange={(e) => edit({ blockedReason: e.target.value })}
              required
              value={form.blockedReason}
            />
          ) : null}
          <fieldset className="form-stack">
            <legend className="ui-field__label">{t("ticket.fields")}</legend>
            {typeFields.map((field) => (
              <div key={field.id}>
                <ValueEditor
                  field={field}
                  onChange={(value) => edit({ values: { ...form.values, [field.key]: value } })}
                  value={form.values[field.key] ?? null}
                />
                {rollupText(field.key) ? (
                  <p className="ui-field__hint">{t("ticket.rollupEstimate", { value: rollupText(field.key) ?? "" })}</p>
                ) : null}
              </div>
            ))}
            {hidden.length ? (
              <p className="ui-field__hint">{t("ticket.hiddenFields", { fields: hidden.join(", ") })}</p>
            ) : null}
          </fieldset>
        </fieldset>
        {can.edit || can.assign || can.dates ? (
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("ticket.save")}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
