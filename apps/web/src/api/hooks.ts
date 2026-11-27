import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SavedFilter,
  SavedFilterInput,
  SearchResult,
  TqlVocabulary,
  AppNotification,
  PurgeInput,
  RelinkInput,
  RelinkResult,
  RestoreInput,
  RestoreResult,
  TrashInput,
  TrashItem,
  TrashResult,
  TrashSettings,
  TrashTicketRef,
  Attachment,
  AttachmentSettings,
  CommentMentions,
  LinkType,
  LinkTypeInput,
  TicketLinkInput,
  WebLink,
  WebLinkInput,
  AccessGrant,
  AccessGrantInput,
  AccessProfile,
  AccessProfileInput,
  MoveInput,
  SecurityEvent,
  TicketTree,
  VisibilityInput,
  WrapInput,
  HistoryEntry,
  TicketComment,
  StatusScheme,
  StatusSchemeInput,
  Ticket,
  TicketCreateInput,
  TicketPatch,
  TicketSummary,
  Converter,
  ConverterEntry,
  EstimateScale,
  EstimateScaleInput,
  TicketField,
  TicketFieldInput,
  TicketTemplate,
  TicketTemplateInput,
  TicketType,
  TicketTypeInput,
  CatalogReport,
  CatalogResolution,
  Dimension,
  DimensionInput,
  FeatureTeam,
  FeatureTeamInput,
  Locale,
  Me,
  Page,
  Person,
  PersonInput,
  SessionInfo,
  Space,
  Guild,
  GuildInput,
} from "@yourtask/contracts";
import { api, ApiError, setCsrfToken } from "./client";

export const keys = {
  me: ["me"] as const,
  spaces: ["spaces"] as const,
  space: (slug: string) => ["spaces", slug] as const,
  sessions: ["me", "sessions"] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async ({ signal }) => {
      try {
        const me = await api<Me>("/api/v1/me", { signal });
        setCsrfToken(me.csrfToken);
        return me;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw error;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });
}

export function useUpdateLocale() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (locale: Locale) => api<Me>("/api/v1/me", { method: "PATCH", body: JSON.stringify({ locale }) }),
    onSuccess: (me) => client.setQueryData(keys.me, me),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/v1/auth/logout", { method: "POST" }),
    onSuccess: () => {
      setCsrfToken(null);
      client.clear();
      client.setQueryData(keys.me, null);
    },
  });
}

export function useSpaces() {
  return useQuery({ queryKey: keys.spaces, queryFn: ({ signal }) => api<Page<Space>>("/api/v1/spaces", { signal }) });
}

export function useSpace(slug: string) {
  return useQuery({
    queryKey: keys.space(slug),
    queryFn: ({ signal }) => api<Space>(`/api/v1/spaces/${encodeURIComponent(slug)}`, { signal }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: keys.sessions,
    queryFn: ({ signal }) => api<Page<SessionInfo>>("/api/v1/me/sessions", { signal }),
  });
}

export function useRevokeSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}

export function useRevokeOtherSessions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ revoked: number }>("/api/v1/me/sessions/revoke-others", { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}

// ---- Справочники (YT-02) ----

export const directoryKeys = {
  people: ["people"] as const,
  guilds: ["guilds"] as const,
  teams: ["feature-teams"] as const,
  dimensions: ["dimensions"] as const,
  catalog: ["catalog-report"] as const,
  types: ["ticket-types"] as const,
  templates: ["ticket-templates"] as const,
  fields: ["fields"] as const,
  scales: ["estimate-scales"] as const,
  converter: ["estimate-converter"] as const,
  schemes: ["status-schemes"] as const,
};

function useList<T>(key: readonly string[], path: string) {
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api<Page<T>>(path, { signal }) });
}

