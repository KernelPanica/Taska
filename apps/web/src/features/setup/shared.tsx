import {
  BookOpen,
  Bug,
  CalendarBlank,
  CheckSquare,
  Code,
  Cube,
  Diamond,
  FilmStrip,
  Flag,
  FlagBanner,
  GameController,
  Lightning,
  Megaphone,
  MusicNote,
  Palette,
  Question,
  Rocket,
  Star,
  Target,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { toDays, type Converter, type DayRange, type EstimateScale, type TypeIcon } from "@yourtask/contracts";
import { useI18n, type MessageKey } from "../../i18n";

export const ICONS: Record<TypeIcon, Icon> = {
  target: Target,
  lightning: Lightning,
  "book-open": BookOpen,
  "check-square": CheckSquare,
  bug: Bug,
  megaphone: Megaphone,
  flag: Flag,
  "flag-banner": FlagBanner,
  diamond: Diamond,
  star: Star,
  rocket: Rocket,
  wrench: Wrench,
  palette: Palette,
  film: FilmStrip,
  "music-note": MusicNote,
  code: Code,
  "game-controller": GameController,
  calendar: CalendarBlank,
  question: Question,
  cube: Cube,
};

/** Иконка и цвет типа — как в карточке и на доске. */
export function TypeMark({ icon, color, size = 18 }: { icon: TypeIcon; color: string; size?: number }) {
  const IconComponent = ICONS[icon] ?? Cube;
  return (
    <span aria-hidden="true" className="type-mark" style={{ backgroundColor: color }}>
      <IconComponent size={size} weight="bold" />
    </span>
  );
}

export const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }
>(function Textarea({ label, hint, ...props }, ref) {
  const id = useId();
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <textarea {...props} aria-describedby={hint ? `${id}-hint` : undefined} className="ui-input" id={id} ref={ref} />
      {hint ? (
        <p className="ui-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
});

const number = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

/** «3–5» или «6» — диапазон дней. */
export function formatRange(range: DayRange, locale: string) {
  return range.min === range.max
    ? number(range.min, locale)
    : `${number(range.min, locale)}–${number(range.max, locale)}`;
}

/** Ориентир рядом с оценкой: «≈ 3–5 дн., ориентир» (R-2.26). Для шкалы «Дни» ориентир не нужен. */
export function useEstimateHint() {
  const { t, locale } = useI18n();
  return (scale: EstimateScale | undefined, value: string | number, converter: Converter | undefined) => {
    if (!scale || !converter || scale.key === "days") return null;
    const days = toDays(scale, value, converter);
    return days ? t("estimates.hint", { range: formatRange(days, locale) }) : null;
  };
}

/** Подпись значения оценки: «M» или «6 дн.». */
export function estimateLabel(scale: EstimateScale | undefined, value: string | number) {
  if (!scale) return String(value);
  if (scale.kind === "numeric") return `${value}${scale.unit ? ` ${scale.unit}` : ""}`;
  return scale.values.find((item) => item.id === value)?.label ?? String(value);
}

const INLINE =
  /(\*\*[^*]+\*\*|!\[[^\]]*\]\(\/api\/v1\/attachments\/[\w-]+\)|\[[^\]]+\]\([^)\s]+\)|(?<![\w@.])@[A-Za-z0-9][A-Za-z0-9._-]{1,63}|\b[A-Z][A-Z0-9]{0,9}-\d+\b)/g;

/** Упоминания, которые сервер распознал для этого зрителя: только они становятся ссылками. */
export interface MarkdownMentions {
  people: { login: string; id: string; name: string }[];
  tickets: { key: string; title: string; statusName: string | null }[];
  /** Документы YourWiki из блока ссылок: ссылка на них показывает живое название (R-2.24). */
  documents?: { url: string; title: string | null }[];
  /** Вложения тикета: `![…](/api/v1/attachments/…)` показывается картинкой или видео (YT-13). */
  attachments?: { url: string; name: string; group: "image" | "video" | "document" }[];
}

