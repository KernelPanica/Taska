import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { Locale } from "@yourtask/contracts";
import { AppRoutes } from "../app/router";
import { I18nProvider } from "../i18n";

type Handler = (init: RequestInit | undefined) => { status: number; body?: unknown };

/** Подмена fetch маршрутами «МЕТОД путь» → ответ. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, init });
    const handler = routes[`${method} ${path}`];
    if (!handler)
      return Response.json(
        { status: 404, code: "not_found", title: "Not found", type: "x", requestId: "r" },
        { status: 404 },
      );
    const { status, body } = handler(init);
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  });
  return calls;
}

export const meFixture = (locale: Locale = "ru", role: "member" | "superadmin" = "member") => ({
  user: { id: "u1", email: "anna@yourspace.test", name: "Анна Тестова", role, locale },
  csrfToken: "csrf-1",
  session: { id: "s1", method: "password", mfa: role === "superadmin", expiresAt: "2030-01-01T00:00:00.000Z" },
  lens: null,
  showProfileId: null,
  canViewAsPerson: role === "superadmin",
});

/** Права зрителя в тикете: по умолчанию — всё, как у команды тикета. */
export const allPermissions = {
  comment: true,
  edit: true,
  status: true,
  assign: true,
  dates: true,
  move: true,
  trash: true,
  visibility: false,
  create: true,
  export: true,
};

/** Поля YT-08…YT-10, которых нет в старых фикстурах тикета. */
export const ticketExtras = {
  numbers: [],
  visibility: { own: null, effective: "open", inheritedFrom: null, allow: [] },
  permissions: allPermissions,
  masked: [],
  relations: { parents: [], children: [], coverage: 0, links: [], traces: [] },
  rollup: { progress: null, startDate: null, endDate: null, datesDiffer: false, estimates: {}, closeSuggested: false },
};

export const SPACE_RIGHTS = ["view", "comment", "create", "edit", "status", "assign", "dates", "move"];

export function renderApp(path: string, locale?: Locale) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider {...(locale ? { locale } : {})}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

export const problem = (status: number, code: string) => ({
  status,
  body: { status, code, title: code, type: "x", requestId: "req-42" },
});
