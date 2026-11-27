import { ArrowCounterClockwise, Footprints, Trash as TrashIcon, X } from "@phosphor-icons/react";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  ChildrenChoice,
  ChildrenMode,
  ParentTrace,
  Space,
  Ticket,
  TrashInput,
  TrashResult,
} from "@yourtask/contracts";
import { ApiError } from "../../api/client";
import {
  useMe,
  usePurgeTickets,
  useRelinkTrace,
  useRestoreTickets,
  useSaveTrashSettings,
  useSpaces,
  useTrash,
  useTrashTickets,
} from "../../api/hooks";
import { Badge, Button, Card, Dialog, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";

/**
 * Корзина (R-2.22; YT-14, docs/adr/0020): удаление без окна подтверждения с «Отменить»,
 * подтверждение только для нескольких тикетов, диалог про детей при удалении родителя (R-2.8).
 */

// ---- «Отменить»: одна плашка на всё приложение, переживает переход на другую страницу ----

type UndoState = { result: TrashResult; id: number } | null;
let undoState: UndoState = null;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
const undoListeners = new Set<() => void>();
const emitUndo = () => undoListeners.forEach((listener) => listener());

export const UNDO_SECONDS = 15;

export function showUndo(result: TrashResult) {
  undoState = { result, id: Date.now() };
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoState = null;
    emitUndo();
  }, UNDO_SECONDS * 1000);
  emitUndo();
}

function hideUndo() {
  clearTimeout(undoTimer);
  undoState = null;
  emitUndo();
}