function useItem<T>(key: readonly string[], path: string) {
  return useQuery({
    queryKey: [...key, path],
    queryFn: ({ signal }) => api<T>(path, { signal }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });
}

/** Любое изменение справочника обновляет все справочники: в них перекрёстные ссылки. */
function useDirectoryMutation<TInput, TResult>(method: string, path: (input: TInput) => string, body = true) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) =>
      api<TResult>(path(input), {
        method,
        ...(body ? { body: JSON.stringify((input as { body?: unknown }).body ?? input) } : {}),
      }),
    onSuccess: () =>
      Promise.all(
        [...Object.values(directoryKeys), keys.spaces].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}

/** Активные люди — их можно назначать; с includeDeactivated — все, включая ушедших. */
export const usePeople = (includeDeactivated = false) =>
  useList<Person>(
    [...directoryKeys.people, includeDeactivated ? "all" : "active"],
    includeDeactivated ? "/api/v1/people?includeDeactivated=true" : "/api/v1/people",
  );
export const usePerson = (id: string) =>
  useItem<Person>(directoryKeys.people, `/api/v1/people/${encodeURIComponent(id)}`);
export const useUpdatePerson = () =>
  useDirectoryMutation<{ id: string; body: Partial<PersonInput> }, Person>("PATCH", ({ id }) => `/api/v1/people/${id}`);

export type GroupKind = "guilds" | "feature-teams";
export type Group = Guild | FeatureTeam;
export const useGroups = (kind: GroupKind) =>
  useList<Group>(kind === "guilds" ? directoryKeys.guilds : directoryKeys.teams, `/api/v1/${kind}`);
export const useGroup = (kind: GroupKind, id: string) =>
  useItem<Group>(
    kind === "guilds" ? directoryKeys.guilds : directoryKeys.teams,
    `/api/v1/${kind}/${encodeURIComponent(id)}`,
  );
export const useCreateGroup = (kind: GroupKind) =>
  useDirectoryMutation<GuildInput | FeatureTeamInput, Group>("POST", () => `/api/v1/${kind}`);
export const useUpdateGroup = (kind: GroupKind) =>
  useDirectoryMutation<{ id: string; body: Partial<GuildInput & FeatureTeamInput> }, Group>(
    "PATCH",
    ({ id }) => `/api/v1/${kind}/${id}`,
  );
export const useDeleteGroup = (kind: GroupKind) =>
  useDirectoryMutation<string, void>("DELETE", (id) => `/api/v1/${kind}/${id}`, false);

export const useDimensions = () => useList<Dimension>(directoryKeys.dimensions, "/api/v1/dimensions");
export const useDimension = (id: string) =>
  useItem<Dimension>(directoryKeys.dimensions, `/api/v1/dimensions/${encodeURIComponent(id)}`);
export const useCreateDimension = () =>
  useDirectoryMutation<DimensionInput, Dimension>("POST", () => "/api/v1/dimensions");
export const useUpdateDimension = () =>
  useDirectoryMutation<{ id: string; body: { name?: string; multiple?: boolean; options?: string[] } }, Dimension>(
    "PATCH",
    ({ id }) => `/api/v1/dimensions/${id}`,
  );
export const useDeleteDimension = () =>
  useDirectoryMutation<string, void>("DELETE", (id) => `/api/v1/dimensions/${id}`, false);

export const useCreateSpace = () => useDirectoryMutation<{ name: string }, Space>("POST", () => "/api/v1/spaces");
export const useRenameSpace = () =>
  useDirectoryMutation<{ id: string; body: { name?: string; enforceSubordination?: boolean } }, Space>(
    "PATCH",
    ({ id }) => `/api/v1/spaces/${id}`,
  );

// ---- Каталог YourSpace (YT-03) ----

export const useCatalogReport = () =>
  useQuery({
    queryKey: directoryKeys.catalog,
    queryFn: ({ signal }) => api<CatalogReport>("/api/v1/catalog/report", { signal }),
  });
export const useCatalogSync = () =>
  useDirectoryMutation<void, CatalogReport>("POST", () => "/api/v1/catalog/sync", false);
