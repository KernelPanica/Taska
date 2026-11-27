import {
  BookOpen,
  Columns,
  Kanban,
  Rows,
  Ruler,
  Shapes,
  DeviceMobile,
  List,
  ListBullets,
  SquaresFour,
  Trash,
  MagnifyingGlass,
  Stack,
  UsersFour,
  UsersThree,
  X,
  LockSimple,
  LinkSimple,
  Paperclip,
  User,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LensBanner } from "./LensControl";
import { AppBar } from "./AppBar";
import { UndoToast } from "../features/trash/Trash";
import { NotificationBell } from "../features/notifications/Bell";
import { CommandPalette } from "../features/search/SearchPage";
import type { Me } from "@yourtask/contracts";
import { useBoards, useLiveTickets } from "../api/boards";
import { useI18n } from "../i18n";
import { BrandMark } from "./Brand";
const SIDEBAR_MIN = 72;
const SIDEBAR_MAX = 360;
const SIDEBAR_KEY = "yourtask.sidebar-width";
const boundWidth = (width: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width));

export function AppShell({ me }: { me: Me }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_KEY);
      const width = stored === null ? 256 : Number(stored);
      return Number.isFinite(width) ? boundWidth(width) : 256;
    } catch {
      return 256;
    }
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
    } catch {
      /* Storage can be unavailable. */
    }
  }, [sidebarWidth]);
  const header = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const boards = useBoards();
  useLiveTickets();

  useEffect(() => {
    const element = header.current;
    const frame = element?.parentElement;
    if (!element || !frame) return;
    const measure = () => frame.style.setProperty("--app-header-height", `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      frame.style.removeProperty("--app-header-height");
    };
  }, []);

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest(".bell__panel"))) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const organization = [
    { to: "/", label: t("shell.spaces"), icon: SquaresFour, end: true },
    { to: "/boards", label: t("shell.boards"), icon: Kanban, end: true },
    {
      to: "/people",
      label: t("shell.people"),
      icon: UsersThree,
      end: location.pathname === `/people/${me.user.id}`,
    },
    { to: "/teams", label: t("shell.teams"), icon: UsersFour, end: false },
    { to: "/guilds", label: t("shell.guilds"), icon: Stack, end: false },
    { to: "/dimensions", label: t("shell.dimensions"), icon: ListBullets, end: false },
    { to: "/trash", label: t("shell.trash"), icon: Trash, end: false },
  ];
  const meLinks = [
    { to: "/settings/sessions", label: t("shell.sessions"), icon: DeviceMobile, end: false },
    { to: `/people/${me.user.id}`, label: t("shell.profile"), icon: User, end: false },
  ];
  const setup =
    me.user.role === "superadmin"
      ? [
          { to: "/types", label: t("shell.types"), icon: Shapes, end: false },
          { to: "/fields", label: t("shell.fields"), icon: Rows, end: false },
          { to: "/estimates", label: t("shell.estimates"), icon: Ruler, end: false },
          { to: "/link-types", label: t("shell.linkTypes"), icon: LinkSimple, end: false },
          { to: "/attachment-settings", label: t("shell.attachments"), icon: Paperclip, end: false },
          { to: "/access", label: t("shell.access"), icon: LockSimple, end: false },
        ]
      : [];

  const renderLinks = (items: typeof organization) =>
    items.map(({ to, label, icon: Icon, end }) => (
      <NavLink
        className={({ isActive }) => `app-navigation__link ${isActive ? "is-active" : ""}`}
        aria-label={label}
        title={label}
        end={end}
        key={to}
        to={to}
      >
        <Icon aria-hidden="true" size={20} />
        <span>{label}</span>
      </NavLink>
    ));

  return (
    <div
      className={`app-shell with-appbar ${sidebarWidth < 160 ? "is-sidebar-compact" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <a className="skip-link" href="#main-content">
        {t("app.skipToContent")}
      </a>
      <AppBar
        end={
          <button
            aria-controls="app-sidebar"
            aria-expanded={open}
            aria-label={t("common.openNavigation")}
            className="ui-icon-button app-topbar__menu"
            onClick={() => setOpen(!open)}
            type="button"
          >
            <List aria-hidden="true" size={24} />
          </button>
        }
      />
      <aside className={`app-sidebar ${open ? "is-open" : ""}`} id="app-sidebar">
        <div className="app-sidebar__brand">
          <NavLink aria-label={t("app.name")} className="app-brand" to="/">
            <BrandMark />
            <span>{t("app.name")}</span>
          </NavLink>
          <button
            aria-label={t("common.closeNavigation")}
            className="ui-icon-button app-sidebar__close"
            onClick={() => setOpen(false)}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <nav aria-label={t("shell.navigation")} className="app-navigation">
          <NavLink
            aria-label={t("shell.search")}
            title={t("shell.search")}
            className={({ isActive }) => `app-navigation__link ${isActive ? "is-active" : ""}`}
            to="/search"
          >
            <MagnifyingGlass aria-hidden="true" size={20} />
            <span>{t("shell.search")}</span>
          </NavLink>
          <div aria-label={t("shell.organization")} className="app-navigation__group" role="group">
            <span className="ui-eyebrow app-navigation__section">{t("shell.organization")}</span>
            {renderLinks(organization)}
          </div>
          <div aria-label={t("shell.myBoards")} className="app-navigation__group" role="group">
            <span className="ui-eyebrow app-navigation__section">{t("shell.myBoards")}</span>
            {boards.data?.items.map((board) => (
              <NavLink
                className={({ isActive }) =>
                  `app-navigation__link app-navigation__link--board ${isActive ? "is-active" : ""}`
                }
                aria-label={board.kind === "mine" ? t("boards.mine") : board.name}
                title={board.kind === "mine" ? t("boards.mine") : board.name}
                key={board.id}
                to={`/boards/${board.id}`}
              >
                <Columns aria-hidden="true" size={18} />
                <span>{board.kind === "mine" ? t("boards.mine") : board.name}</span>
              </NavLink>
            ))}
          </div>
          <div aria-label={t("shell.me")} className="app-navigation__group" role="group">
            <span className="ui-eyebrow app-navigation__section">{t("shell.me")}</span>
            <NotificationBell sidebar />
            {renderLinks(meLinks)}
          </div>
          {me.user.role === "superadmin" ? (
            <div aria-label={t("shell.setup")} className="app-navigation__group" role="group">
              <span className="ui-eyebrow app-navigation__section">{t("shell.setup")}</span>
              {renderLinks(setup)}
              <a
                aria-label={t("shell.apiDocs")}
                title={t("shell.apiDocs")}
                className="app-navigation__link"
                href="/api/docs"
                rel="noreferrer"
                target="_blank"
              >
                <BookOpen aria-hidden="true" size={20} />
                <span>{t("shell.apiDocs")}</span>
              </a>
            </div>
          ) : null}
        </nav>
        <div
          aria-label={t("shell.resizeSidebar")}
          aria-controls="app-sidebar"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={sidebarWidth}
          className="app-sidebar__resize"
          role="separator"
          tabIndex={0}
          onKeyDown={(event) => {
            const next =
              event.key === "Home"
                ? SIDEBAR_MIN
                : event.key === "End"
                  ? SIDEBAR_MAX
                  : event.key === "ArrowLeft"
                    ? sidebarWidth - 16
                    : event.key === "ArrowRight"
                      ? sidebarWidth + 16
                      : null;
            if (next === null) return;
            event.preventDefault();
            setSidebarWidth(boundWidth(next));
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            drag.current = { x: event.clientX, width: sidebarWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current) setSidebarWidth(boundWidth(drag.current.width + event.clientX - drag.current.x));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        />
      </aside>
      {open ? (
        <button
          aria-label={t("common.closeNavigation")}
          className="app-navigation__backdrop"
          onClick={() => setOpen(false)}
          type="button"
        />
      ) : null}
      <div className="app-frame">
        <div className="app-header" ref={header}>
          <LensBanner me={me} />
        </div>
        <main className="app-main" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
        <UndoToast />
        <CommandPalette />
      </div>
    </div>
  );
}
