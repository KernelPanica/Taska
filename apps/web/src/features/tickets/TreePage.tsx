import {
  CaretDown,
  CaretRight,
  DotsSixVertical,
  LockSimple,
  Plus,
  Target,
  Trash as TrashIcon,
} from "@phosphor-icons/react";
import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { TicketTree, TreeNode } from "@yourtask/contracts";
import { useMoveTickets, useSpace, useTicketTypes, useTree, useWrapTickets } from "../../api/hooks";
import { Badge, Button, Input, Select } from "../../components/ui";
import { useTrashFlow } from "../trash/Trash";
import { ErrorState, Loading } from "../../app/states";
import { useI18n } from "../../i18n";
import { Notice, PageHeader, useErrorText } from "../directory/shared";
import { TypeMark } from "../setup/shared";
import { QuickLinkCreate } from "./TicketRelations";

type Drop = { key: string; parentKey: string | null; where: "before" | "inside" } | null;

/**
 * «Дерево» (R-2.8; YT-09): раскрытие и сворачивание, перетаскивание для порядка и смены родителя,
 * множественный выбор. Общий тикет показан под каждым родителем, со второго раза — с пометкой «тот же тикет».
 * Недоступный узел — строка «Связанный тикет недоступен» (R-2.17).
 */
export function TreePage() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const root = params.get("root") ?? undefined;
  const { t } = useI18n();
  const space = useSpace(slug);
  const tree = useTree(root ? { rootKey: root } : { spaceId: space.data?.id ?? "" });
  return (
    <section className="page">
      <PageHeader
        back={root ? `/tickets/${root}` : `/spaces/${slug}`}
        description={t("tree.lead")}
        title={root ? t("tree.branchOf", { key: root }) : t("tree.title", { space: space.data?.name ?? "" })}
      />
      {tree.isPending ? <Loading /> : null}
      {tree.isError ? <ErrorState error={tree.error} /> : null}
      {tree.data ? <TreeView tree={tree.data} /> : null}
    </section>
  );
}