export const useResolveCatalogRow = () =>
  useDirectoryMutation<{ id: string; body: CatalogResolution }, CatalogReport>(
    "POST",
    ({ id }) => `/api/v1/catalog/report/${encodeURIComponent(id)}/resolve`,
  );

// ---- Конструктор типов, полей, шаблонов и оценок (YT-04) ----

export const useTicketTypes = () => useList<TicketType>(directoryKeys.types, "/api/v1/ticket-types");
export const useTicketType = (id: string) =>
  useItem<TicketType>(directoryKeys.types, `/api/v1/ticket-types/${encodeURIComponent(id)}`);
export const useCreateTicketType = () =>
  useDirectoryMutation<TicketTypeInput, TicketType>("POST", () => "/api/v1/ticket-types");
export const useUpdateTicketType = () =>
  useDirectoryMutation<{ id: string; body: Partial<TicketTypeInput> }, TicketType>(
    "PATCH",
    ({ id }) => `/api/v1/ticket-types/${id}`,
  );
export const useDeleteTicketType = () =>
  useDirectoryMutation<string, void>("DELETE", (id) => `/api/v1/ticket-types/${id}`, false);

export const useTicketTemplate = (id: string) =>
  useItem<TicketTemplate>(directoryKeys.templates, `/api/v1/ticket-templates/${encodeURIComponent(id)}`);
export const useCreateTemplate = () =>
  useDirectoryMutation<{ typeId: string; body: TicketTemplateInput }, TicketTemplate>(
    "POST",
    ({ typeId }) => `/api/v1/ticket-types/${typeId}/templates`,
  );
export const useUpdateTemplate = () =>
  useDirectoryMutation<{ id: string; body: Partial<TicketTemplateInput> }, TicketTemplate>(
    "PATCH",
    ({ id }) => `/api/v1/ticket-templates/${id}`,
  );
export const useDeleteTemplate = () =>
  useDirectoryMutation<string, void>("DELETE", (id) => `/api/v1/ticket-templates/${id}`, false);

export const useFields = () => useList<TicketField>(directoryKeys.fields, "/api/v1/fields");
export const useField = (id: string) =>
  useItem<TicketField>(directoryKeys.fields, `/api/v1/fields/${encodeURIComponent(id)}`);
export const useCreateField = () => useDirectoryMutation<TicketFieldInput, TicketField>("POST", () => "/api/v1/fields");
export const useUpdateField = () =>
  useDirectoryMutation<{ id: string; body: { name?: string; options?: string[]; multiple?: boolean } }, TicketField>(
    "PATCH",
    ({ id }) => `/api/v1/fields/${id}`,
  );
export const useDeleteField = () => useDirectoryMutation<string, void>("DELETE", (id) => `/api/v1/fields/${id}`, false);

export const useScales = () => useList<EstimateScale>(directoryKeys.scales, "/api/v1/estimate-scales");
export const useCreateScale = () =>
  useDirectoryMutation<EstimateScaleInput, EstimateScale>("POST", () => "/api/v1/estimate-scales");
export const useUpdateScale = () =>
  useDirectoryMutation<{ id: string; body: { name?: string; unit?: string | null; values?: string[] } }, EstimateScale>(
    "PATCH",
    ({ id }) => `/api/v1/estimate-scales/${id}`,
  );
export const useDeleteScale = () =>
  useDirectoryMutation<string, void>("DELETE", (id) => `/api/v1/estimate-scales/${id}`, false);

/** Конвертер пространства (свой или унаследованный) или конвертер по умолчанию (spaceId = null). */
export const useConverter = (spaceId: string | null) =>
  useQuery({
    queryKey: [...directoryKeys.converter, spaceId ?? "default"],
    queryFn: ({ signal }) =>
      api<Converter>(spaceId ? `/api/v1/spaces/${spaceId}/estimate-converter` : "/api/v1/estimate-converter", {
        signal,
      }),
  });
