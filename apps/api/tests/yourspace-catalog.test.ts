import { describe, expect, test } from "vitest";
import { CatalogError, maskValue, YourSpaceCatalog } from "../src/catalog/catalog.js";

const config = {
  mode: "oidc" as const,
  issuer: "https://id.yourspace.example",
  clientId: "yourtask",
  clientSecret: "s3cret:with/colon",
  scopes: "openid profile email",
};

describe("YourSpace catalog HTTP client", () => {
  test("reads people, profiles and events as the product server (Basic client_id:client_secret)", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/api/directory/people?includeInactive=1")) return Response.json({ items: [{ id: "a" }] });
      if (url.endsWith("/api/directory/people/a")) return Response.json({ id: "a", phone: "+… 42" });
      if (url.endsWith("/api/directory/people/missing")) return new Response("{}", { status: 404 });
      if (url.includes("/api/directory/events?after=5")) return Response.json({ items: [], next: 5 });
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const catalog = new YourSpaceCatalog(config, fetchImpl);

    expect(await catalog.list()).toEqual([{ id: "a" }]);
    expect(await catalog.profile("a")).toMatchObject({ phone: "+… 42" });
    expect(await catalog.profile("missing")).toBeNull();
    expect(await catalog.events(5)).toEqual({ items: [], next: 5 });
    await expect(catalog.profile("boom")).rejects.toBeInstanceOf(CatalogError);

    const expected = `Basic ${Buffer.from("yourtask:s3cret%3Awith%2Fcolon").toString("base64")}`;
    expect(calls.every((call) => call.auth === expected)).toBe(true);
    expect(catalog.profileUrl("a b")).toBe("https://id.yourspace.example/people/a%20b");
  });

  test("network failure is a CatalogError", async () => {
    const catalog = new YourSpaceCatalog(config, (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    await expect(catalog.list()).rejects.toBeInstanceOf(CatalogError);
  });

  test("masks match YourSpace and are idempotent", () => {
    expect(maskValue("phone", "+7 900 000-11-22")).toBe("+… 22");
    expect(maskValue("phone", "+… 22")).toBe("+… 22");
    expect(maskValue("extraEmail", "secret@example.com")).toBe("s…@example.com");
    expect(maskValue("extraEmail", "s…@example.com")).toBe("s…@example.com");
    expect(maskValue("birthDate", "1990-01-02")).toBe("…");
    expect(maskValue("comments", null)).toBeNull();
  });
});