function TreeView({ tree }: { tree: TicketTree }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const move = useMoveTickets();
  const wrap = useWrapTickets();
  const types = useTicketTypes();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<string, string | null>>(new Map());
  const [drag, setDrag] = useState<{ key: string; parentKey: string | null } | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [wrapTitle, setWrapTitle] = useState("");
  const [wrapType, setWrapType] = useState("");
  const [target, setTarget] = useState("");

  /** Первое появление каждого общего тикета при обходе — остальные помечаются «тот же тикет». */
  const firstSeen = useMemo(() => {
    const seen = new Map<string, string>();
    const walk = (id: string, path: string) => {
      if (!seen.has(id)) seen.set(id, path);
      for (const child of tree.children[id] ?? []) walk(child, `${path}/${child}`);
    };
    for (const rootId of tree.roots) walk(rootId, rootId);
    return seen;
  }, [tree]);

  const selectedKeys = [...selected.keys()];
  const trashFlow = useTrashFlow();
  const parents = new Set(selected.values());
  const commonParent = parents.size === 1 ? ([...parents][0] ?? null) : null;
  const error = move.error ?? wrap.error;

  const onDrop = (event: DragEvent, node: TreeNode, parentKey: string | null) => {
    event.preventDefault();
    const where = drop?.where ?? "inside";
    setDrop(null);
    if (!drag || !node.key || drag.key === node.key) return;
    move.mutate(
      where === "inside"
        ? { keys: [drag.key], fromParentKey: drag.parentKey, toParentKey: node.key }
        : { keys: [drag.key], fromParentKey: drag.parentKey, toParentKey: parentKey, beforeKey: node.key },
    );
    setDrag(null);
  };

  const render = (
    id: string,
    parentKey: string | null,
    path: string,
    depth: number,
    parentId: string | null = null,
  ) => {
    const node = tree.nodes[id];
    if (!node) return null;
    // Номер на этом пути: под каким родителем строка стоит — тот номер и показываем (R-2.9).
    const number =
      node.numbers?.find((entry) => entry.parentId === parentId)?.number ??
      (parentId ? undefined : node.numbers?.[0]?.number);
    const kids = tree.children[id] ?? [];
    const open = !collapsed.has(path);
    const repeat = firstSeen.get(id) !== path;
    const type = types.data?.items.find((item) => item.id === node.typeId);
    const isDrop = drop && node.key && drop.key === node.key && drop.parentKey === parentKey;
    return (
      <li key={path}>
        <div
          className={`tree-row ${isDrop ? `tree-row--drop-${drop.where}` : ""} ${node.available ? "" : "tree-row--hidden"}`}
          draggable={Boolean(node.key) && !node.titleOnly}
          onDragOver={(event) => {
            if (!drag || !node.key || node.titleOnly) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const where = event.clientY - box.top < box.height / 3 ? "before" : "inside";
            if (!isDrop || drop?.where !== where) setDrop({ key: node.key, parentKey, where });
          }}
          onDragLeave={() => setDrop(null)}
          onDragStart={(event) => {
            if (!node.key) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", node.key);
            setDrag({ key: node.key, parentKey });
          }}
          onDragEnd={() => {
            setDrag(null);
            setDrop(null);
          }}
          onDrop={(event) => onDrop(event, node, parentKey)}
          style={{ paddingInlineStart: `calc(${depth} * var(--space-5))` }}
        >
          {kids.length ? (
            <button
              aria-expanded={open}
              aria-label={
                open ? t("tree.collapse", { key: node.key ?? "" }) : t("tree.expand", { key: node.key ?? "" })
              }
              className="ui-icon-button"
              onClick={() => {
                const next = new Set(collapsed);
                if (open) next.add(path);
                else next.delete(path);
                setCollapsed(next);
              }}
              type="button"
            >
              {open ? <CaretDown aria-hidden="true" size={14} /> : <CaretRight aria-hidden="true" size={14} />}
            </button>
          ) : (
            <span className="tree-row__spacer" />
          )}
          {node.available && node.key ? (
            <>
              {!node.titleOnly ? (
                <input
                  aria-label={t("tree.select", { key: node.key })}
                  checked={selected.has(node.key)}
                  onChange={(event) => {
                    const next = new Map(selected);
                    if (event.target.checked) next.set(node.key as string, parentKey);
                    else next.delete(node.key as string);
                    setSelected(next);
                  }}
                  type="checkbox"
                />
              ) : (
                <span className="tree-row__spacer" />
              )}
              <DotsSixVertical aria-hidden="true" className="tree-row__grip" size={14} />
              {number ? (
                <span className="flow-number" title={t("flow.hint")}>
                  {number}
                </span>
              ) : null}
              {type ? <TypeMark color={type.color} icon={type.icon} /> : null}
              <Link to={`/tickets/${node.key}`}>{node.key}</Link>
              <span className="tree-row__title">{node.title}</span>
              {node.titleOnly ? (
                <Badge>
                  <LockSimple aria-hidden="true" size={12} /> {t("relations.titleOnly")}
                </Badge>
              ) : (
                <span className="ui-field__hint">{node.statusName}</span>
              )}
              {node.progress ? <span className="ui-field__hint">{node.progress.percent}%</span> : null}
              {node.coverage ? (
                <span className="ui-field__hint" title={t("tickets.coverage")}>
                  <Target aria-hidden="true" size={12} /> {node.coverage}
                </span>
              ) : null}
              {repeat ? <Badge variant="info">{t("tree.sameTicket")}</Badge> : null}
              {!node.titleOnly ? (
                <Button
                  aria-label={t("tree.addChild", { key: node.key })}
                  className="tree-row__add"
                  onClick={() => setAdding(adding === path ? null : path)}
                  variant="ghost"
                >
                  <Plus aria-hidden="true" size={14} />
                </Button>
              ) : null}
            </>
          ) : (
            <span className="tree-row__title">
              <LockSimple aria-hidden="true" size={14} /> {t("relations.unavailable")}
            </span>
          )}
        </div>
        {adding === path && node.key && node.typeId && node.spaceId ? (
          <div style={{ paddingInlineStart: `calc(${depth + 1} * var(--space-5))` }}>
            <QuickLinkCreate
              onDone={() => setAdding(null)}
              relation="child"
              ticket={{ key: node.key, spaceId: node.spaceId, typeId: node.typeId }}
            />
          </div>
        ) : null}
        {open && kids.length && !repeat ? (
          <ul className="tree-list">
            {kids.map((child) => render(child, node.key ?? null, `${path}/${child}`, depth + 1, id))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="form-stack">
      <p className="ui-field__hint">{t("tree.dragHint")}</p>
      <Notice
        error={error ? errorText(error) : trashFlow.error ? errorText(trashFlow.error) : null}
        onDismiss={() => {
          move.reset();
          wrap.reset();
          trashFlow.reset();
        }}
      />
      {trashFlow.dialog}
      {selectedKeys.length ? (
        <div className="tree-toolbar" role="region" aria-label={t("tree.selection")}>
          <strong>{t("tree.selected", { count: selectedKeys.length })}</strong>
          <form
            className="inline-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (!wrapTitle.trim()) return;
              wrap.mutate(
                {
                  keys: selectedKeys,
                  fromParentKey: commonParent,
                  title: wrapTitle.trim(),
                  typeId: wrapType || (types.data?.items.find((type) => type.key === "epic")?.id ?? ""),
                },
                {
                  onSuccess: () => {
                    setWrapTitle("");
                    setSelected(new Map());
                  },
                },
              );
            }}
          >
            <Input
              label={t("tree.wrap")}
              maxLength={500}
              onChange={(e) => setWrapTitle(e.target.value)}
              placeholder={t("relations.quickTitle")}
              value={wrapTitle}
            />
            <Select
              label={t("tickets.type")}
              onChange={(e) => setWrapType(e.target.value)}
              value={wrapType || (types.data?.items.find((type) => type.key === "epic")?.id ?? "")}
            >
              {(types.data?.items ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </Select>
            <Button loading={wrap.isPending} type="submit" variant="secondary">
              {t("tree.wrapButton")}
            </Button>
          </form>
          <form
            className="inline-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              move.mutate(
                {
                  keys: selectedKeys,
                  fromParentKey: commonParent,
                  toParentKey: target.trim() ? target.trim().toUpperCase() : null,
                },
                {
                  onSuccess: () => {
                    setTarget("");
                    setSelected(new Map());
                  },
                },
              );
            }}
          >
            <Input
              hint={t("tree.moveHint")}
              label={t("tree.moveTo")}
              maxLength={40}
              onChange={(e) => setTarget(e.target.value)}
              value={target}
            />
            <Button loading={move.isPending} type="submit" variant="secondary">
              {t("tree.moveButton")}
            </Button>
          </form>
          <Button
            loading={trashFlow.busy}
            onClick={() => trashFlow.start(selectedKeys, () => setSelected(new Map()))}
            variant="danger"
          >
            <TrashIcon aria-hidden="true" size={16} /> {t("trash.toTrash")}
          </Button>
          <Button onClick={() => setSelected(new Map())} variant="ghost">
            {t("tree.clear")}
          </Button>
        </div>
      ) : null}
      {tree.roots.length ? (
        <ul aria-label={t("tree.label")} className="tree-list tree-list--root">
          {tree.roots.map((id) => render(id, null, id, 0))}
        </ul>
      ) : (
        <p className="ui-field__hint">{t("tree.empty")}</p>
      )}
    </div>
  );
}
