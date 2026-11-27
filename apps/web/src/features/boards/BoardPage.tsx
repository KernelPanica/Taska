import {
  ArrowsOutCardinal,
  LinkSimple,
  PushPin,
  CalendarBlank,
  CaretDown,
  CaretRight,
  GearSix,
  LockSimple,
  Plus,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  BOARD_LANES,
  CHIP_NONE,
  isBoardLanes,
  CARD_DENSITIES,
  DETAIL_LEVELS,
  UNMAPPED_ZONE,
  boardLayout,
  compareCards,
  dropOptions,
  wipCount,
  type BoardCard,
  type BoardColumn,
  type BoardLanes,
  type BoardPrefs,
  type BoardStatusOption,
  type CardDensity,
  type DetailLevel,
} from "@yourtask/contracts";
import { useBoard, useCreateOnBoard, useMoveCard, useReorder, useSavePrefs, type LoadedBoard } from "../../api/boards";
import { ApiError } from "../../api/client";
import { useFields, useSpaces, useTicketTypes } from "../../api/hooks";
import { ErrorState, Loading } from "../../app/states";
import { Badge, Button, Input, Select } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { useErrorText } from "../directory/shared";
import { TypeMark } from "../setup/shared";
import { BoardSettings } from "./BoardSettings";
import { lanesFor, valuesOf } from "./lanes";

/**
 * Доска (R-2.18, R-2.19; YT-16): базовый фильтр TQL, колонки-зоны с деревом и детализацией 1 / 2 / 3,
 * дорожки, чипы, перетаскивание за всю карточку с выбором статуса, три плотности, живые изменения.
 * Детализация, свёрнутые зоны и уровни, плотность и чипы — личные настройки и часть адреса.
 */
export function BoardPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const board = useBoard(id, params.get("q") ?? "");
  if (board.isPending) return <Loading />;
  if (board.isError) return <ErrorState error={board.error} onRetry={() => void board.refetch()} />;
  return <BoardScreen data={board.data} />;
}

interface Choice {
  column: BoardColumn;
  status: BoardStatusOption;
  outcome?: string;
}

interface Chooser {
  card: BoardCard;
  title: string;
  choices: Choice[];
  beforeKey: string | null;
  x: number;
  y: number;
}

type NoticeState = { tone: "danger" | "success" | "info"; text: string; items?: string[]; link?: string } | null;

/** Состояние доски в адресе (R-2.18): по ссылке другой видит то же самое в пределах своих прав. */
function readUrl(prefs: BoardPrefs, params: URLSearchParams): BoardPrefs {
  const detail = Number(params.get("detail"));
  const lanes = params.get("lanes");
  const density = params.get("density");
  const off = params.get("off");
  const collapsed = params.get("collapsed");
  const hidden = params.get("hide");
  const on = params.get("on");
  const lanesCollapsed = params.get("lc");
  return {
    ...prefs,
    ...((DETAIL_LEVELS as readonly number[]).includes(detail) ? { detail: detail as DetailLevel } : {}),
    ...(lanes && isBoardLanes(lanes) ? { lanes } : {}),
    ...(density && (CARD_DENSITIES as readonly string[]).includes(density) ? { density: density as CardDensity } : {}),
    ...(off !== null ? { chipsOff: off ? off.split(",") : [] } : {}),
    ...(collapsed !== null ? { collapsed: collapsed ? collapsed.split(",") : [] } : {}),
    ...(hidden !== null ? { hiddenLevels: hidden ? hidden.split(",").map(Number).filter(Boolean) : [] } : {}),
    ...(on !== null ? { tqlOn: on ? on.split(",") : [] } : {}),
    ...(lanesCollapsed !== null ? { lanesCollapsed: lanesCollapsed ? lanesCollapsed.split(",") : [] } : {}),
  };
}

function writeUrl(params: URLSearchParams, prefs: BoardPrefs) {
  const next = new URLSearchParams(params);
  next.set("detail", String(prefs.detail));
  next.set("density", prefs.density);
  if (prefs.lanes) next.set("lanes", prefs.lanes);
  else next.delete("lanes");
  next.set("off", prefs.chipsOff.join(","));
  next.set("collapsed", prefs.collapsed.join(","));
  next.set("hide", prefs.hiddenLevels.join(","));
  next.set("on", prefs.tqlOn.join(","));
  next.set("lc", prefs.lanesCollapsed.join(","));
  return next;
}