export function UndoToast() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const state = useSyncExternalStore(
    (listener) => {
      undoListeners.add(listener);
      return () => undoListeners.delete(listener);
    },
    () => undoState,
  );
  const restore = useRestoreTickets();
  const [restored, setRestored] = useState<string | null>(null);
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => setRestored(null), 4000);
    return () => clearTimeout(timer);
  }, [restored]);
  if (restored) {
    return (
      <div className="undo-toast" role="status">
        <ArrowCounterClockwise aria-hidden="true" size={18} />
        <span>{restored}</span>
      </div>
    );
  }
  if (!state) return null;
  const { deleted, children } = state.result;
  const first = deleted[0];
  const text =
    deleted.length === 1 && first
      ? t("trash.deletedOne", { key: first.key, title: first.title })
      : t("trash.deletedMany", { count: deleted.length });
  return (
    <div className="undo-toast" role="status">
      <TrashIcon aria-hidden="true" size={18} />
      <span>
        {text}
        {children.length ? ` · ${t("trash.childrenKeptTrace", { count: children.length })}` : ""}
      </span>
      {restore.isError ? <span className="undo-toast__error">{errorText(restore.error)}</span> : null}
      <Button
        loading={restore.isPending}
        onClick={() =>
          restore.mutate(
            { batchId: state.result.batchId },
            {
              onSuccess: (result) => {
                hideUndo();
                setRestored(t("trash.restoredMany", { keys: result.restored.map((item) => item.key).join(", ") }));
              },
            },
          )
        }
        variant="secondary"
      >
        {t("trash.undo")}
      </Button>
      <button aria-label={t("common.dismiss")} className="ui-icon-button" onClick={hideUndo} type="button">
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

// ---- Удаление: один тикет сразу, несколько — с подтверждением, родитель — с вопросом про детей ----

interface Pending {
  input: TrashInput;
  choice?: ChildrenChoice | undefined;
  count?: number | undefined;
  onDone?: ((result: TrashResult) => void) | undefined;
}

export function useTrashFlow() {
  const trash = useTrashTickets();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<unknown>(null);

  function run(input: TrashInput, onDone?: (result: TrashResult) => void) {
    setError(null);
    trash.mutate(input, {
      onSuccess: (result) => {
        setPending(null);
        showUndo(result);
        onDone?.(result);
      },
      onError: (failure) => {
        if (failure instanceof ApiError && failure.code === "children_choice_required") {
          setPending({ input, choice: failure.problem?.choice as ChildrenChoice, onDone });
        } else if (failure instanceof ApiError && failure.code === "bulk_confirm_required") {
          setPending((current) => ({ ...current, input, count: failure.problem?.count, onDone }));
        } else if (pending) {
          setPending({ ...pending, input });
          setError(failure);
        } else setError(failure);
      },
    });
  }

  const dialog = pending ? (
    <TrashDialog
      busy={trash.isPending}
      error={pending && error ? error : null}
      onCancel={() => {
        setPending(null);
        setError(null);
      }}
      onClearError={() => setError(null)}
      onSubmit={(input) => run(input, pending.onDone)}
      pending={pending}
    />
  ) : null;

  return {
    start: (keys: string[], onDone?: (result: TrashResult) => void) => run({ keys }, onDone),
    dialog,
    busy: trash.isPending,
    error: pending ? null : error,
    reset: () => setError(null),
  };
}

const MODES: ChildrenMode[] = ["keep", "relink", "grandparent", "delete"];

function TrashDialog({
  pending,
  busy,
  error,
  onSubmit,
  onCancel,
  onClearError,
}: {
  pending: Pending;
  busy: boolean;
  error: unknown;
  onSubmit(input: TrashInput): void;
  onCancel(): void;
  onClearError(): void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [mode, setMode] = useState<ChildrenMode>(pending.input.children ?? "keep");
  const [target, setTarget] = useState(pending.input.targetKey ?? "");
  const [newTitle, setNewTitle] = useState(pending.input.newParentTitle ?? "");
  const choice = pending.choice;
  // Подтверждение количества — после выбора про детей («удалить вместе» тоже даёт несколько тикетов).
  const confirmOnly = pending.count !== undefined && (!choice || pending.input.children);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (confirmOnly) {
      onSubmit({ ...pending.input, confirm: true });
      return;
    }
    onSubmit({
      ...pending.input,
      children: mode,
      ...(mode === "relink" && target.trim() ? { targetKey: target.trim().toUpperCase() } : {}),
      ...(mode === "relink" && !target.trim() && newTitle.trim() ? { newParentTitle: newTitle.trim() } : {}),
    });
  };

  return (
    <Dialog
      onClose={onCancel}
      open
      title={confirmOnly ? t("trash.confirmTitle", { count: pending.count ?? 0 }) : t("trash.childrenTitle")}
    >
      <form className="form-stack" onSubmit={submit}>
        {confirmOnly ? (
          <p>{t("trash.confirmText", { count: pending.count ?? 0 })}</p>
        ) : choice ? (
          <>
            <p>
              {t("trash.childrenText", { count: choice.children.length })}{" "}
              <span className="ui-field__hint">
                {choice.children
                  .slice(0, 6)
                  .map((item) => item.key)
                  .join(", ")}
                {choice.children.length > 6 ? " …" : ""}
              </span>
            </p>
            <fieldset className="trash-modes">
              <legend className="visually-hidden">{t("trash.childrenTitle")}</legend>
              {MODES.map((item) => (
                <label className="trash-mode" key={item}>
                  <input
                    checked={mode === item}
                    disabled={item === "grandparent" && !choice.hasGrandparents}
                    name="children-mode"
                    onChange={() => setMode(item)}
                    type="radio"
                    value={item}
                  />
                  <span>
                    <strong>{t(`trash.mode.${item}` as MessageKey)}</strong>
                    <span className="ui-field__hint">
                      {item === "grandparent" && !choice.hasGrandparents
                        ? t("trash.mode.grandparentNone")
                        : t(`trash.mode.${item}.hint` as MessageKey)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === "relink" ? (
              <div className="inline-form">
                <Input
                  label={t("trash.targetKey")}
                  maxLength={40}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder="AOS-230"
                  value={target}
                />
                <Input
                  disabled={Boolean(target.trim())}
                  label={t("trash.newParent")}
                  maxLength={300}
                  onChange={(event) => setNewTitle(event.target.value)}
                  value={newTitle}
                />
              </div>
            ) : null}
          </>
        ) : null}
        {error ? <Notice error={errorText(error)} onDismiss={onClearError} /> : null}
        <div className="dialog-actions">
          <Button onClick={onCancel} type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!confirmOnly && mode === "relink" && !target.trim() && !newTitle.trim()}
            loading={busy}
            type="submit"
            variant="danger"
          >
            <TrashIcon aria-hidden="true" size={16} />{" "}
            {confirmOnly ? t("trash.confirmButton", { count: pending.count ?? 0 }) : t("trash.toTrash")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Кнопка «В корзину» в шапке тикета: без подтверждения; после — список пространства и «Отменить». */
export function TrashButton({ ticket, space }: { ticket: Ticket; space?: Space | undefined }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const flow = useTrashFlow();
  if (!ticket.permissions.trash) return null;
  return (
    <>
      <Button
        loading={flow.busy}
        onClick={() => flow.start([ticket.key], () => navigate(space ? `/spaces/${space.slug}` : "/"))}
        variant="secondary"
      >
        <TrashIcon aria-hidden="true" size={16} /> {t("trash.toTrash")}
      </Button>
      {flow.error ? <Notice error={errorText(flow.error)} onDismiss={flow.reset} /> : null}
      {flow.dialog}
    </>
  );
}

// ---- Ссылка на удалённый тикет ----

export function DeletedTicketView({ error }: { error: ApiError }) {
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const restore = useRestoreTickets();
  const ticket = error.problem?.ticket as {
    key: string;
    title: string;
    deletedAt?: string;
    deletedBy?: { name: string } | null;
    canRestore?: boolean;
  };
  if (error.code === "ticket_purged") {
    return (
      <Card className="deleted-ticket">
        <h1>
          <span className="ticket-key">{ticket.key}</span> {ticket.title}
        </h1>
        <p>{t("trash.purgedText")}</p>
      </Card>
    );
  }
  return (
    <Card className="deleted-ticket">
      <h1>
        <span className="ticket-key">{ticket.key}</span> {ticket.title}
      </h1>
      <p>
        <Badge variant="warning">
          <TrashIcon aria-hidden="true" size={12} /> {t("trash.inTrash")}
        </Badge>{" "}
        {t("trash.deletedBy", {
          name: ticket.deletedBy?.name ?? "—",
          date: ticket.deletedAt ? new Date(ticket.deletedAt).toLocaleString(locale) : "",
        })}
      </p>
      {restore.isError ? <Notice error={errorText(restore.error)} onDismiss={() => restore.reset()} /> : null}
      {ticket.canRestore ? (
        <Button loading={restore.isPending} onClick={() => restore.mutate({ keys: [ticket.key] })}>
          <ArrowCounterClockwise aria-hidden="true" size={16} /> {t("trash.restore")}
        </Button>
      ) : (
        <p className="ui-field__hint">{t("trash.restoreWho")}</p>
      )}
    </Card>
  );
}

// ---- След родителя и «Связать заново» (R-2.8) ----

export function ParentTraces({ ticket, spaceSlug }: { ticket: Ticket; spaceSlug?: string | undefined }) {
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const relink = useRelinkTrace();
  const [open, setOpen] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [report, setReport] = useState<string | null>(null);
  // После «Связать заново» следов нет, но итог («связано: N») должен остаться виден.
  if (!ticket.relations.traces.length && !report) return null;
  return (
    <section aria-label={t("trace.title")} className="parent-traces">
      <h3 className="ui-eyebrow">{t("trace.title")}</h3>
      {relink.isError ? <Notice error={errorText(relink.error)} onDismiss={() => relink.reset()} /> : null}
      {report ? <Notice message={report} onDismiss={() => setReport(null)} /> : null}
      <ul className="relation-list">
        {ticket.relations.traces.map((trace: ParentTrace) => (
          <li className="relation-row parent-trace" key={trace.id}>
            <Footprints aria-hidden="true" size={16} />
            <span className="parent-trace__text">
              {t("trace.line", {
                key: trace.parentKey,
                title: trace.parentTitle,
                state: trace.parentState === "purged" ? t("trace.purged") : t("trace.deleted"),
                date: new Date(trace.removedAt).toLocaleDateString(locale),
              })}
              {trace.others ? ` · ${t("trace.others", { count: trace.others })}` : ""}
              {spaceSlug ? (
                <>
                  {" · "}
                  <Link to={`/spaces/${spaceSlug}?q=${encodeURIComponent(`parentTrace(${trace.parentKey})`)}`}>
                    parentTrace({trace.parentKey})
                  </Link>
                </>
              ) : null}
            </span>
            {ticket.permissions.move ? (
              <Button onClick={() => setOpen(open === trace.id ? null : trace.id)} variant="secondary">
                {t("trace.relink")}
              </Button>
            ) : null}
            {open === trace.id ? (
              <form
                className="inline-form parent-trace__form"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  relink.mutate(
                    { parentKey: trace.parentKey, ...(target.trim() ? { toKey: target.trim().toUpperCase() } : {}) },
                    {
                      onSuccess: (result) => {
                        setOpen(null);
                        setTarget("");
                        setReport(
                          t("trace.done", { count: result.relinked.length }) +
                            (result.skipped.length
                              ? ` ${t("trace.skipped", { keys: result.skipped.map((item) => item.key).join(", ") })}`
                              : ""),
                        );
                      },
                    },
                  );
                }}
              >
                <Input
                  hint={t("trace.targetHint", { count: trace.others + 1 })}
                  label={t("trace.target")}
                  maxLength={40}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder="AOS-230"
                  required
                  value={target}
                />
                <Button loading={relink.isPending} type="submit">
                  {t("trace.relinkAll", { count: trace.others + 1 })}
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Страница «Корзина» ----

export function TrashPage() {
  const { t, locale } = useI18n();
  const me = useMe();
  const errorText = useErrorText();
  const spaces = useSpaces();
  const [spaceId, setSpaceId] = useState("");
  const trash = useTrash(spaceId || undefined);
  const restore = useRestoreTickets();
  const purge = usePurgeTickets();
  const save = useSaveTrashSettings();
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [days, setDays] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const settings = trash.data?.settings;
  const failed = [restore, purge, save].find((mutation) => mutation.isError);

  return (
    <section className="page trash-page">
      <header className="page-header">
        <h1>
          <TrashIcon aria-hidden="true" size={24} /> {t("trash.title")}
        </h1>
        <p className="ui-field__hint">
          {settings ? t("trash.rule", { days: settings.retentionDays }) : ""}
          {settings?.lastPurgeAt
            ? ` ${t("trash.lastPurge", { date: new Date(settings.lastPurgeAt).toLocaleString(locale) })}`
            : ""}
        </p>
      </header>
      <div className="trash-controls">
        <Select label={t("trash.space")} onChange={(event) => setSpaceId(event.target.value)} value={spaceId}>
          <option value="">{t("trash.allSpaces")}</option>
          {(spaces.data?.items ?? []).map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </Select>
        {me.data?.user.role === "superadmin" && settings ? (
          <form
            className="trash-retention"
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(days);
              if (value >= 1) save.mutate({ retentionDays: value }, { onSuccess: () => setDays("") });
            }}
          >
            <Input
              label={t("trash.retention")}
              max={3650}
              min={1}
              onChange={(event) => setDays(event.target.value)}
              placeholder={String(settings.retentionDays)}
              type="number"
              value={days}
            />
            <Button loading={save.isPending} type="submit" variant="secondary">
              {t("common.save")}
            </Button>
          </form>
        ) : null}
      </div>
      {failed ? <Notice error={errorText(failed.error)} onDismiss={() => failed.reset()} /> : null}
      {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}
      {trash.isPending ? <Loading /> : null}
      {trash.isError ? <ErrorState error={trash.error} onRetry={() => void trash.refetch()} /> : null}
      {trash.data && !trash.data.items.length ? (
        <Card className="empty-state">
          <TrashIcon aria-hidden="true" size={32} />
          <p>{t("trash.empty", { days: settings?.retentionDays ?? 90 })}</p>
        </Card>
      ) : null}
      {trash.data?.items.length ? (
        <ul className="trash-list">
          {trash.data.items.map((item) => (
            <li className="ui-card trash-item" key={item.key}>
              <div className="trash-item__main">
                <strong>
                  <span className="ticket-key">{item.key}</span> {item.title}
                </strong>
                <span className="ui-field__hint">
                  {item.spaceName} ·{" "}
                  {t("trash.deletedBy", {
                    name: item.deletedBy?.name ?? "—",
                    date: new Date(item.deletedAt).toLocaleString(locale),
                  })}{" "}
                  · {t("trash.purgeAt", { date: new Date(item.purgeAt).toLocaleDateString(locale) })}
                  {item.relations ? ` · ${t("trash.relations", { count: item.relations })}` : ""}
                </span>
              </div>
              <div className="trash-item__actions">
                {item.canRestore ? (
                  <Button
                    loading={restore.isPending && restore.variables?.keys?.[0] === item.key}
                    onClick={() =>
                      restore.mutate(
                        { keys: [item.key] },
                        {
                          onSuccess: (result) =>
                            setNotice(
                              t("trash.restoredMany", { keys: result.restored.map((entry) => entry.key).join(", ") }) +
                                (result.skipped.length
                                  ? ` ${t("trash.skipped", { keys: result.skipped.map((entry) => entry.key).join(", ") })}`
                                  : ""),
                            ),
                        },
                      )
                    }
                    variant="secondary"
                  >
                    <ArrowCounterClockwise aria-hidden="true" size={16} /> {t("trash.restore")}
                  </Button>
                ) : null}
                {item.canPurge ? (
                  confirmPurge === item.key ? (
                    <span className="trash-item__confirm" role="group" aria-label={t("trash.purgeConfirm")}>
                      <span>{t("trash.purgeConfirm")}</span>
                      <Button
                        loading={purge.isPending}
                        onClick={() => purge.mutate({ keys: [item.key] }, { onSettled: () => setConfirmPurge(null) })}
                        variant="danger"
                      >
                        {t("trash.purgeYes")}
                      </Button>
                      <Button onClick={() => setConfirmPurge(null)} variant="ghost">
                        {t("common.cancel")}
                      </Button>
                    </span>
                  ) : (
                    <Button onClick={() => setConfirmPurge(item.key)} variant="ghost">
                      {t("trash.purge")}
                    </Button>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---- Колокольчик (R-2.27) ----