/**
 * Строчная разметка: **жирный**, ссылки (http(s) и внутренние «/…»), упоминания `@логин` и ключей тикетов.
 * Никакого HTML из текста (R-3.2): javascript:, data: и прочее остаются текстом.
 */
function inline(text: string, mentions: MarkdownMentions | undefined, t: (key: MessageKey) => string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    // Вложение тикета в тексте: только наши адреса /api/v1/attachments/… (внешние картинки не грузим).
    const media = /^!\[([^\]]*)\]\((\/api\/v1\/attachments\/[\w-]+)\)$/.exec(part);
    if (media) {
      const [, alt = "", src = ""] = media;
      const attachment = mentions?.attachments?.find((item) => item.url === src);
      if (attachment?.group === "video") {
        return <video aria-label={alt} className="md-media" controls key={index} preload="metadata" src={src} />;
      }
      if (attachment?.group === "image")
        return <img alt={alt} className="md-media" key={index} loading="lazy" src={src} />;
      return (
        <a href={src} key={index}>
          {alt || src}
        </a>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, written, href = ""] = link;
      const document = mentions?.documents?.find((item) => item.url === href);
      // Документ без доступа — без названия и без ссылки: YourWiki его этому человеку не показал.
      if (document && !document.title) return <span key={index}>{t("weblinks.wikiDocument")}</span>;
      const label = document?.title ?? written;
      if (href.startsWith("/") && !href.startsWith("//")) {
        return (
          <Link key={index} to={href}>
            {label}
          </Link>
        );
      }
      return /^https?:\/\//i.test(href) ? (
        <a href={href} key={index} rel="noopener noreferrer nofollow" target="_blank">
          {label}
        </a>
      ) : (
        <span key={index}>{label}</span>
      );
    }
    if (part.startsWith("@") && mentions) {
      const person = mentions.people.find(
        (item) =>
          item.login.toLowerCase() ===
          part
            .slice(1)
            .replace(/[._-]+$/, "")
            .toLowerCase(),
      );
      if (person) {
        return (
          <Link className="mention" key={index} title={person.name} to={`/people/${person.id}`}>
            @{person.name}
          </Link>
        );
      }
    }
    const ticket = mentions?.tickets.find((item) => item.key === part);
    if (ticket) {
      return (
        <Link className="mention" key={index} title={ticket.title} to={`/tickets/${ticket.key}`}>
          {ticket.key}
        </Link>
      );
    }
    return part;
  });
}

/**
 * Предпросмотр Markdown шаблона: заголовки, маркированные и нумерованные списки, абзацы.
 * Рисуется элементами React, без вставки HTML, поэтому опасной разметки быть не может.
 */
export function MarkdownPreview({ source, mentions }: { source: string; mentions?: MarkdownMentions }) {
  const { t } = useI18n();
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) blocks.push(<blockquote key={blocks.length}>{inline(quote.join(" "), mentions, t)}</blockquote>);
    quote = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length}>
        {list.items.map((item, index) => (
          <li key={index}>
            {item ? inline(item, mentions, t) : <span className="md-placeholder">{t("template.notSet")}</span>}
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "), mentions, t)}</p>);
    paragraph = [];
  };
  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    // Маркер списка — «- » или «* » с пробелом (или пустой пункт), чтобы «**жирный**» не стал пунктом.
    const bullet = /^\s*[-*](?:\s+|$)(?:\[[ xX]\]\s?)?(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)](?:\s+|$)(.*)$/.exec(line);
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushList();
      flushParagraph();
      quote.push(quoted[1] ?? "");
      continue;
    }
    flushQuote();
    if (heading) {
      flushList();
      flushParagraph();
      const level = Math.min((heading[1]?.length ?? 2) + 1, 5);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={blocks.length}>{inline(heading[2] ?? "", mentions, t)}</Tag>);
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered && !bullet);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(((numbered && !bullet ? numbered[1] : bullet?.[1]) ?? "").trim());
    } else if (!line.trim()) {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushQuote();
  flushList();
  flushParagraph();
  return <div className="md-preview">{blocks}</div>;
}