function BoardScreen({ data }: { data: LoadedBoard }) {
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const types = useTicketTypes();
  const fields = useFields();
  const { board, cards, schemes } = data;
  const [params, setParams] = useSearchParams();
  const prefs = useMemo(() => readUrl(data.prefs, params), [data.prefs, params]);
  const savePrefs = useSavePrefs(board.id);
  const move = useMoveCard(board.id);
  const reorder = useReorder(board.id);
  const [drag, setDrag] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<{ column: string; before: string | null } | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [panel, setPanel] = useState<"create" | "settings" | null>(null);

  // Адрес меняется в переходе (startTransition), поэтому два быстрых клика подряд видели бы старое состояние:
  // копим последнее записанное и сбрасываем, когда адрес догнал.
  const pending = useRef<BoardPrefs | null>(null);
  useEffect(() => {
    pending.current = null;
  }, [prefs]);
  const setPrefs = (patch: Partial<BoardPrefs>) => {
    const next = { ...(pending.current ?? prefs), ...patch };
    pending.current = next;
    savePrefs.mutate(next);
    setParams((current) => writeUrl(current, next), { replace: true });
  };

  const typeOf = (id: string) => types.data?.items.find((item) => item.id === id);
  const boardName = board.kind === "mine" ? t("boards.mine") : board.name;
  const lanesMode = prefs.lanes ?? board.lanes;

  const layout = useMemo(
    () => boardLayout(board.zones, prefs, [...new Set(cards.map((card) => card.statusName))]),
    [board.zones, prefs, cards],
  );
  const waiting = useMemo(
    () => new Set(Object.values(schemes).flatMap((list) => list.filter((s) => s.waiting).map((s) => s.name))),
    [schemes],
  );

  const fieldName = (key: string) => data.dimensions.find((item) => item.key === key)?.name ?? key;
  const dimLabel = (dim: string) =>
    dim.startsWith("field:") ? `${fieldName(dim.slice(6))}:` : t(`board.chips.${dim}` as MessageKey);

  /**
   * Чипы — быстрые фильтры над доской (R-2.18): команды, стримы, типы, исполнители, теги, любое измерение и «Без …».
   * Выключенный скрывает карточки, доска и счётчики не меняются. Состояние — личное и в адресе.
   */
  const chipGroups = useMemo(() => {
    const groups: { dim: string; label: string; values: { id: string; name: string }[] }[] = [];
    for (const dim of board.chips) {
      const values = new Map<string, string>();
      let empty = false;
      for (const card of cards) {
        const list =
          dim === "type" ? [{ id: card.typeId, title: typeOf(card.typeId)?.name ?? card.typeId }] : valuesOf(card, dim);
        if (!list.length) empty = true;
        list.forEach((value) => values.set(value.id, value.title));
      }
      const sorted = [...values].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
      if (empty && dim !== "type") sorted.push({ id: CHIP_NONE, name: t("board.chips.none") });
      groups.push({ dim, label: dimLabel(dim), values: sorted });
    }
    return groups;
  }, [board.chips, cards, types.data, data.dimensions, t]);
  const off = new Set(prefs.chipsOff);
  const tqlOn = prefs.tqlOn.filter((id) => board.tqlChips.some((chip) => chip.id === id));
  const shown = useMemo(() => {
    const offSet = new Set(prefs.chipsOff);
    // Выключен каждый из значений карточки — скрыта; без значения — по чипу «Без …».
    const hidden = (dim: string, ids: string[]) =>
      ids.length ? ids.every((id) => offSet.has(`${dim}:${id}`)) : offSet.has(`${dim}:${CHIP_NONE}`);
    const onSets = tqlOn.map((id) => new Set(data.chipHits[id] ?? []));
    return cards
      .filter(
        (card) =>
          board.chips.every((dim) =>
            dim === "type"
              ? !hidden("type", [card.typeId])
              : !hidden(
                  dim,
                  valuesOf(card, dim).map((v) => v.id),
                ),
          ) && onSets.every((set) => set.has(card.id)),
      )
      .sort(compareCards(board.sort));
  }, [cards, prefs.chipsOff, tqlOn.join(","), board.sort, board.chips, data.chipHits]);

  /** Колонка карточки: первая колонка, где есть её статус. */
  const columnIndex = useMemo(() => {
    const map = new Map<string, number>();
    layout.columns.forEach((column, index) =>
      column.statuses.forEach((status) => {
        if (!map.has(status)) map.set(status, index);
      }),
    );
    return map;
  }, [layout]);

  const lanes = lanesFor(
    shown,
    lanesMode,
    {
      noParent: t("board.lanes.noParent"),
      noTeam: t("board.lanes.noTeam"),
      noStream: t("board.lanes.noStream"),
      noAssignee: t("board.lanes.noAssignee"),
      noTags: t("board.lanes.noTags"),
      noField: (name) => t("board.lanes.noField", { name }),
      hiddenParent: t("board.lanes.hiddenParent"),
      others: t("board.lanes.others"),
    },
    { filters: board.tqlLanes, hits: data.laneHits },
    fieldName,
  );
  const [refine, setRefine] = useState(data.refine ?? "");
  const [copied, setCopied] = useState(false);
  const applyRefine = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams(params);
    if (refine.trim()) next.set("q", refine.trim());
    else next.delete("q");
    setParams(next, { replace: true });
  };
  /** Ссылка на доску в этом же состоянии: фильтр, чипы, дорожки, детализация (R-2.18). */
  const copyLink = async () => {
    const link = new URL(window.location.href);
    link.search = writeUrl(params, prefs).toString();
    try {
      await navigator.clipboard.writeText(link.href);
    } catch {
      window.prompt(t("board.copyLink"), link.href);
    }
    setCopied(true);
  };

  /** Все статусы в зоне, что подходят типу; завершённые — с исходом (кроме отмены: она с причиной). */
  const choicesFor = (card: BoardCard, column: BoardColumn): Choice[] =>
    dropOptions(column, schemes[card.scheme] ?? []).flatMap((status) =>
      status.category === "done"
        ? status.outcomes.filter((outcome) => outcome !== "cancelled").map((outcome) => ({ column, status, outcome }))
        : [{ column, status }],
    );

  /** Новый ручной порядок колонки: карточка встаёт перед beforeKey (или в конец). */
  const orderFor = (card: BoardCard, column: BoardColumn, beforeKey: string | null) => {
    const names = new Set(column.statuses);
    const keys = shown.filter((item) => names.has(item.statusName) && item.id !== card.id).map((item) => item.key);
    const at = beforeKey ? keys.indexOf(beforeKey) : -1;
    keys.splice(at < 0 ? keys.length : at, 0, card.key);
    return [...new Set(keys)];
  };

  const runMove = (card: BoardCard, choice: Choice, beforeKey: string | null) => {
    setChooser(null);
    setNotice(null);
    const order = board.sort === "manual" ? orderFor(card, choice.column, beforeKey) : undefined;
    if (choice.status.id === card.statusId && !choice.outcome) {
      if (order) reorder.mutate(order);
      return;
    }
    move.mutate(
      {
        key: card.key,
        version: card.version,
        zoneId: choice.column.zoneId,
        statusId: choice.status.id,
        ...(choice.outcome ? { outcome: choice.outcome } : {}),
        ...(order ? { order } : {}),
      },
      {
        onError: (error) => {
          if (error instanceof ApiError && error.code === "transition_blocked") {
            setNotice({
              tone: "danger",
              text: t("board.blocked", { key: card.key, status: choice.status.name }),
              // Что заполнить — тем же языком, что в карточке тикета.
              items: (error.problem?.errors ?? []).map((item) =>
                item.field.startsWith("values.")
                  ? t("ticket.req.field", {
                      name:
                        fields.data?.items.find((field) => field.key === item.field.slice(7))?.name ??
                        item.field.slice(7),
                    })
                  : item.field.startsWith("people.")
                    ? t(`ticket.req.people.${item.field.slice(7)}` as MessageKey)
                    : item.field === "description" || item.field === "checklist_done"
                      ? t(`ticket.req.${item.field}` as MessageKey)
                      : item.message,
              ),
              link: `/tickets/${card.key}`,
            });
          } else if (error instanceof ApiError && error.code === "version_conflict") {
            setNotice({ tone: "danger", text: t("board.conflict", { key: card.key }) });
          } else {
            setNotice({ tone: "danger", text: errorText(error) });
          }
        },
      },
    );
  };

  const columnName = (column: BoardColumn) =>
    column.status
      ? `${board.zones.find((zone) => zone.id === column.zoneId)?.name ?? ""} · ${column.status}`
      : column.name;

  /** Бросили в колонку: нет статусов для типа — причина; один — сразу; несколько — выбор на месте. */
  const dropInto = (card: BoardCard, column: BoardColumn, beforeKey: string | null, x: number, y: number) => {
    if (column.id === UNMAPPED_ZONE) {
      setNotice({ tone: "info", text: t("board.toUnmapped") });
      return;
    }
    const choices = choicesFor(card, column);
    const typeName = typeOf(card.typeId)?.name ?? "";
    if (!choices.length) {
      setNotice({
        tone: "danger",
        text: t("board.notForType", { type: typeName, zone: columnName(column), statuses: column.statuses.join(", ") }),
      });
      return;
    }
    const here = choices.find((choice) => choice.status.id === card.statusId);
    if (here && columnIndex.get(card.statusName) === layout.columns.indexOf(column)) {
      runMove(card, here, beforeKey);
      return;
    }
    if (choices.length === 1) {
      runMove(card, choices[0] as Choice, beforeKey);
      return;
    }
    setChooser({ card, title: t("board.chooseIn", { zone: columnName(column) }), choices, beforeKey, x, y });
  };

  /** «Переместить» с клавиатуры: все колонки, куда этому типу можно. */
  const openMoveMenu = (card: BoardCard, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const choices = layout.columns
      .filter((column) => column.id !== UNMAPPED_ZONE)
      .flatMap((column) => choicesFor(card, column))
      .filter(
        (choice, index, all) =>
          choice.status.id !== card.statusId &&
          all.findIndex((item) => item.status.id === choice.status.id && item.outcome === choice.outcome) === index,
      );
    setChooser({
      card,
      title: t("board.moveTo", { key: card.key }),
      choices,
      beforeKey: null,
      x: rect.left,
      y: rect.bottom + 4,
    });
  };

  const onCellDrop = (event: DragEvent, column: BoardColumn) => {
    event.preventDefault();
    const card = drag;
    const before = over?.column === column.id ? over.before : null;
    setDrag(null);
    setOver(null);
    if (!card) return;
    dropInto(card, column, before, event.clientX, event.clientY);
  };

  const canDrop = (column: BoardColumn) =>
    drag ? column.id !== UNMAPPED_ZONE && choicesFor(drag, column).length > 0 : true;

  const cellCount = (statuses: readonly string[]) => {
    const names = new Set(statuses);
    return new Set(cards.filter((card) => names.has(card.statusName)).map((card) => card.id)).size;
  };

  const toggleZone = (zoneId: string) =>
    setPrefs({
      collapsed: prefs.collapsed.includes(zoneId)
        ? prefs.collapsed.filter((id) => id !== zoneId)
        : [...prefs.collapsed, zoneId],
    });

  const grid = { gridTemplateColumns: `repeat(${layout.columns.length}, minmax(13.5rem, 1fr))` };
  const outcomeLabel = (card: BoardCard, key: string) =>
    typeOf(card.typeId)?.outcomes.find((item) => item.key === key)?.label ?? key;

  return (
    <section className="page board-page">
      <nav aria-label={t("board.breadcrumbs")} className="board-crumbs">
        {board.owner.kind === "space" ? (
          <Link to={`/spaces/${board.owner.spaceSlug}`}>{board.owner.spaceName}</Link>
        ) : (
          <span>{t("boards.personal")}</span>
        )}
        <span aria-hidden="true"> › </span>
        <Link to="/boards">{t("boards.title")}</Link>
      </nav>
      <header className="board-heading">
        <h1>{boardName}</h1>
        <div className="board-heading__actions">
          <div aria-label={t("board.views")} className="board-views" role="group">
            <span aria-current="page" className="board-views__item is-active">
              {t("board.view.board")}
            </span>
            {board.owner.kind === "space" ? (
              <Link className="board-views__item" to={`/spaces/${board.owner.spaceSlug}/tree`}>
                {t("board.view.tree")}
              </Link>
            ) : null}
          </div>
          {board.canEdit ? (
            <Button
              aria-expanded={panel === "settings"}
              onClick={() => setPanel(panel === "settings" ? null : "settings")}
              variant="secondary"
            >
              <GearSix aria-hidden="true" size={18} />
              {t("board.settings")}
            </Button>
          ) : null}
          <Button aria-expanded={panel === "create"} onClick={() => setPanel(panel === "create" ? null : "create")}>
            <Plus aria-hidden="true" size={18} />
            {t("board.create")}
          </Button>
        </div>
      </header>

      <div className="board-filter">
        <span className="board-filter__label">{t("board.filter")}</span>
        <code className="board-chip board-chip--static">{board.query}</code>
        <span className="board-chip board-chip--static">{t("board.archiveHidden")}</span>
        <label className="board-filter__label" htmlFor="board-lanes">
          {t("board.lanes")}
        </label>
        <select
          className="board-select"
          id="board-lanes"
          onChange={(event) => setPrefs({ lanes: event.target.value as BoardLanes })}
          value={lanesMode}
        >
          {BOARD_LANES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`board.lanes.${mode}` as MessageKey)}
            </option>
          ))}
          {data.dimensions.map((dimension) => (
            <option key={dimension.key} value={`field:${dimension.key}`}>
              {t("board.lanes.byField", { name: dimension.name })}
            </option>
          ))}
        </select>
        <Button onClick={() => void copyLink()} variant="secondary">
          <LinkSimple aria-hidden="true" size={16} />
          {t("board.copyLink")}
        </Button>
        {copied ? <span role="status">{t("board.linkCopied")}</span> : null}
      </div>
      <form className="board-filter" onSubmit={applyRefine} role="search">
        <label className="board-filter__label" htmlFor="board-refine">
          {t("board.refine")}
        </label>
        <input
          className="ui-input board-refine"
          id="board-refine"
          onChange={(event) => setRefine(event.target.value)}
          placeholder="priority = Urgent"
          value={refine}
        />
        <Button type="submit" variant="secondary">
          {t("board.refineApply")}
        </Button>
        {data.refine ? (
          <Button
            onClick={() => {
              setRefine("");
              const next = new URLSearchParams(params);
              next.delete("q");
              setParams(next, { replace: true });
            }}
            variant="ghost"
          >
            {t("board.refineClear")}
          </Button>
        ) : null}
      </form>

      {chipGroups.some((group) => group.values.length) || board.tqlChips.length ? (
        <div className="board-filter">
          {chipGroups.map((group) =>
            group.values.length ? (
              <div aria-label={group.label} className="board-chips" key={group.dim} role="group">
                <span className="board-filter__label">{group.label}</span>
                {group.values.map((value) => {
                  const id = `${group.dim}:${value.id}`;
                  const on = !off.has(id);
                  return (
                    <button
                      aria-pressed={on}
                      className={`board-chip ${on ? "is-on" : ""}`}
                      key={id}
                      onClick={() =>
                        setPrefs({
                          chipsOff: on ? [...prefs.chipsOff, id] : prefs.chipsOff.filter((item) => item !== id),
                        })
                      }
                      type="button"
                    >
                      {value.name}
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
          {board.tqlChips.length ? (
            <div aria-label={t("board.chips.more")} className="board-chips" role="group">
              <span className="board-filter__label">{t("board.chips.more")}</span>
              {board.tqlChips.map((chip) => {
                const on = tqlOn.includes(chip.id);
                return (
                  <button
                    aria-pressed={on}
                    className={`board-chip board-chip--filter ${on ? "is-on" : ""}`}
                    key={chip.id}
                    onClick={() =>
                      setPrefs({ tqlOn: on ? prefs.tqlOn.filter((id) => id !== chip.id) : [...prefs.tqlOn, chip.id] })
                    }
                    title={chip.query}
                    type="button"
                  >
                    {chip.name}
                  </button>
                );
              })}
            </div>
          ) : null}
          <span className="board-hint">{t("board.chipsHint")}</span>
        </div>
      ) : null}

      <div className="board-controls">
        <div aria-label={t("board.detail")} className="board-segment" role="group">
          <span className="board-filter__label">{t("board.detail")}</span>
          {DETAIL_LEVELS.map((level) => (
            <button
              aria-pressed={prefs.detail === level}
              className={`board-segment__item ${prefs.detail === level ? "is-on" : ""}`}
              key={level}
              onClick={() => setPrefs({ detail: level })}
              type="button"
            >
              {level}
            </button>
          ))}
        </div>
        {layout.levels.length > 1
          ? layout.levels.map((level) => {
              const hidden = prefs.hiddenLevels.includes(level);
              const lastVisible = !hidden && layout.levels.filter((l) => !prefs.hiddenLevels.includes(l)).length === 1;
              return (
                <Button
                  aria-pressed={hidden}
                  disabled={lastVisible}
                  key={level}
                  onClick={() =>
                    setPrefs({
                      hiddenLevels: hidden
                        ? prefs.hiddenLevels.filter((item) => item !== level)
                        : [...prefs.hiddenLevels, level],
                    })
                  }
                  variant="ghost"
                >
                  {t(hidden ? "board.showLevel" : "board.hideLevel", { level })}
                </Button>
              );
            })
          : null}
        <label className="board-filter__label" htmlFor="board-density">
          {t("board.density")}
        </label>
        <select
          className="board-select"
          id="board-density"
          onChange={(event) => setPrefs({ density: event.target.value as CardDensity })}
          value={prefs.density}
        >
          {CARD_DENSITIES.map((density) => (
            <option key={density} value={density}>
              {t(`board.density.${density}` as MessageKey)}
            </option>
          ))}
        </select>
        <span className="board-hint">{t("board.personalHint")}</span>
      </div>

      {panel === "create" ? (
        <CreateOnBoard boardId={board.id} onDone={setNotice} spaceBoard={board.owner.kind === "space"} />
      ) : null}
      {panel === "settings" ? <BoardSettings data={data} onClose={() => setPanel(null)} /> : null}

      {notice ? (
        <div
          className={`board-notice board-notice--${notice.tone}`}
          role={notice.tone === "danger" ? "alert" : "status"}
        >
          {notice.tone === "danger" ? <Warning aria-hidden="true" size={18} /> : null}
          <div>
            <p>{notice.text}</p>
            {notice.items?.length ? (
              <ul>
                {notice.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {notice.link ? <Link to={notice.link}>{t("board.openTicket")}</Link> : null}
          </div>
          <button
            aria-label={t("common.dismiss")}
            className="ui-icon-button"
            onClick={() => setNotice(null)}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      ) : null}

      {layout.unmapped.length ? (
        <div className="board-notice board-notice--warning" role="status">
          <Warning aria-hidden="true" size={18} />
          <p>{t("board.unmappedWarning", { statuses: layout.unmapped.join(", ") })}</p>
        </div>
      ) : null}

      <p className="board-hint">
        {t("board.hint")}
        {data.hiddenDone ? ` ${t("board.hiddenDone", { count: data.hiddenDone, days: board.doneDays })}` : ""}
        {data.overflow ? ` ${t("board.overflow", { count: data.overflow })}` : ""}
      </p>

      <div className="board-scroll">
        <div className="board-head" role="row" style={{ ...grid, gridTemplateRows: `repeat(${layout.rows}, auto)` }}>
          {layout.cells.map((cell) => {
            const count = cellCount(cell.statuses);
            const wip = cell.wipLimit ? wipCount(cards, cell.statuses) : 0;
            const overLimit = cell.wipLimit !== null && wip > cell.wipLimit;
            const column = layout.columns[cell.col - 1];
            const blocked = Boolean(drag && cell.colSpan === 1 && column && !canDrop(column));
            const unmapped = cell.id === UNMAPPED_ZONE;
            return (
              <div
                className={`board-zone ${overLimit ? "board-zone--over" : ""} ${unmapped ? "board-zone--unmapped" : ""} ${cell.status ? "board-zone--status" : ""} ${blocked ? "board-zone--blocked" : ""}`}
                key={cell.id}
                role="columnheader"
                style={{
                  gridColumn: `${cell.col} / span ${cell.colSpan}`,
                  gridRow: `${cell.row} / span ${cell.rowSpan}`,
                }}
              >
                <div className="board-zone__title">
                  {cell.expandable ? (
                    <button
                      aria-expanded={!cell.collapsed}
                      aria-label={t(cell.collapsed ? "board.expandZone" : "board.collapseZone", { zone: cell.name })}
                      className="board-zone__toggle"
                      onClick={() => toggleZone(cell.zoneId)}
                      type="button"
                    >
                      {cell.collapsed ? (
                        <CaretRight aria-hidden="true" size={14} />
                      ) : (
                        <CaretDown aria-hidden="true" size={14} />
                      )}
                    </button>
                  ) : null}
                  <strong>{unmapped ? t("board.unmapped") : cell.name}</strong>
                  {unmapped ? <Warning aria-label={t("board.unmappedIcon")} size={16} /> : null}
                  <span className="board-zone__count">
                    {cell.wipLimit !== null ? `${wip} / ${cell.wipLimit}` : count}
                  </span>
                </div>
                {cell.status && waiting.has(cell.status) ? (
                  <span className="board-zone__sub">{t("board.waiting")}</span>
                ) : null}
                {overLimit ? <span className="board-zone__sub">{t("board.wipOver")}</span> : null}
                {unmapped ? <span className="board-zone__sub">{cell.statuses.join(", ")}</span> : null}
                {!cell.status && !unmapped && cell.colSpan === 1 && cell.statuses.length > 1 ? (
                  <span className="board-zone__sub" title={cell.statuses.join(", ")}>
                    {cell.statuses.length > 2
                      ? `${cell.statuses[0]} … ${cell.statuses.at(-1)}`
                      : cell.statuses.join(", ")}
                  </span>
                ) : null}
                {blocked && drag ? (
                  <span className="board-zone__sub">
                    {t("board.noStatusesFor", { type: typeOf(drag.typeId)?.name ?? "" })}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        {shown.length === 0 ? (
          <p className="board-empty">{t(cards.length ? "board.allHidden" : "board.empty")}</p>
        ) : null}

        {lanes.map((lane) => {
          const collapsed = prefs.lanesCollapsed.includes(lane.id);
          const unique = new Set(lane.cards.map((entry) => entry.card.id)).size;
          return (
            <section aria-label={lane.title || boardName} className="board-lane" key={lane.id}>
              {lane.id !== "all" ? (
                <h2 className="board-lane__title">
                  <button
                    aria-expanded={!collapsed}
                    className="board-lane__toggle"
                    onClick={() =>
                      setPrefs({
                        lanesCollapsed: collapsed
                          ? prefs.lanesCollapsed.filter((id) => id !== lane.id)
                          : [...prefs.lanesCollapsed, lane.id],
                      })
                    }
                    type="button"
                  >
                    {collapsed ? (
                      <CaretRight aria-hidden="true" size={14} />
                    ) : (
                      <CaretDown aria-hidden="true" size={14} />
                    )}
                    {lane.pinned ? <PushPin aria-label={t("board.lanes.pinned")} size={14} /> : null}
                    {lane.key ? <span className="board-lane__key">{lane.key}</span> : null}
                    <span>{lane.title}</span>
                  </button>
                  {lane.pinned ? <code className="board-lane__meta">{lane.pinned}</code> : null}
                  <span className="board-lane__meta">{t("board.laneCount", { count: unique })}</span>
                </h2>
              ) : null}
              {collapsed ? null : (
                <div className="board-row" style={grid}>
                  {layout.columns.map((column, index) => {
                    const entries = lane.cards.filter((entry) => columnIndex.get(entry.card.statusName) === index);
                    const allowed = canDrop(column);
                    return (
                      <div
                        aria-label={columnName(column) || t("board.unmapped")}
                        className={`board-cell ${drag ? (allowed ? "board-cell--can" : "board-cell--cannot") : ""} ${over?.column === column.id ? "board-cell--over" : ""}`}
                        key={column.id}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null);
                        }}
                        onDragOver={(event) => {
                          if (!drag) return;
                          // Бросок в «чужую» колонку принимаем, чтобы объяснить причину отказа (R-3.3).
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          if (over?.column !== column.id) setOver({ column: column.id, before: null });
                        }}
                        onDrop={(event) => onCellDrop(event, column)}
                        role="group"
                      >
                        {entries.map(({ card, repeat }) => (
                          <CardView
                            card={card}
                            density={prefs.density}
                            dragging={drag?.id === card.id}
                            dropBefore={over?.column === column.id && over.before === card.key && drag?.id !== card.id}
                            key={`${lane.id}:${card.id}`}
                            onDragEnd={() => {
                              setDrag(null);
                              setOver(null);
                            }}
                            onDragOverCard={() => {
                              if (drag && board.sort === "manual") setOver({ column: column.id, before: card.key });
                            }}
                            onDragStart={() => {
                              setNotice(null);
                              setDrag(card);
                            }}
                            onMove={(anchor) => openMoveMenu(card, anchor)}
                            outcomeLabel={(key) => outcomeLabel(card, key)}
                            repeat={repeat}
                            showStatus={column.statuses.length > 1}
                            typeName={typeOf(card.typeId)?.name ?? ""}
                            typeMark={typeOf(card.typeId)}
                            locale={locale}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {chooser ? (
        <StatusChooser
          chooser={chooser}
          onChoose={(choice) => runMove(chooser.card, choice, chooser.beforeKey)}
          onClose={() => setChooser(null)}
          outcomeLabel={(key) => outcomeLabel(chooser.card, key)}
          waitingLabel={t("board.waiting")}
        />
      ) : null}
    </section>
  );
}

function CardView({
  card,
  density,
  repeat,
  showStatus,
  typeName,
  typeMark,
  dragging,
  dropBefore,
  locale,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onMove,
  outcomeLabel,
}: {
  card: BoardCard;
  density: CardDensity;
  repeat: boolean;
  showStatus: boolean;
  typeName: string;
  typeMark: { icon: Parameters<typeof TypeMark>[0]["icon"]; color: string } | undefined;
  dragging: boolean;
  dropBefore: boolean;
  locale: string;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOverCard(): void;
  onMove(anchor: HTMLElement): void;
  outcomeLabel(key: string): string;
}) {
  const { t } = useI18n();
  const due = card.due
    ? new Date(`${card.due}T00:00:00`).toLocaleDateString(locale === "en" ? "en-GB" : "ru-RU", {
        day: "numeric",
        month: "short",
      })
    : null;
  const people = card.assignees.map((person) => person.name).join(", ");
  return (
    <article
      aria-label={`${card.key} ${card.title}`}
      className={`board-card board-card--${density} ${repeat ? "board-card--repeat" : ""} ${dragging ? "is-dragging" : ""} ${dropBefore ? "board-card--drop-before" : ""} ${card.overdue ? "board-card--overdue" : ""}`}
      draggable={card.canMove}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.key);
        onDragStart();
      }}
    >
      <div className="board-card__top">
        <Link className="board-card__key" to={`/tickets/${card.key}`}>
          {card.key}
        </Link>
        {card.numbers.length ? <span className="board-card__number">{card.numbers.join(" · ")}</span> : null}
        {card.canMove ? (
          <button
            aria-label={t("board.moveCard", { key: card.key })}
            className="board-card__move"
            onClick={(event) => onMove(event.currentTarget)}
            type="button"
          >
            <ArrowsOutCardinal aria-hidden="true" size={16} />
          </button>
        ) : (
          <LockSimple aria-label={t("board.cannotMove")} className="board-card__lock" size={14} />
        )}
      </div>
      <Link className="board-card__title" to={`/tickets/${card.key}`}>
        {card.title}
      </Link>
      {repeat ? <p className="board-card__repeat">{t("board.sameTicket")}</p> : null}
      <div className="board-card__tags">
        <span className="board-tag">
          {typeMark ? <TypeMark color={typeMark.color} icon={typeMark.icon} size={14} /> : null}
          {typeName}
        </span>
        {card.streams.map((stream) => (
          <span className="board-tag board-tag--stream" key={stream.id}>
            {stream.name}
          </span>
        ))}
        {density === "detailed" && card.team ? <span className="board-tag">{card.team.name}</span> : null}
        {density === "detailed"
          ? card.tags.map((tag) => (
              <span className="board-tag board-tag--muted" key={tag}>
                {tag}
              </span>
            ))
          : null}
        {density !== "compact" && card.parents.length > 1 ? (
          <span className="board-tag board-tag--muted">{t("board.parents", { count: card.parents.length })}</span>
        ) : null}
      </div>
      <div className="board-card__meta">
        <span className={showStatus || density !== "compact" ? "" : "vh"}>
          {card.statusName}
          {card.outcome ? ` · ${outcomeLabel(card.outcome)}` : ""}
        </span>
        {people ? <span>{people}</span> : <span className="board-card__muted">{t("board.noAssignee")}</span>}
        {due ? (
          <span className="board-card__due">
            <CalendarBlank aria-hidden="true" size={14} />
            {due}
          </span>
        ) : null}
        {card.overdue ? (
          <Badge variant="danger">
            <Warning aria-hidden="true" size={14} />
            {t("board.overdue")}
          </Badge>
        ) : null}
        {card.blocked ? <Badge variant="warning">{t("board.blockedFlag")}</Badge> : null}
        {density === "detailed" && card.priority !== "normal" ? (
          <span>{t(`ticket.priority.${card.priority}` as MessageKey)}</span>
        ) : null}
      </div>
      {density === "detailed" && card.progress && card.progress.total > 0 ? (
        <div
          aria-label={t("board.progress", { done: card.progress.done, total: card.progress.total })}
          className="board-card__progress"
          role="img"
        >
          <span style={{ width: `${Math.round((card.progress.done / card.progress.total) * 100)}%` }} />
        </div>
      ) : null}
    </article>
  );
}

/** Выбор статуса на месте броска: не модальное окно, Esc и клик мимо закрывают, стрелки ходят по вариантам. */
function StatusChooser({
  chooser,
  onChoose,
  onClose,
  outcomeLabel,
  waitingLabel,
}: {
  chooser: Chooser;
  onChoose(choice: Choice): void;
  onClose(): void;
  outcomeLabel(key: string): string;
  waitingLabel: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const node = ref.current;
    // Закрыли выбор — фокус возвращается туда, откуда его открыли (кнопка «Переместить»).
    const previous = document.activeElement;
    node?.querySelector<HTMLButtonElement>("button[data-choice]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const all = [...(node?.querySelectorAll<HTMLButtonElement>("button[data-choice]") ?? [])];
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
        all[next]?.focus();
        event.preventDefault();
      }
    };
    const onOutside = (event: MouseEvent) => {
      if (node && !node.contains(event.target as Node)) close.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside);
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, []);
  const left = Math.max(8, Math.min(chooser.x, window.innerWidth - 300));
  const top = Math.max(8, Math.min(chooser.y, window.innerHeight - 320));
  let group = "";
  return (
    <div aria-label={chooser.title} className="board-chooser" ref={ref} role="dialog" style={{ left, top }}>
      <p className="board-chooser__title">{chooser.title}</p>
      {chooser.choices.length === 0 ? <p className="board-hint">{t("board.nowhere")}</p> : null}
      <ul>
        {chooser.choices.map((choice) => {
          const heading = choice.column.status ? choice.column.zoneId : choice.column.id;
          const showHeading = chooser.choices.some((item) => item.column.id !== choice.column.id) && heading !== group;
          group = heading;
          return (
            <li key={`${choice.column.id}:${choice.status.id}:${choice.outcome ?? ""}`}>
              {showHeading ? <span className="board-chooser__group">{choice.column.name}</span> : null}
              <button data-choice className="board-chooser__item" onClick={() => onChoose(choice)} type="button">
                <span>{choice.status.name}</span>
                {choice.outcome ? <span className="board-chooser__sub">{outcomeLabel(choice.outcome)}</span> : null}
                {choice.status.waiting ? <span className="board-chooser__sub">{waitingLabel}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <Button onClick={onClose} variant="ghost">
        {t("common.cancel")}
      </Button>
    </div>
  );
}

/** «Создать» на доске: тип и название; команда и стрим — из фильтра доски, карточка сразу на доске. */
function CreateOnBoard({
  boardId,
  spaceBoard,
  onDone,
}: {
  boardId: string;
  spaceBoard: boolean;
  onDone(notice: NoticeState): void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const types = useTicketTypes();
  const create = useCreateOnBoard(boardId);
  const [typeId, setTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const spaces = useSpacesForCreate(!spaceBoard);
  const chosenType = typeId || types.data?.items[0]?.id || "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !chosenType) return;
    create.mutate(
      { typeId: chosenType, title: title.trim(), ...(spaceBoard ? {} : { spaceId }) },
      {
        onSuccess: ({ ticket, onBoard }) => {
          setTitle("");
          onDone(
            onBoard
              ? { tone: "success", text: t("board.created", { key: ticket.key }) }
              : { tone: "info", text: t("board.createdOff", { key: ticket.key }), link: `/tickets/${ticket.key}` },
          );
        },
      },
    );
  };
  return (
    <form className="board-create" onSubmit={submit}>
      <Select label={t("board.createType")} onChange={(event) => setTypeId(event.target.value)} value={chosenType}>
        {(types.data?.items ?? []).map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
          </option>
        ))}
      </Select>
      {spaceBoard ? null : (
        <Select
          label={t("board.createSpace")}
          onChange={(event) => setSpaceId(event.target.value)}
          required
          value={spaceId}
        >
          <option value="">—</option>
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </Select>
      )}
      <Input
        autoFocus
        error={create.isError ? errorText(create.error) : undefined}
        label={t("board.createTitle")}
        onChange={(event) => setTitle(event.target.value)}
        value={title}
      />
      <Button loading={create.isPending} type="submit">
        {t("board.createSubmit")}
      </Button>
    </form>
  );
}

function useSpacesForCreate(enabled: boolean) {
  const spaces = useSpaces();
  return enabled ? (spaces.data?.items ?? []) : [];
}