export const useSaveConverter = () =>
  useDirectoryMutation<{ spaceId: string | null; body: { entries: ConverterEntry[] } }, Converter>(
    "PUT",
    ({ spaceId }) => (spaceId ? `/api/v1/spaces/${spaceId}/estimate-converter` : "/api/v1/estimate-converter"),
  );
export const useResetConverter = () =>
  useDirectoryMutation<string, Converter>("DELETE", (spaceId) => `/api/v1/spaces/${spaceId}/estimate-converter`, false);

// ---- Схемы статусов (YT-05) ----

export const useScheme = (typeId: string, spaceId: string | null) =>
  useQuery({
    queryKey: [...directoryKeys.schemes, typeId, spaceId ?? "default"],
    queryFn: ({ signal }) =>
      api<StatusScheme>(`/api/v1/ticket-types/${typeId}/scheme${spaceId ? `?spaceId=${spaceId}` : ""}`, { signal }),
    enabled: Boolean(typeId),
  });
export const useSaveScheme = () =>
  useDirectoryMutation<{ typeId: string; body: StatusSchemeInput }, StatusScheme>(
    "PUT",
    ({ typeId }) => `/api/v1/ticket-types/${typeId}/scheme`,
  );
export const useResetScheme = () =>
  useDirectoryMutation<{ typeId: string; spaceId: string }, StatusScheme>(
    "DELETE",
    ({ typeId, spaceId }) => `/api/v1/ticket-types/${typeId}/scheme?spaceId=${spaceId}`,
    false,
  );

// ---- Тикеты (YT-06) ----

export const ticketKeys = {
  all: ["tickets"] as const,
  list: (spaceId: string, archived: string) => ["tickets", "list", spaceId, archived] as const,
  one: (key: string) => ["tickets", "one", key.toUpperCase()] as const,
  history: (key: string) => ["tickets", "history", key.toUpperCase()] as const,
  comments: (key: string) => ["tickets", "comments", key.toUpperCase()] as const,
};

