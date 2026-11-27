import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { meFixture, mockApi, problem, renderApp } from "./utils";

/** Переключатель сайтов YourSpace (YourSpace docs/site-switcher.md, раздел «Проверка»). */
const site = (id: string, name: string, url: string) => ({
  id,
  name,
  url,
  logo: `/sites/${id}.svg`,
  description: { ru: `Про ${name}`, en: `About ${name}` },
});

function api(products: unknown) {
  return mockApi({
    "GET /api/v1/me": () => ({ status: 200, body: meFixture("ru") }),
    "GET /api/v1/spaces": () => ({ status: 200, body: { items: [] } }),
    "GET /api/v1/notifications": () => ({ status: 200, body: { items: [], unread: 0 } }),
    "GET /api/v1/products": () => (products ? { status: 200, body: { products } } : problem(503, "internal_error")),
  });
}

const switcher = async () => {
  const nav = await screen.findByRole("navigation", { name: "Сайты YourSpace" });
  return {
    nav,
    summary: nav.querySelector("summary") as HTMLElement,
    details: nav.querySelector("details") as HTMLDetailsElement,
  };
};

describe("YourSpace site switcher", () => {
  test("YourSpace first, the rest A→Z; YourTask is marked by aria-current, a check and «open now»", async () => {
    api([
      site("yourwiki", "YourWiki", "https://wiki.example.com/"),
      site("yourtask", "YourTask", "https://task.example.com/"),
      site("yourspace", "YourSpace", "https://id.example.com/"),
      site("yourdash", "YourDash", "https://dash.example.com/"),
    ]);
    renderApp("/");
    const { nav } = await switcher();
    await waitFor(() => expect(within(nav).getAllByRole("link")).toHaveLength(4));
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.querySelector(".appswitch-name")?.textContent)).toEqual([
      "YourSpace",
      "YourDash",
      "YourTask",
      "YourWiki",
    ]);
    const current = links.filter((link) => link.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "/");
    expect(current[0]?.querySelector(".appswitch-check")).not.toBeNull();
    expect(current[0]).toHaveTextContent("открыт сейчас");
    expect(links[0]).toHaveAttribute("href", "https://id.example.com/");
    expect(links[0]).toHaveTextContent("Про YourSpace");
  });

  test("a site without an address is not shown at all", async () => {
    api([
      site("yourspace", "YourSpace", "https://id.example.com/"),
      site("yourmail", "YourMail", ""),
      site("yourtask", "YourTask", "/"),
    ]);
    renderApp("/");
    const { nav } = await switcher();
    await waitFor(() => expect(within(nav).getAllByRole("link")).toHaveLength(2));
    expect(nav).not.toHaveTextContent("YourMail");
  });

  test("the logo button has a single marker — the chevron — and no <details> marker", async () => {
    api([site("yourspace", "YourSpace", "https://id.example.com/"), site("yourtask", "YourTask", "/")]);
    renderApp("/");
    const { summary } = await switcher();
    expect(summary.querySelectorAll("svg")).toHaveLength(1);
    expect(summary.querySelector("svg")).toHaveClass("appswitch-chevron");
    expect(summary).toHaveClass("appswitch-trigger");
    expect(summary.querySelector(".appswitch-current")).toHaveTextContent("YourTask");
    expect(summary).toHaveTextContent("— открыть список сайтов");
  });

  test("keyboard: ↓ opens and walks the sites in a circle, End and Home jump, Esc closes and returns focus", async () => {
    api([
      site("yourspace", "YourSpace", "https://id.example.com/"),
      site("yourtask", "YourTask", "/"),
      site("yourwiki", "YourWiki", "https://wiki.example.com/"),
    ]);
    renderApp("/");
    const { nav, summary, details } = await switcher();
    await waitFor(() => expect(within(nav).getAllByRole("link")).toHaveLength(3));
    const links = within(nav).getAllByRole("link");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    summary.focus();
    fireEvent.keyDown(summary, { key: "ArrowDown" });
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(links[2] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(links[2]);
    fireEvent.keyDown(links[2] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0] as HTMLElement, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    // Клик вне меню закрывает его.
    details.open = true;
    fireEvent.click(document.body);
    expect(details.open).toBe(false);
  });

  test("YourSpace does not answer: the bar is still drawn with YourTask, no error on the page", async () => {
    api(null);
    renderApp("/");
    const { nav } = await switcher();
    await waitFor(() => expect(within(nav).getByRole("link")).toHaveAttribute("aria-current", "true"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
