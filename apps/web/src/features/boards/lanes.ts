import type { BoardCard, BoardFilter, BoardLanes } from "@yourtask/contracts";

export interface Lane {
  id: string;
  title: string;
  /** Ключ родителя для дорожки по родителю. */
  key: string | null;
  /** Дорожка «Без …»: всегда в конце. */
  rest: boolean;
  /** Дорожка-фильтр TQL («Срочно»): всегда сверху. */
  pinned: string | null;
  cards: { card: BoardCard; repeat: boolean }[];
}

export interface LaneLabels {
  noParent: string;
  noTeam: string;
  noStream: string;
  noAssignee: string;
  noTags: string;
  /** «Без …» для своего измерения: подставляется его название. */
  noField(name: string): string;
  hiddenParent: string;
  /** Остальные карточки, когда дорожки только по фильтрам. */
  others: string;
}

/** Значения карточки в разрезе: id и подпись; родитель — ещё и ключ. */
export function valuesOf(
  card: BoardCard,
  mode: BoardLanes | string,
): { id: string; title: string; key: string | null }[] {
  if (mode === "parent") return card.parents.map((p) => ({ id: p.id, title: p.title ?? "", key: p.key }));
  if (mode === "team") return card.team ? [{ id: card.team.id, title: card.team.name, key: null }] : [];
  if (mode === "stream") return card.streams.map((s) => ({ id: s.id, title: s.name, key: null }));
  if (mode === "assignee") return card.assignees.map((p) => ({ id: p.id, title: p.name, key: null }));
  if (mode === "type") return [{ id: card.typeId, title: card.typeId, key: null }];
  if (mode === "tags") return card.tags.map((tag) => ({ id: tag, title: tag, key: null }));
  if (mode.startsWith("field:")) {
    return (card.dims[mode.slice(6)] ?? []).map((value) => ({ id: value.id, title: value.name, key: null }));
  }
  return [];
}

/**
 * Дорожки доски (R-2.18, R-2.14): по родителю, фичекоманде, стриму, исполнителю, тегам или любому измерению;
 * без значения — «Без …» в конце. Дорожки-фильтры TQL («Срочно»: priority = Urgent) — всегда сверху, подходящая
 * карточка уходит в первую из них. Карточка с несколькими значениями стоит в каждой дорожке; вторая и далее
 * помечены «тот же тикет», в счётчиках и WIP она считается один раз.
 */
export function lanesFor(
  cards: readonly BoardCard[],
  mode: BoardLanes,
  labels: LaneLabels,
  overlay: { filters: BoardFilter[]; hits: Record<string, string[]> } = { filters: [], hits: {} },
  fieldName: (key: string) => string = (key) => key,
): Lane[] {
  const pinned: Lane[] = overlay.filters.map((filter) => ({
    id: `tql:${filter.id}`,
    title: filter.name,
    key: null,
    rest: false,
    pinned: filter.query,
    cards: [],
  }));
  const hitSets = overlay.filters.map((filter) => new Set(overlay.hits[filter.id] ?? []));
  const rest: Lane = {
    id: "__rest",
    title:
      mode === "none"
        ? labels.others
        : mode === "parent"
          ? labels.noParent
          : mode === "team"
            ? labels.noTeam
            : mode === "stream"
              ? labels.noStream
              : mode === "assignee"
                ? labels.noAssignee
                : mode === "tags"
                  ? labels.noTags
                  : labels.noField(fieldName(mode.slice(6))),
    key: null,
    rest: true,
    pinned: null,
    cards: [],
  };
  const lanes = new Map<string, Lane>();
  for (const card of cards) {
    const at = hitSets.findIndex((set) => set.has(card.id));
    if (at >= 0) {
      (pinned[at] as Lane).cards.push({ card, repeat: false });
      continue;
    }
    const values = mode === "none" ? [] : valuesOf(card, mode);
    if (!values.length) rest.cards.push({ card, repeat: false });
    for (const value of values) {
      let lane = lanes.get(value.id);
      if (!lane) {
        lane = {
          id: value.id,
          title: value.title || labels.hiddenParent,
          key: value.key,
          rest: false,
          pinned: null,
          cards: [],
        };
        lanes.set(value.id, lane);
      }
      lane.cards.push({ card, repeat: false });
    }
  }
  const ordered = [...lanes.values()].sort((a, b) =>
    a.key && b.key
      ? Number(a.key.replace(/\D+/g, "")) - Number(b.key.replace(/\D+/g, ""))
      : a.title.localeCompare(b.title, "ru"),
  );
  // Без дорожек и без фильтров — одна дорожка без заголовка.
  if (mode === "none" && !overlay.filters.length) {
    return [{ ...rest, id: "all", title: "", rest: false }];
  }
  const result = [...pinned.filter((lane) => lane.cards.length), ...ordered];
  if (rest.cards.length) result.push(rest);
  // «Тот же тикет»: второе и следующие появления по порядку дорожек.
  const seen = new Set<string>();
  for (const lane of result) {
    for (const entry of lane.cards) {
      if (seen.has(entry.card.id)) entry.repeat = true;
      seen.add(entry.card.id);
    }
  }
  return result;
}
