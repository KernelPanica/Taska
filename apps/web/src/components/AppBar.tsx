import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { CURRENT_SITE, SITE_INFO, sortProducts, type SiteProduct } from "@yourtask/contracts";
import { api } from "../api/client";
import { useI18n } from "../i18n";

/**
 * Общая панель сайтов YourSpace (YourSpace docs/site-switcher.md): разметка один в один с эталоном
 * productBar() и поведение appbar.js — Esc, клик и фокус вне меню, ↓ ↑ Home End, aria-expanded.
 */
const FALLBACK: SiteProduct[] = ["yourspace", CURRENT_SITE].map((id) => ({
  id,
  name: SITE_INFO[id]?.name ?? id,
  url: id === CURRENT_SITE ? "/" : "",
  logo: SITE_INFO[id]?.logo ?? "",
  description: SITE_INFO[id]?.description ?? { ru: "", en: "" },
}));

export function useSites() {
  return useQuery({
    queryKey: ["products"],
    queryFn: ({ signal }) => api<{ products: SiteProduct[] }>("/api/v1/products", { signal }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function AppBar({ end }: { end?: ReactNode }) {
  const { t, locale } = useI18n();
  const sites = useSites();
  const switcher = useRef<HTMLDetailsElement>(null);
  // Сервер уже отсортировал, но порядок — наше правило: YourSpace первым, остальные A→Z.
  const list = sortProducts(
    sites.data?.products.length ? sites.data.products : FALLBACK.filter((item) => item.id === CURRENT_SITE || item.url),
  );
  const shown = list.some((item) => item.id === CURRENT_SITE) ? list : [...list, FALLBACK[1] as SiteProduct];
  const here = shown.find((item) => item.id === CURRENT_SITE) as SiteProduct;

  useEffect(() => {
    const details = switcher.current;
    if (!details) return;
    const trigger = details.querySelector("summary") as HTMLElement;
    const items = () => [...details.querySelectorAll<HTMLElement>(".appswitch-item")];
    const close = (focus: boolean) => {
      if (!details.open) return;
      details.open = false;
      trigger.setAttribute("aria-expanded", "false");
      if (focus) trigger.focus();
    };
    const onToggle = () => trigger.setAttribute("aria-expanded", String(details.open));
    const onOutside = (event: Event) => {
      if (!details.contains(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.open) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const all = items();
      if (!all.length) return;
      event.preventDefault();
      if (!details.open) {
        details.open = true;
        trigger.setAttribute("aria-expanded", "true");
      }
      const at = all.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? all.length - 1
            : event.key === "ArrowDown"
              ? (at + 1) % all.length
              : at <= 0
                ? all.length - 1
                : at - 1;
      all[next]?.focus();
    };
    trigger.setAttribute("aria-expanded", String(details.open));
    details.addEventListener("toggle", onToggle);
    details.addEventListener("keydown", onKey);
    document.addEventListener("click", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      details.removeEventListener("toggle", onToggle);
      details.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, []);

  const description = (item: SiteProduct) => (locale === "en" ? item.description.en : item.description.ru);
  return (
    <nav aria-label={t("appbar.sites")} className="appbar">
      <details className="appswitch" ref={switcher}>
        <summary className="appswitch-trigger">
          <img alt="" className="appswitch-logo" height="28" src={here.logo} width="28" />
          <span className="appswitch-current">{here.name}</span>
          <span className="vh">{t("appbar.open")}</span>
          <svg aria-hidden="true" className="i appswitch-chevron" viewBox="0 0 24 24">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="appswitch-menu">
          <p aria-hidden="true" className="appswitch-title">
            {t("appbar.sites")}
          </p>
          <ul>
            {shown.map((item) => {
              const current = item.id === CURRENT_SITE;
              return (
                <li key={item.id}>
                  <a
                    aria-current={current ? "true" : undefined}
                    className="appswitch-item"
                    href={current ? "/" : item.url}
                  >
                    <img alt="" className="appswitch-logo" height="32" src={item.logo} width="32" />
                    <span className="appswitch-text">
                      <span className="appswitch-name">{item.name}</span>
                      <span className="appswitch-desc">{description(item)}</span>
                    </span>
                    {current ? (
                      <>
                        <svg aria-hidden="true" className="i appswitch-check" viewBox="0 0 24 24">
                          <path d="m5 12 5 5 9-10" />
                        </svg>
                        <span className="vh">{t("appbar.current")}</span>
                      </>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
      <div className="appbar-end" data-slot="appbar-end">
        {end}
      </div>
    </nav>
  );
}
