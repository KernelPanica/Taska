import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SiteProduct } from "@yourtask/contracts";
import { loadConfig } from "../src/config.js";
import { productDirectory } from "../src/products.js";
import { createTestApp } from "./helpers.js";

/** Переключатель сайтов YourSpace (YourSpace docs/site-switcher.md, раздел «Проверка»). */
let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const answer = (products: unknown[]) => async () => ({ ok: true, json: async () => ({ products }) });
const site = (id: string, name: string, url: string) => ({
  id,
  name,
  url,
  logo: `https://id.example.com/static/${id}.svg`,
  description: { ru: `Про ${name}`, en: `About ${name}` },
});

describe("site switcher list", () => {
  test("YourSpace is first, the others A→Z, even if YourSpace sent another order; sites without an address are left out", async () => {
    app = await createTestApp(
      {},
      {
        productsFetch: answer([
          site("yourwiki", "YourWiki", "https://wiki.example.com/"),
          site("yourdash", "YourDash", "https://dash.example.com/"),
          site("yourmail", "YourMail", ""),
          site("yourspace", "YourSpace", "https://id.example.com/"),
          site("yourtask", "YourTask", "https://task.example.com/"),
        ]),
      },
    );
    const response = await app.inject({ method: "GET", url: "/api/v1/products" });
    expect(response.statusCode).toBe(200);
    const products = response.json().products as SiteProduct[];
    expect(products.map((item) => item.name)).toEqual(["YourSpace", "YourDash", "YourTask", "YourWiki"]);
    // Логотипы известных сайтов — свои копии; подписи — RU/EN из YourSpace.
    expect(products[0]).toMatchObject({
      logo: "/sites/yourspace.svg",
      description: { ru: "Про YourSpace", en: "About YourSpace" },
    });
  });

  test("YourSpace is unavailable: the bar still has YourSpace and YourTask, then the last good answer is kept", async () => {
    let up = false;
    let time = 0;
    const directory = productDirectory({
      yourspaceUrl: "https://id.example.com/",
      publicUrl: "https://task.example.com",
      now: () => time,
      fetch: async () => {
        if (!up) throw new Error("ECONNREFUSED");
        return {
          ok: true,
          json: async () => ({ products: [site("yourwiki", "YourWiki", "https://wiki.example.com/")] }),
        };
      },
    });
    expect((await directory.list()).map((item) => [item.id, item.url])).toEqual([
      ["yourspace", "https://id.example.com/"],
      ["yourtask", "https://task.example.com/"],
    ]);
    up = true;
    expect((await directory.list()).map((item) => item.name)).toEqual(["YourSpace", "YourTask", "YourWiki"]);
    // Кэш на 5 минут; после — новый запрос; YourSpace упал — остаётся последний удачный список.
    up = false;
    time += 6 * 60 * 1000;
    expect((await directory.list()).map((item) => item.name)).toEqual(["YourSpace", "YourTask", "YourWiki"]);
  });

  test("the dev YourSpace stub serves the same /api/products from the product's .env; a bad address names its variable", async () => {
    app = await createTestApp({
      siteUrls: { yourwiki: "http://localhost:3200/", yourdash: "https://dash.example.com/" },
    });
    const products = (await app.inject({ method: "GET", url: "/dev/yourspace/api/products" })).json()
      .products as SiteProduct[];
    expect(products.map((item) => item.id)).toEqual(["yourspace", "yourdash", "yourwiki"]);
    expect(() => loadConfig({ YOURTASK_PROFILE: "test", YOURSPACE_YOURWIKI_URL: "http://wiki.example.com" })).toThrow(
      /YOURSPACE_YOURWIKI_URL must use HTTPS/,
    );
    expect(() =>
      loadConfig({ YOURTASK_PROFILE: "test", YOURSPACE_YOURMAIL_URL: "https://u:p@mail.example.com" }),
    ).toThrow(/YOURSPACE_YOURMAIL_URL must not contain a login or password/);
    expect(loadConfig({ YOURTASK_PROFILE: "test", YOURSPACE_YOURMAIL_URL: "" }).siteUrls).toEqual({});
  });
});
