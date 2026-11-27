/**
 * Переключатель сайтов YourSpace — общий для всех продуктов (R-0.4; спецификация YourSpace docs/site-switcher.md).
 * Список подключённых сайтов отдаёт YourSpace (GET /api/products); YourTask кэширует его и сам сортирует.
 */
export interface SiteProduct {
  id: string;
  name: string;
  url: string;
  logo: string;
  description: { ru: string; en: string };
}

export const CURRENT_SITE = "yourtask";

/** Известные сайты: логотип — своя копия (YourSpace раздаёт такие же), подпись — RU/EN. */
export const SITE_INFO: Record<string, { name: string; logo: string; description: { ru: string; en: string } }> = {
  yourspace: {
    name: "YourSpace",
    logo: "/sites/yourspace.svg",
    description: { ru: "Аккаунт и люди", en: "Account and people" },
  },
  yourdash: {
    name: "YourDash",
    logo: "/sites/yourdash.svg",
    description: { ru: "Метрики и Гант", en: "Metrics and Gantt" },
  },
  yourmail: { name: "YourMail", logo: "/sites/yourmail.svg", description: { ru: "Почта", en: "Mail" } },
  yourtask: {
    name: "YourTask",
    logo: "/sites/yourtask.svg",
    description: { ru: "Задачи и доски", en: "Tasks and boards" },
  },
  yourwiki: { name: "YourWiki", logo: "/sites/yourwiki.svg", description: { ru: "Документы", en: "Documents" } },
};

/** YourSpace первым, остальные по алфавиту названия; сайты без адреса не показываются. */
export function sortProducts<T extends { id: string; name: string; url?: string }>(list: readonly T[]): T[] {
  return list
    .filter((item) => item.id === "yourspace" || Boolean(item.url?.trim()))
    .slice()
    .sort(
      (a, b) =>
        (b.id === "yourspace" ? 1 : 0) - (a.id === "yourspace" ? 1 : 0) ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
}
