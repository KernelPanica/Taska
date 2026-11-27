import { At, Bell, ChatText, ClockCounterClockwise, Swap, UserPlus, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import {
  NOTIFICATION_KINDS,
  type AppNotification,
  type NotificationKind,
  type NotificationSetting,
  type NotificationTicket,
} from "@yourtask/contracts";
import { api } from "../../api/client";
import { useNotifications, useReadNotifications } from "../../api/hooks";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { PageHeader } from "../directory/shared";

/**
 * Колокольчик (R-2.27, YT-18): список, новое и прочитанное, переход к тикету; пакет — одна запись,
 * живая запись обновляется на месте. Новое всплывает подсказкой; что скрыто от читателя или от роли
 * «Режима показа», сервер не отдаёт.
 */
const ICONS: Record<NotificationKind, typeof Bell> = {
  assigned: UserPlus,
  mentioned: At,
  status_changed: Swap,
  commented: ChatText,
  team_ticket_trashed: ClockCounterClockwise,
};

type Translate = ReturnType<typeof useI18n>["t"];

/** Текст уведомления и куда ведёт ссылка: один тикет — в карточку, пакет — в поиск по ключам. */
export function describeNotification(item: AppNotification, t: Translate) {
  const name = item.actor?.name ?? t("bell.system");
  const label = (ticket: NotificationTicket) =>
    ticket.available ? `${ticket.key} «${ticket.title}»` : t("bell.hiddenTicket");
  const list =
    item.tickets.slice(0, 3).map(label).join(", ") +
    (item.tickets.length > 3 ? ` ${t("bell.andMore", { count: item.tickets.length - 3 })}` : "");
  const first = item.tickets[0];
  const single = item.tickets.length === 1;
  const last = item.entries[item.entries.length - 1];
  let text: string;
  switch (item.kind) {
    case "assigned":
      text = single
        ? t("bell.assigned", { name, ticket: list })
        : t("bell.assignedMany", { name, count: item.tickets.length, list });
      break;
    case "mentioned":
      text = t("bell.mentioned", { name, ticket: list });
      break;
    case "status_changed": {
      if (single) {
        const path = [item.entries[0]?.from, ...item.entries.map((entry) => entry.to)].filter(Boolean).join(" → ");
        text = path ? t("bell.status", { name, ticket: list, path }) : t("bell.statusHidden", { name, ticket: list });
      } else {
        const targets = [...new Set(item.entries.map((entry) => entry.to).filter(Boolean))];
        text = t("bell.statusMany", {
          name,
          count: item.tickets.length,
          to: targets.length === 1 ? `→ ${targets[0]}` : "",
          list,
        });
      }
      break;
    }
    case "commented":
      text =
        single && item.entries.length > 1
          ? t("bell.commentsMany", { count: item.entries.length, ticket: list })
          : single
            ? t("bell.commented", { name, ticket: list })
            : t("bell.commentedMany", { name, count: item.tickets.length, list });
      break;
    default:
      text = t("bell.trashed", { name, keys: list });
  }
  const visible = item.tickets.filter((ticket) => ticket.available && ticket.key);
  const href =
    item.kind === "team_ticket_trashed"
      ? "/trash"
      : single && first?.available
        ? `/tickets/${first.key}`
        : visible.length
          ? `/search?q=${encodeURIComponent(`key in (${visible.map((ticket) => ticket.key).join(", ")})`)}`
          : null;
  const excerpt = item.kind === "mentioned" || item.kind === "commented" ? (last?.excerpt ?? null) : null;
  return { text, href, excerpt };
}

export function NotificationBell({ sidebar = false }: { sidebar?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [position, setPosition] = useState({ top: 60, left: 16, maxHeight: 400 });
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const notifications = useNotifications();
  const read = useReadNotifications();
  const [open, setOpen] = useState(false);
  const [popups, setPopups] = useState<{ id: string; text: string; href: string | null }[]>([]);
  const seen = useRef<Map<string, string> | null>(null);
  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.items ?? [];

  // Новое и обновлённое после первой загрузки — всплывает подсказкой (то, что видит колокольчик, и только оно).
  useEffect(() => {
    if (!notifications.data) return;
    const now = new Map(notifications.data.items.map((item) => [item.id, item.updatedAt]));
    if (seen.current) {
      const fresh = notifications.data.items.filter(
        (item) => !item.read && seen.current?.get(item.id) !== item.updatedAt,
      );
      if (fresh.length) {
        setPopups((current) =>
          [
            ...fresh.map((item) => ({ id: `${item.id}:${item.updatedAt}`, ...describeNotification(item, t) })),
            ...current,
          ].slice(0, 3),
        );
      }
    }
    seen.current = now;
  }, [notifications.data, t]);
  useEffect(() => {
    if (!popups.length) return;
    const timer = setTimeout(() => setPopups((current) => current.slice(0, -1)), 6000);
    return () => clearTimeout(timer);
  }, [popups]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(384, window.innerWidth - 32);
      const top = Math.max(60, Math.min(rect.top, window.innerHeight - 240));
      const left = Math.max(16, Math.min(rect.right + 8, window.innerWidth - width - 16));
      setPosition({ top, left, maxHeight: Math.max(80, window.innerHeight - top - 16) });
    };
    place();
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open]);

  const go = (item: AppNotification, href: string | null) => {
    if (!item.read) read.mutate({ ids: [item.id] });
    setOpen(false);
    if (href) navigate(href);
  };

  return (
    <div className="bell" ref={root}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        ref={trigger}
        title={t("shell.notifications")}
        aria-label={unread ? t("bell.labelUnread", { count: unread }) : t("bell.label")}
        className={sidebar ? "app-navigation__link bell__button bell__button--sidebar" : "ui-icon-button bell__button"}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Bell aria-hidden="true" size={20} weight={unread ? "fill" : "regular"} />
        {sidebar ? <span>{t("shell.notifications")}</span> : null}
        {unread ? (
          <span aria-hidden="true" className="bell__count">
            {unread}
          </span>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div
              aria-label={t("bell.label")}
              className="bell__panel"
              role="region"
              ref={panel}
              id={panelId}
              tabIndex={-1}
              style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}
            >
              <div className="bell__head">
                <strong>{t("bell.label")}</strong>
                {unread ? (
                  <button className="bell__all" onClick={() => read.mutate({})} type="button">
                    {t("bell.readAll")}
                  </button>
                ) : null}
                <Link className="bell__all" onClick={() => setOpen(false)} to="/settings/notifications">
                  {t("bell.settings")}
                </Link>
              </div>
              {items.length ? (
                <ul>
                  {items.map((item) => {
                    const Icon = ICONS[item.kind] ?? Bell;
                    const { text, href, excerpt } = describeNotification(item, t);
                    return (
                      <li className={item.read ? "" : "is-unread"} key={item.id}>
                        <Icon aria-hidden="true" size={18} />
                        <button className="bell__item" onClick={() => go(item, href)} type="button">
                          {item.read ? null : <span className="bell__new">{t("bell.new")}</span>}
                          <span>{text}</span>
                          {excerpt ? <span className="bell__excerpt">«{excerpt}»</span> : null}
                          <span className="ui-field__hint">
                            {new Date(item.updatedAt).toLocaleString(locale)}
                            {item.batch ? ` · ${t("bell.batch")}` : ""}
                            {item.live && item.entries.length > 1
                              ? ` · ${t("bell.live", { count: item.entries.length })}`
                              : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="ui-field__hint">{t("bell.empty")}</p>
              )}
            </div>,
            document.body,
          )
        : null}
      {popups.length
        ? createPortal(
            <div aria-live="polite" className="bell__popups" role="status">
              {popups.map((popup) => (
                <div className="bell__popup" key={popup.id}>
                  <Bell aria-hidden="true" size={18} />
                  {popup.href ? (
                    <Link
                      onClick={() => setPopups((current) => current.filter((item) => item !== popup))}
                      to={popup.href}
                    >
                      {popup.text}
                    </Link>
                  ) : (
                    <span>{popup.text}</span>
                  )}
                  <button
                    aria-label={t("common.dismiss")}
                    className="ui-icon-button"
                    onClick={() => setPopups((current) => current.filter((item) => item !== popup))}
                    type="button"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Профиль → «Уведомления»: каждый вид событий R-2.27 включается и выключается. */
export function NotificationSettingsPage() {
  const { t } = useI18n();
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["notification-settings"],
    queryFn: ({ signal }) => api<{ items: NotificationSetting[] }>("/api/v1/me/notification-settings", { signal }),
  });
  const save = useMutation({
    mutationFn: (items: NotificationSetting[]) =>
      api<{ items: NotificationSetting[] }>("/api/v1/me/notification-settings", {
        method: "PUT",
        body: JSON.stringify({ items }),
      }),
    onSuccess: (data) => client.setQueryData(["notification-settings"], data),
  });
  if (settings.isPending) return <Loading />;
  if (settings.isError) return <ErrorState error={settings.error} />;
  const enabled = new Map(settings.data.items.map((item) => [item.kind, item.enabled]));
  return (
    <section className="page">
      <PageHeader description={t("notify.lead")} title={t("notify.title")} />
      <ul className="notify-settings">
        {NOTIFICATION_KINDS.map((kind) => {
          const on = enabled.get(kind) ?? true;
          return (
            <li key={kind}>
              <label>
                <input
                  checked={on}
                  onChange={(event) => save.mutate([{ kind, enabled: event.target.checked }])}
                  type="checkbox"
                />
                <span>
                  <strong>{t(`notify.kind.${kind}` as MessageKey)}</strong>
                  <span className="ui-field__hint">{t(`notify.hint.${kind}` as MessageKey)}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {save.isSuccess ? <p role="status">{t("notify.saved")}</p> : null}
    </section>
  );
}