export const useTickets = (
  spaceId: string,
  archived: "exclude" | "only" | "include" = "exclude",
  sort: "number" | "coverage" | "flow" = "number",
  q = "",
) =>
  useQuery({
    queryKey: [...ticketKeys.list(spaceId, archived), sort, q],
    queryFn: ({ signal }) =>
      api<Page<TicketSummary>>(
        `/api/v1/tickets?spaceId=${spaceId}&archived=${archived}&sort=${sort}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
        { signal },
      ),
    enabled: Boolean(spaceId),
  });

export const useTicket = (key: string) =>
  useQuery({
    queryKey: ticketKeys.one(key),
    queryFn: ({ signal }) => api<Ticket>(`/api/v1/tickets/${encodeURIComponent(key)}`, { signal }),
    // 403/404 — ответ о правах, а не сбой: повтор ничего не изменит.
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  });

export function useCreateTicket() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TicketCreateInput) =>
      api<Ticket>("/api/v1/tickets", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (ticket) => {
      client.setQueryData(ticketKeys.one(ticket.key), ticket);
      return client.invalidateQueries({
        queryKey: ticketKeys.all,
        predicate: (query) => JSON.stringify(query.queryKey) !== JSON.stringify(ticketKeys.one(ticket.key)),
      });
    },
  });
}

/**
 * Любое действие с тикетом: ответ — актуальный тикет, он сразу попадает в кэш.
 * При конфликте версий (R-3.1) в кэш попадает актуальное состояние из ошибки, а форма решает, что показать.
 */
export function useTicketAction<TInput extends { version: number }>(key: string, action: string, method = "POST") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) =>
      api<Ticket>(`/api/v1/tickets/${encodeURIComponent(key)}${action ? `/${action}` : ""}`, {
        method,
        body: JSON.stringify(input),
      }),
    onSuccess: (ticket) => {
      client.setQueryData(ticketKeys.one(ticket.key), ticket);
      // Свёртки и связи меняют и другие тикеты (родителей, детей, дерево): обновляем всё про тикеты.
      return client.invalidateQueries({
        queryKey: ticketKeys.all,
        predicate: (query) => JSON.stringify(query.queryKey) !== JSON.stringify(ticketKeys.one(ticket.key)),
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "version_conflict" && error.problem?.current) {
        client.setQueryData(ticketKeys.one(key), error.problem.current as Ticket);
      }
    },
  });
}

export const useUpdateTicket = (key: string) => useTicketAction<TicketPatch>(key, "", "PATCH");

// ---- Журнал и комментарии (YT-07) ----

export const useTicketHistory = (key: string) =>
  useQuery({
    queryKey: ticketKeys.history(key),
    queryFn: ({ signal }) => api<Page<HistoryEntry>>(`/api/v1/tickets/${encodeURIComponent(key)}/history`, { signal }),
  });

export const useComments = (key: string) =>
  useQuery({
    queryKey: ticketKeys.comments(key),
    queryFn: ({ signal }) =>
      api<Page<TicketComment>>(`/api/v1/tickets/${encodeURIComponent(key)}/comments`, { signal }),
  });

/** Любое действие с комментарием обновляет ленту комментариев, журнал и (для «Сделать тикетом») списки. */
export function useCommentAction<TInput, TResult = TicketComment>(
  key: string,
  request: (input: TInput) => [string, string, unknown?],
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<TResult>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ticketKeys.comments(key) }),
        client.invalidateQueries({ queryKey: ticketKeys.history(key) }),
        client.invalidateQueries({ queryKey: ["tickets", "list"] }),
      ]),
  });
}

// ---- Иерархия и дерево (YT-09) ----

export const useTree = (query: { spaceId?: string; rootKey?: string }) =>
  useQuery({
    queryKey: [...ticketKeys.all, "tree", query.spaceId ?? "", query.rootKey ?? ""],
    queryFn: ({ signal }) =>
      api<TicketTree>(
        `/api/v1/tree?${query.rootKey ? `rootKey=${encodeURIComponent(query.rootKey)}` : `spaceId=${query.spaceId}`}`,
        { signal },
      ),
    enabled: Boolean(query.spaceId || query.rootKey),
  });

/** Операция над деревом: обновляет все тикеты и дерево (затронуты родители, дети и свёртки). */
function useTreeMutation<TInput, TResult>(request: (input: TInput) => [string, string, unknown?]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<TResult>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ticketKeys.all }),
  });
}

export const useAddParent = (key: string) =>
  useTreeMutation<string, Ticket>((parentKey) => [
    "POST",
    `/api/v1/tickets/${encodeURIComponent(key)}/parents`,
    { parentKey },
  ]);
export const useRemoveParent = (key: string) =>
  useTreeMutation<string, Ticket>((parentKey) => [
    "DELETE",
    `/api/v1/tickets/${encodeURIComponent(key)}/parents/${encodeURIComponent(parentKey)}`,
  ]);
export const useMoveTickets = () =>
  useTreeMutation<MoveInput, Page<Ticket>>((input) => ["POST", "/api/v1/tickets/move", input]);
export const useWrapTickets = () =>
  useTreeMutation<WrapInput, Ticket>((input) => ["POST", "/api/v1/tickets/wrap", input]);
export const useQuickCreate = () =>
  useTreeMutation<TicketCreateInput, Ticket>((input) => ["POST", "/api/v1/tickets", input]);
export const useSetVisibility = (key: string) =>
  useTreeMutation<VisibilityInput, Ticket>((input) => [
    "PUT",
    `/api/v1/tickets/${encodeURIComponent(key)}/visibility`,
    input,
  ]);

// ---- Права (YT-08) ----

export const accessKeys = {
  all: ["access"] as const,
  profiles: ["access", "profiles"] as const,
  grants: (spaceId?: string) => ["access", "grants", spaceId ?? "all"] as const,
  masks: ["access", "masks"] as const,
  log: ["access", "log"] as const,
};

export const useProfiles = (enabled = true) =>
  useQuery({
    queryKey: accessKeys.profiles,
    queryFn: ({ signal }) => api<Page<AccessProfile>>("/api/v1/access/profiles", { signal }),
    enabled,
  });
export const useGrants = (spaceId?: string) =>
  useQuery({
    queryKey: accessKeys.grants(spaceId),
    queryFn: ({ signal }) =>
      api<Page<AccessGrant>>(`/api/v1/access/grants${spaceId ? `?spaceId=${spaceId}` : ""}`, { signal }),
  });
export const useMasks = () =>
  useQuery({
    queryKey: accessKeys.masks,
    queryFn: ({ signal }) => api<Page<{ fieldId: string; profileIds: string[] }>>("/api/v1/access/masks", { signal }),
  });
export const useSecurityLog = () =>
  useQuery({
    queryKey: accessKeys.log,
    queryFn: ({ signal }) => api<Page<SecurityEvent>>("/api/v1/access/log", { signal }),
  });

/** Изменение прав сразу меняет то, что видно: обновляем права, пространства и тикеты. */
function useAccessMutation<TInput, TResult>(request: (input: TInput) => [string, string, unknown?]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<TResult>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: () =>
      Promise.all(
        [accessKeys.all, keys.spaces, ticketKeys.all].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}

export const useCreateProfile = () =>
  useAccessMutation<AccessProfileInput, AccessProfile>((input) => ["POST", "/api/v1/access/profiles", input]);
export const useUpdateProfile = (id: string) =>
  useAccessMutation<Partial<AccessProfileInput>, AccessProfile>((input) => [
    "PATCH",
    `/api/v1/access/profiles/${id}`,
    input,
  ]);
export const useDeleteProfile = () =>
  useAccessMutation<string, void>((id) => ["DELETE", `/api/v1/access/profiles/${id}`]);
export const useCreateGrant = () =>
  useAccessMutation<AccessGrantInput, AccessGrant>((input) => ["POST", "/api/v1/access/grants", input]);
export const useDeleteGrant = () => useAccessMutation<string, void>((id) => ["DELETE", `/api/v1/access/grants/${id}`]);
export const useSetMask = (fieldId: string) =>
  useAccessMutation<string[], void>((profileIds) => ["PUT", `/api/v1/access/masks/${fieldId}`, { profileIds }]);

/** «Смотреть как» / «Режим показа»: меняется всё, что отдаёт API, поэтому сбрасываем весь кэш. */
export function useLens() {
  const client = useQueryClient();
  const reset = () => client.invalidateQueries();
  const on = useMutation({
    mutationFn: (input: { kind: "profile" | "person"; id: string; show?: boolean }) =>
      api<void>("/api/v1/me/lens", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: reset,
  });
  const off = useMutation({
    mutationFn: () => api<void>("/api/v1/me/lens", { method: "DELETE" }),
    onSuccess: reset,
  });
  return { on, off };
}

// ---- Связи и ссылки (YT-12) ----

export const linkKeys = {
  types: ["link-types"] as const,
  web: (key: string) => [...ticketKeys.all, "web-links", key.toUpperCase()] as const,
  mentions: (key: string) => [...ticketKeys.all, "mentions", key.toUpperCase()] as const,
};

export const useLinkTypes = () =>
  useQuery({
    queryKey: linkKeys.types,
    queryFn: ({ signal }) => api<Page<LinkType>>("/api/v1/link-types", { signal }),
  });

function useLinkTypeMutation<TInput, TResult>(request: (input: TInput) => [string, string, unknown?]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<TResult>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: () =>
      Promise.all([linkKeys.types, ticketKeys.all].map((queryKey) => client.invalidateQueries({ queryKey }))),
  });
}
export const useCreateLinkType = () =>
  useLinkTypeMutation<LinkTypeInput, LinkType>((input) => ["POST", "/api/v1/link-types", input]);
export const useUpdateLinkType = () =>
  useLinkTypeMutation<{ id: string } & Partial<LinkTypeInput>, LinkType>(({ id, ...input }) => [
    "PATCH",
    `/api/v1/link-types/${id}`,
    input,
  ]);
export const useDeleteLinkType = () =>
  useLinkTypeMutation<string, void>((id) => ["DELETE", `/api/v1/link-types/${id}`]);

export const useAddLink = (key: string) =>
  useTreeMutation<TicketLinkInput, Ticket>((input) => [
    "POST",
    `/api/v1/tickets/${encodeURIComponent(key)}/links`,
    input,
  ]);
export const useChangeLink = (key: string) =>
  useTreeMutation<{ id: string; typeId: string; direction: "out" | "in" }, Ticket>(({ id, ...input }) => [
    "PATCH",
    `/api/v1/links/${id}`,
    { ...input, fromKey: key },
  ]);
export const useRemoveLink = (key: string) =>
  useTreeMutation<string, Ticket>((id) => ["DELETE", `/api/v1/links/${id}?fromKey=${encodeURIComponent(key)}`]);

/** Блок ссылок: документы YourWiki с живым названием и доступом для зрителя. */
export const useWebLinks = (key: string) =>
  useQuery({
    queryKey: linkKeys.web(key),
    queryFn: ({ signal }) => api<Page<WebLink>>(`/api/v1/tickets/${encodeURIComponent(key)}/web-links`, { signal }),
  });

function useWebLinkMutation<TInput>(key: string, request: (input: TInput) => [string, string, unknown?]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<Page<WebLink>>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: (page) => {
      client.setQueryData(linkKeys.web(key), page);
      return client.invalidateQueries({ queryKey: ticketKeys.history(key) });
    },
  });
}
export const useAddWebLink = (key: string) =>
  useWebLinkMutation<WebLinkInput>(key, (input) => [
    "POST",
    `/api/v1/tickets/${encodeURIComponent(key)}/web-links`,
    input,
  ]);
export const useRemoveWebLink = (key: string) =>
  useWebLinkMutation<string>(key, (id) => ["DELETE", `/api/v1/web-links/${id}`]);
export const useRequestDocAccess = (key: string) =>
  useWebLinkMutation<string>(key, (id) => ["POST", `/api/v1/web-links/${id}/request-access`]);

/** Упоминания в описании, разобранные сервером для зрителя. */
export const useDescriptionMentions = (key: string, description: string) =>
  useQuery({
    queryKey: [...linkKeys.mentions(key), description],
    queryFn: ({ signal }) => api<CommentMentions>(`/api/v1/tickets/${encodeURIComponent(key)}/mentions`, { signal }),
    enabled: /[@]|[A-Z]-\d/.test(description),
  });

// ---- Вложения (YT-13) ----

export const attachmentKeys = {
  settings: ["attachment-settings"] as const,
  list: (key: string) => [...ticketKeys.all, "attachments", key.toUpperCase()] as const,
};

export const useAttachmentSettings = () =>
  useQuery({
    queryKey: attachmentKeys.settings,
    queryFn: ({ signal }) => api<AttachmentSettings>("/api/v1/attachment-settings", { signal }),
  });

export function useUpdateAttachmentSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<AttachmentSettings, "updatedAt">) =>
      api<AttachmentSettings>("/api/v1/attachment-settings", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (settings) => client.setQueryData(attachmentKeys.settings, settings),
  });
}

export const useAttachments = (key: string) =>
  useQuery({
    queryKey: attachmentKeys.list(key),
    queryFn: ({ signal }) =>
      api<Page<Attachment>>(`/api/v1/tickets/${encodeURIComponent(key)}/attachments`, { signal }),
  });

export function useDeleteAttachment(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/v1/attachments/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: attachmentKeys.list(key) }),
        client.invalidateQueries({ queryKey: ticketKeys.history(key) }),
      ]),
  });
}

// ---- Корзина, след родителя, колокольчик (YT-14) ----

export const trashKeys = {
  all: ["trash"] as const,
  list: (spaceId?: string) => ["trash", "list", spaceId ?? "all"] as const,
  notifications: ["notifications"] as const,
};

export const useTrash = (spaceId?: string) =>
  useQuery({
    queryKey: trashKeys.list(spaceId),
    queryFn: ({ signal }) =>
      api<{ items: TrashItem[]; settings: TrashSettings }>(
        `/api/v1/trash${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`,
        { signal },
      ),
  });

/** Любое действие корзины меняет тикеты, дерево, номера и саму корзину. */
function useTrashMutation<TInput, TResult>(request: (input: TInput) => [string, string, unknown?]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<TResult>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: () =>
      Promise.all(
        [ticketKeys.all, trashKeys.all, trashKeys.notifications].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

export const useTrashTickets = () =>
  useTrashMutation<TrashInput, TrashResult>((input) => ["POST", "/api/v1/tickets/trash", input]);
export const useRestoreTickets = () =>
  useTrashMutation<RestoreInput, RestoreResult>((input) => ["POST", "/api/v1/trash/restore", input]);
export const usePurgeTickets = () =>
  useTrashMutation<PurgeInput, { purged: TrashTicketRef[] }>((input) => ["POST", "/api/v1/trash/purge", input]);
export const useRelinkTrace = () =>
  useTrashMutation<RelinkInput, RelinkResult>((input) => ["POST", "/api/v1/traces/relink", input]);
export const useSaveTrashSettings = () =>
  useTrashMutation<{ retentionDays: number }, TrashSettings>((input) => ["PUT", "/api/v1/trash-settings", input]);

export const useNotifications = (enabled = true) =>
  useQuery({
    queryKey: trashKeys.notifications,
    queryFn: ({ signal }) => api<{ items: AppNotification[]; unread: number }>("/api/v1/notifications", { signal }),
    enabled,
    refetchInterval: 60_000,
  });
export const useReadNotifications = () =>
  useTrashMutation<{ ids?: string[] }, void>((input) => ["POST", "/api/v1/notifications/read", input]);

// ---- TQL, поиск и сохранённые фильтры (YT-15) ----

export const searchKeys = {
  all: ["search"] as const,
  run: (q: string, spaceId: string) => ["search", "run", q, spaceId] as const,
  vocabulary: ["search", "vocabulary"] as const,
  filters: (spaceId: string) => ["search", "filters", spaceId] as const,
};

export const useSearch = (q: string, spaceId = "", limit = 100) =>
  useQuery({
    queryKey: [...searchKeys.run(q, spaceId), limit],
    queryFn: ({ signal }) =>
      api<SearchResult<TicketSummary & { spaceId: string }>>(
        `/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}${spaceId ? `&spaceId=${encodeURIComponent(spaceId)}` : ""}`,
        { signal },
      ),
    enabled: Boolean(q.trim()),
    // Ошибка в запросе — ответ, а не сбой: повтор ничего не изменит.
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
    placeholderData: (previous) => previous,
  });

export const useVocabulary = () =>
  useQuery({
    queryKey: searchKeys.vocabulary,
    queryFn: ({ signal }) => api<TqlVocabulary>("/api/v1/search/vocabulary", { signal }),
    staleTime: 60_000,
  });

export const useFilters = (spaceId = "") =>
  useQuery({
    queryKey: searchKeys.filters(spaceId),
    queryFn: ({ signal }) =>
      api<Page<SavedFilter>>(`/api/v1/filters${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`, { signal }),
  });

function useFilterMutation<TInput, TResult>(request: (input: TInput) => [string, string, unknown?]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const [method, path, body] = request(input);
      return api<TResult>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["search", "filters"] }),
  });
}
export const useSaveFilter = () =>
  useFilterMutation<SavedFilterInput & { id?: string }, SavedFilter>(({ id, ...input }) =>
    id ? ["PUT", `/api/v1/filters/${id}`, input] : ["POST", "/api/v1/filters", input],
  );
export const useDeleteFilter = () => useFilterMutation<string, void>((id) => ["DELETE", `/api/v1/filters/${id}`]);
