import type { FastifyPluginAsync } from "fastify";
import { CURRENT_SITE, SITE_INFO, sortProducts, type SiteProduct } from "@yourtask/contracts";
import { problemResponses } from "./errors.js";
import { DEV_YOURSPACE_PATH } from "./auth/dev-yourspace.js";

/**
 * Переключатель сайтов (YourSpace docs/site-switcher.md): список подключённых сайтов берётся у YourSpace
 * (GET <YourSpace>/api/products), кэшируется на 5 минут и всегда сортируется здесь же: YourSpace первым, остальные A→Z.
 * YourSpace недоступен — последний удачный ответ, а без него хотя бы YourSpace и сам YourTask. Ошибки на странице нет.
 */
const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 2000;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Сайт для показа: свой логотип для известных (копии лежат в /sites), подписи RU/EN. */
function normalize(raw: Partial<SiteProduct> & { id: string }): SiteProduct | null {
  const info = SITE_INFO[raw.id];
  const url = raw.url?.trim() ?? "";
  if (!url) return null;
  return {
    id: raw.id,
    name: raw.name ?? info?.name ?? raw.id,
    url,
    logo: info?.logo ?? raw.logo ?? "/sites/yourspace.svg",
    description: {
      ru: raw.description?.ru ?? info?.description.ru ?? "",
      en: raw.description?.en ?? info?.description.en ?? "",
    },
  };
}

export function productDirectory(options: {
  yourspaceUrl: string;
  publicUrl: string;
  fetch?: Fetch;
  now?: () => number;
}) {
  const fetcher: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const self = normalize({ id: CURRENT_SITE, url: `${options.publicUrl.replace(/\/+$/, "")}/` }) as SiteProduct;
  const yourspace = normalize({ id: "yourspace", url: options.yourspaceUrl }) as SiteProduct;
  let cached: { at: number; list: SiteProduct[] } | null = null;
  let pending: Promise<SiteProduct[]> | null = null;

  /** Текущий сайт есть всегда, YourSpace — тоже; порядок — по общему правилу. */
  const finish = (list: SiteProduct[]) => {
    const byId = new Map(list.map((item) => [item.id, item]));
    if (!byId.has("yourspace")) byId.set("yourspace", yourspace);
    if (!byId.has(CURRENT_SITE)) byId.set(CURRENT_SITE, self);
    return sortProducts([...byId.values()]);
  };

  async function load(): Promise<SiteProduct[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const base = options.yourspaceUrl.endsWith("/") ? options.yourspaceUrl : `${options.yourspaceUrl}/`;
      const response = await fetcher(new URL("api/products", base).href, { signal: controller.signal });
      if (!response.ok) throw new Error("YourSpace did not answer");
      const body = (await response.json()) as { products?: (Partial<SiteProduct> & { id: string })[] };
      const list = (body.products ?? []).filter((item) => typeof item?.id === "string").map(normalize);
      const result = finish(list.filter((item): item is SiteProduct => item !== null));
      cached = { at: now(), list: result };
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async list(): Promise<SiteProduct[]> {
      if (cached && now() - cached.at < TTL_MS) return cached.list;
      pending ??= load().finally(() => {
        pending = null;
      });
      try {
        return await pending;
      } catch {
        // Запасной вариант: последний удачный ответ или хотя бы YourSpace и YourTask.
        return cached?.list ?? finish([]);
      }
    },
  };
}

const productSchema = {
  type: "object",
  required: ["id", "name", "url", "logo", "description"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    logo: { type: "string" },
    description: {
      type: "object",
      required: ["ru", "en"],
      properties: { ru: { type: "string" }, en: { type: "string" } },
    },
  },
} as const;

export const productRoutes: FastifyPluginAsync<{
  yourspaceUrl: string;
  publicUrl: string;
  siteUrls: Record<string, string>;
  devStub: boolean;
  fetch?: Fetch;
}> = async (app, options) => {
  const directory = productDirectory(options);
  const response = {
    200: { type: "object", required: ["products"], properties: { products: { type: "array", items: productSchema } } },
    ...problemResponses,
  };

  // Без входа: в ответе только адреса сайтов (переключатель есть и на странице входа).
  app.get(
    "/api/v1/products",
    {
      schema: { tags: ["system"], summary: "Sites of the YourSpace switcher: YourSpace first, the rest A→Z", response },
    },
    async () => ({ products: await directory.list() }),
  );

  // Dev-заглушка YourSpace отдаёт тот же список, что настоящий YourSpace: адреса — из .env YourTask (YOURSPACE_*_URL).
  if (options.devStub) {
    app.get(`${DEV_YOURSPACE_PATH}/api/products`, { schema: { hide: true } }, async () => ({
      products: sortProducts(
        [
          { id: "yourspace", name: "YourSpace", url: options.yourspaceUrl },
          ...Object.entries(options.siteUrls).map(([id, url]) => ({ id, name: SITE_INFO[id]?.name ?? id, url })),
        ].map((item) => normalize(item) as SiteProduct),
      ),
    }));
  }
};
