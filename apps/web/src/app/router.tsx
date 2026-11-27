import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useMe } from "../api/hooks";
import { useI18n } from "../i18n";
import { ErrorState, Loading } from "./states";

const LoginPage = lazy(() => import("../features/auth/LoginPage").then((m) => ({ default: m.LoginPage })));
const AppShell = lazy(() => import("../components/AppShell").then((m) => ({ default: m.AppShell })));
const SpacesPage = lazy(() => import("../features/spaces/SpacesPage").then((m) => ({ default: m.SpacesPage })));
const SpacePage = lazy(() => import("../features/spaces/SpacePage").then((m) => ({ default: m.SpacePage })));
const PeoplePage = lazy(() => import("../features/directory/PeoplePage").then((m) => ({ default: m.PeoplePage })));
const CatalogReportPage = lazy(() =>
  import("../features/directory/CatalogReportPage").then((m) => ({ default: m.CatalogReportPage })),
);
const PersonPage = lazy(() => import("../features/directory/PersonPage").then((m) => ({ default: m.PersonPage })));
const GroupsPage = lazy(() => import("../features/directory/GroupPages").then((m) => ({ default: m.GroupsPage })));
const GroupPage = lazy(() => import("../features/directory/GroupPages").then((m) => ({ default: m.GroupPage })));
const DimensionsPage = lazy(() =>
  import("../features/directory/DimensionPages").then((m) => ({ default: m.DimensionsPage })),
);
const DimensionPage = lazy(() =>
  import("../features/directory/DimensionPages").then((m) => ({ default: m.DimensionPage })),
);
const TypesPage = lazy(() => import("../features/setup/TypePages").then((m) => ({ default: m.TypesPage })));
const TypePage = lazy(() => import("../features/setup/TypePages").then((m) => ({ default: m.TypePage })));
const SchemePage = lazy(() => import("../features/setup/SchemePage").then((m) => ({ default: m.SchemePage })));
const TicketPage = lazy(() => import("../features/tickets/TicketPage").then((m) => ({ default: m.TicketPage })));
const TemplatePage = lazy(() => import("../features/setup/TemplatePage").then((m) => ({ default: m.TemplatePage })));
const FieldsPage = lazy(() => import("../features/setup/FieldPages").then((m) => ({ default: m.FieldsPage })));
const FieldPage = lazy(() => import("../features/setup/FieldPages").then((m) => ({ default: m.FieldPage })));
const EstimatesPage = lazy(() => import("../features/setup/EstimatesPage").then((m) => ({ default: m.EstimatesPage })));
const SearchPage = lazy(() => import("../features/search/SearchPage").then((m) => ({ default: m.SearchPage })));
const TrashPage = lazy(() => import("../features/trash/Trash").then((m) => ({ default: m.TrashPage })));
const AccessPage = lazy(() => import("../features/access/AccessPage").then((m) => ({ default: m.AccessPage })));
const ProfilePage = lazy(() => import("../features/access/AccessPage").then((m) => ({ default: m.ProfilePage })));
const TreePage = lazy(() => import("../features/tickets/TreePage").then((m) => ({ default: m.TreePage })));
const LinkTypesPage = lazy(() => import("../features/setup/LinkTypesPage").then((m) => ({ default: m.LinkTypesPage })));
const AttachmentSettingsPage = lazy(() =>
  import("../features/setup/AttachmentSettingsPage").then((m) => ({ default: m.AttachmentSettingsPage })),
);
const BoardsPage = lazy(() => import("../features/boards/BoardsPage").then((m) => ({ default: m.BoardsPage })));
const BoardPage = lazy(() => import("../features/boards/BoardPage").then((m) => ({ default: m.BoardPage })));
const NotificationSettingsPage = lazy(() =>
  import("../features/notifications/Bell").then((m) => ({ default: m.NotificationSettingsPage })),
);
const SessionsPage = lazy(() => import("../features/sessions/SessionsPage").then((m) => ({ default: m.SessionsPage })));

/** Язык профиля — главный источник после входа. */
function useProfileLocale() {
  const me = useMe();
  const { locale, setLocale } = useI18n();
  const profileLocale = me.data?.user.locale;
  useEffect(() => {
    if (profileLocale && profileLocale !== locale) setLocale(profileLocale);
  }, [profileLocale]);
}

function PublicOnly() {
  const me = useMe();
  if (me.isPending) return <Loading />;
  if (me.data) return <Navigate replace to="/" />;
  return <LoginPage />;
}

function Protected() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Loading />;
  if (me.isError)
    return (
      <main className="route-error">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  if (!me.data) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate replace to={returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }
  return <AppShell me={me.data} />;
}

export function AppRoutes() {
  useProfileLocale();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<PublicOnly />} path="/login" />
        <Route element={<Protected />}>
          <Route element={<SpacesPage />} path="/" />
          <Route element={<SpacePage />} path="/spaces/:slug" />
          <Route element={<TreePage />} path="/spaces/:slug/tree" />
          <Route element={<BoardsPage />} path="/boards" />
          <Route element={<BoardPage />} path="/boards/:id" />
          <Route element={<TrashPage />} path="/trash" />
          <Route element={<SearchPage />} path="/search" />
          <Route element={<AccessPage />} path="/access" />
          <Route element={<ProfilePage />} path="/access/profiles/:id" />
          <Route element={<NotificationSettingsPage />} path="/settings/notifications" />
          <Route element={<SessionsPage />} path="/settings/sessions" />
          <Route element={<PeoplePage />} path="/people" />
          <Route element={<CatalogReportPage />} path="/people/catalog-report" />
          <Route element={<TypesPage />} path="/types" />
          <Route element={<TypePage />} path="/types/:id" />
          <Route element={<SchemePage />} path="/types/:id/scheme" />
          <Route element={<TicketPage />} path="/tickets/:key" />
          <Route element={<TemplatePage />} path="/templates/:id" />
          <Route element={<FieldsPage />} path="/fields" />
          <Route element={<FieldPage />} path="/fields/:id" />
          <Route element={<EstimatesPage />} path="/estimates" />
          <Route element={<LinkTypesPage />} path="/link-types" />
          <Route element={<AttachmentSettingsPage />} path="/attachment-settings" />
          <Route element={<PersonPage />} path="/people/:id" />
          <Route element={<GroupsPage kind="guilds" />} path="/guilds" />
          <Route element={<GroupPage kind="guilds" />} path="/guilds/:id" />
          <Route element={<GroupsPage kind="feature-teams" />} path="/teams" />
          <Route element={<GroupPage kind="feature-teams" />} path="/teams/:id" />
          <Route element={<DimensionsPage />} path="/dimensions" />
          <Route element={<DimensionPage />} path="/dimensions/:id" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
