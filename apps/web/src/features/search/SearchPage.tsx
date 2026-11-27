import { FloppyDisk, MagnifyingGlass, ShareNetwork, Trash, UserCircle } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BulkEditInput, SavedFilter, TicketSummary, TqlProblem } from "@yourtask/contracts";
import { api, ApiError } from "../../api/client";
import {
  useDeleteFilter,
  useFilters,
  usePeople,
  useSaveFilter,
  useSearch,
  useSpaces,
  useTicketTypes,
  useVocabulary,
} from "../../api/hooks";
import { Badge, Button, Card, Dialog, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";
import { TypeMark } from "../setup/shared";
import { QueryEditor, TqlProblemView } from "./QueryEditor";

/**
 * Поиск (R-2.28; YT-15): запрос TQL чипами или текстом, полнотекст, сохранённые фильтры — личные и общие.
 * Результат и счётчик всегда в пределах прав смотрящего и «Режима показа» — это решает сервер.
 */
export function SearchPage() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [params, setParams] = useSearchParams();
  const spaces = useSpaces();
  const vocabulary = useVocabulary();
  const spaceSlug = params.get("space") ?? "";
  const space = spaces.data?.items.find((item) => item.slug === spaceSlug);
  const applied = params.get("q") ?? "";
  const [draft, setDraft] = useState(applied);
  useEffect(() => setDraft(applied), [applied]);
  const result = useSearch(applied, space?.id ?? "");
  const filters = useFilters(space?.id ?? "");
  const save = useSaveFilter();
  const remove = useDeleteFilter();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canShare = Boolean(space?.rights.includes("boards_space"));

  const run = (q: string, slug = spaceSlug) => {
    const next = new URLSearchParams();
    if (q.trim()) next.set("q", q.trim());
    if (slug) next.set("space", slug);
    setParams(next);
  };
  const serverProblem =
    result.error instanceof ApiError && result.error.code === "tql_invalid"
      ? (result.error.problem?.tql as TqlProblem)
      : null;
  const personal = (filters.data?.items ?? []).filter((item) => !item.shared);
  const common = (filters.data?.items ?? []).filter((item) => item.shared);

  return (
    <section className="page search-page">
      <header className="page-header">
        <h1>
          <MagnifyingGlass aria-hidden="true" size={24} /> {t("search.title")}
        </h1>
        <p className="ui-field__hint">{t("search.lead")}</p>
      </header>
      <div className="search-layout">
        <div className="search-main">
          <Card className="form-stack">
            <Select label={t("search.space")} onChange={(event) => run(draft, event.target.value)} value={spaceSlug}>
              <option value="">{t("search.allSpaces")}</option>
              {(spaces.data?.items ?? []).map((item) => (
                <option key={item.id} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </Select>
            <QueryEditor onChange={setDraft} onSubmit={run} value={draft} vocabulary={vocabulary.data} />
            <div className="page-actions">
              <Button onClick={() => run(draft)} type="button">
                <MagnifyingGlass aria-hidden="true" size={16} /> {t("search.run")}
              </Button>
            </div>
            {serverProblem && draft === applied ? <TqlProblemView problem={serverProblem} text={applied} /> : null}
            {applied && !serverProblem ? (
              <form
                className="inline-form search-save"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  if (!name.trim()) return;
                  save.mutate(
                    { name: name.trim(), query: applied, shared, spaceId: space?.id ?? null },
                    {
                      onSuccess: (filter) => {
                        setName("");
                        setNotice(t(filter.shared ? "search.savedShared" : "search.saved", { name: filter.name }));
                      },
                    },
                  );
                }}
              >
                <Input
                  label={t("search.filterName")}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
                <label className="checkbox-inline">
                  <input
                    checked={shared && canShare}
                    disabled={!canShare}
                    onChange={(event) => setShared(event.target.checked)}
                    type="checkbox"
                  />
                  {space ? t("search.forEveryone", { space: space.name }) : t("search.forEveryoneNoSpace")}
                </label>
                <Button loading={save.isPending} type="submit" variant="secondary">
                  <FloppyDisk aria-hidden="true" size={16} /> {t("search.save")}
                </Button>
              </form>
            ) : null}
            {save.isError ? <Notice error={errorText(save.error)} onDismiss={() => save.reset()} /> : null}
            {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}
          </Card>
          {result.isFetching && !result.data ? <Loading /> : null}
          {result.isError && !serverProblem ? (
            <ErrorState error={result.error} onRetry={() => void result.refetch()} />
          ) : null}
          {applied && result.data && !serverProblem ? (
            <section aria-label={t("search.results")} className="search-results">
              <p className="search-results__count" role="status">
                {t("search.found", { count: result.data.total, ms: result.data.tookMs })}
                {result.data.total > result.data.items.length
                  ? ` · ${t("search.shown", { count: result.data.items.length })}`
                  : ""}
              </p>
              <BulkResults items={result.data.items} />
            </section>
          ) : null}
          {!applied ? (
            <Card className="empty-state">
              <MagnifyingGlass aria-hidden="true" size={32} />
              <p>{t("search.empty")}</p>
              <ul className="search-examples">
                {[
                  "assignee = me() and statusCategory = active",
                  "due < today() and statusCategory != done",
                  "stream = GD or assignee.guild = GD",
                  'text ~ "камера"',
                ].map((example) => (
                  <li key={example}>
                    <button className="link-button" onClick={() => run(example)} type="button">
                      <code>{example}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
        <aside aria-label={t("search.filters")} className="search-side">
          <FilterList
            icon={<UserCircle aria-hidden="true" size={16} />}
            items={personal}
            onOpen={(filter) =>
              run(filter.query, spaces.data?.items.find((item) => item.id === filter.spaceId)?.slug ?? spaceSlug)
            }
            onRemove={(filter) => remove.mutate(filter.id)}
            title={t("search.mine")}
          />
          <FilterList
            icon={<ShareNetwork aria-hidden="true" size={16} />}
            items={common}
            onOpen={(filter) =>
              run(filter.query, spaces.data?.items.find((item) => item.id === filter.spaceId)?.slug ?? spaceSlug)
            }
            onRemove={(filter) => remove.mutate(filter.id)}
            title={t("search.shared")}
          />
        </aside>
      </div>
    </section>
  );
}

function FilterList({
  title,
  icon,
  items,
  onOpen,
  onRemove,
}: {
  title: string;
  icon: ReactNode;
  items: SavedFilter[];
  onOpen(filter: SavedFilter): void;
  onRemove(filter: SavedFilter): void;
}) {
  const { t } = useI18n();
  return (
    <Card className="saved-filters">
      <h2 className="ui-eyebrow">
        {icon} {title}
      </h2>
      {items.length ? (
        <ul>
          {items.map((filter) => (
            <li key={filter.id}>
              <button
                className="link-button saved-filters__open"
                onClick={() => onOpen(filter)}
                title={filter.query}
                type="button"
              >
                {filter.name}
              </button>
              {filter.shared && filter.owner ? <span className="ui-field__hint"> · {filter.owner.name}</span> : null}
              {filter.canEdit ? (
                <button
                  aria-label={t("search.deleteFilter", { name: filter.name })}
                  className="ui-icon-button"
                  onClick={() => onRemove(filter)}
                  type="button"
                >
                  <Trash aria-hidden="true" size={14} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ui-field__hint">{t("search.noFilters")}</p>
      )}
    </Card>
  );
}

type Found = TicketSummary & { spaceId: string };

/**
 * Массовая правка найденного (R-3.1, YT-18): выбрать тикеты → статус, приоритет или исполнитель для всех сразу.
 * Всё или ничего; уведомления — одно сообщение на получателя за всю операцию (R-2.27).
 */
function BulkResults({ items }: { items: Found[] }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const client = useQueryClient();
  const vocabulary = useVocabulary();
  const people = usePeople();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const editable = items.filter((item) => !item.titleOnly);
  const bulk = useMutation({
    mutationFn: (body: BulkEditInput) =>
      api<{ items: unknown[] }>("/api/v1/tickets/bulk", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setSelected(new Set());
      return client.invalidateQueries();
    },
  });
  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (!selected.size || (!status && !priority && !assignee)) return;
    bulk.mutate({
      keys: [...selected],
      ...(status ? { status } : {}),
      ...(priority ? { priority: priority as NonNullable<BulkEditInput["priority"]> } : {}),
      ...(assignee ? { assigneeIds: [assignee] } : {}),
    });
  };
  return (
    <>
      <form aria-label={t("bulk.title")} className="bulk-bar" onSubmit={apply}>
        <label className="bulk-bar__all">
          <input
            checked={editable.length > 0 && selected.size === editable.length}
            onChange={(event) =>
              setSelected(event.target.checked ? new Set(editable.map((item) => item.key)) : new Set())
            }
            type="checkbox"
          />
          {t("bulk.selected", { count: selected.size })}
        </label>
        <Select label={t("bulk.status")} onChange={(event) => setStatus(event.target.value)} value={status}>
          <option value="">—</option>
          {(vocabulary.data?.values.status ?? []).map((item) => (
            <option key={item.name} value={item.name}>
              {item.label}
            </option>
          ))}
        </Select>
        <Select label={t("bulk.priority")} onChange={(event) => setPriority(event.target.value)} value={priority}>
          <option value="">—</option>
          {["highest", "high", "normal", "low", "lowest"].map((item) => (
            <option key={item} value={item}>
              {t(`ticket.priority.${item}` as MessageKey)}
            </option>
          ))}
        </Select>
        <Select label={t("bulk.assignee")} onChange={(event) => setAssignee(event.target.value)} value={assignee}>
          <option value="">—</option>
          {(people.data?.items ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
        <Button disabled={!selected.size} loading={bulk.isPending} type="submit">
          {t("bulk.apply", { count: selected.size })}
        </Button>
      </form>
      {bulk.isError ? <Notice error={errorText(bulk.error)} onDismiss={() => bulk.reset()} /> : null}
      {bulk.isSuccess ? (
        <Notice message={t("bulk.done", { count: bulk.data.items.length })} onDismiss={() => bulk.reset()} />
      ) : null}
      <ResultList items={items} onToggle={toggle} selected={selected} />
    </>
  );
}

function ResultList({
  items,
  onPick,
  selected,
  onToggle,
}: {
  items: Found[];
  onPick?: () => void;
  selected?: Set<string>;
  onToggle?(key: string): void;
}) {
  const { t } = useI18n();
  const types = useTicketTypes();
  const spaces = useSpaces();
  const typeById = new Map((types.data?.items ?? []).map((type) => [type.id, type]));
  const spaceById = new Map((spaces.data?.items ?? []).map((space) => [space.id, space]));
  return (
    <ul className="search-list">
      {items.map((item) => {
        const type = typeById.get(item.typeId);
        return (
          <li key={item.id}>
            {selected && onToggle && !item.titleOnly ? (
              <input
                aria-label={t("bulk.select", { key: item.key })}
                checked={selected.has(item.key)}
                onChange={() => onToggle(item.key)}
                type="checkbox"
              />
            ) : null}
            {type ? <TypeMark color={type.color} icon={type.icon} /> : null}
            <Link onClick={onPick} to={`/tickets/${item.key}`}>
              <span className="ticket-key">{item.key}</span> {item.title}
            </Link>
            <span className="ui-field__hint">
              {type?.name} · {spaceById.get(item.spaceId)?.name ?? ""}
              {item.numbers[0] ? ` · № ${item.numbers[0]}` : ""}
            </span>
            {item.archived ? <Badge variant="neutral">archived</Badge> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Ctrl+K — командная строка (R-2.28): поиск по ключу, названию, описанию и старому номеру; Enter — открыть. */
export function CommandPalette() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), 200);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => setActive(0), [query]);
  const result = useSearch(open ? query : "", "", 8);
  const items = result.data?.items ?? [];
  const close = () => {
    setOpen(false);
    setText("");
    setQuery("");
  };
  const problem =
    result.error instanceof ApiError && result.error.code === "tql_invalid"
      ? (result.error.problem?.tql as TqlProblem)
      : null;
  return (
    <Dialog onClose={close} open={open} title={t("palette.title")}>
      <form
        className="form-stack palette"
        onSubmit={(event) => {
          event.preventDefault();
          const picked = items[active];
          if (picked) navigate(`/tickets/${picked.key}`);
          else navigate(`/search?q=${encodeURIComponent(text)}`);
          close();
        }}
      >
        <Input
          autoFocus
          hint={t("palette.hint")}
          label={t("palette.label")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && items.length) {
              event.preventDefault();
              setActive((active + 1) % items.length);
            }
            if (event.key === "ArrowUp" && items.length) {
              event.preventDefault();
              setActive((active - 1 + items.length) % items.length);
            }
          }}
          value={text}
        />
        {problem ? <TqlProblemView problem={problem} text={query} /> : null}
        {query && result.data ? (
          <>
            <p className="ui-field__hint" role="status">
              {t("search.found", { count: result.data.total, ms: result.data.tookMs })}
            </p>
            <ul className="search-list palette__list" role="listbox" aria-label={t("search.results")}>
              {items.map((item, index) => (
                <li
                  aria-selected={index === active}
                  className={index === active ? "is-active" : ""}
                  key={item.id}
                  role="option"
                >
                  <Link onClick={close} to={`/tickets/${item.key}`}>
                    <span className="ticket-key">{item.key}</span> {item.title}
                  </Link>
                </li>
              ))}
            </ul>
            <Link onClick={close} to={`/search?q=${encodeURIComponent(query)}`}>
              {t("palette.all")}
            </Link>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
