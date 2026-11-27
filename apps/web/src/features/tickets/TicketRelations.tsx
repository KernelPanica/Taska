import { LinkBreak, LockSimple, Plus, Target, Trash, Warning } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  type Progress,
  type RelatedTicket,
  type Ticket,
  type TitleOnlyTicket,
  type Visibility,
} from "@yourtask/contracts";
import {
  useAddLink,
  useAddParent,
  useAddWebLink,
  useChangeLink,
  useLinkTypes,
  useRemoveLink,
  useRemoveWebLink,
  useRequestDocAccess,
  useWebLinks,
  useGroups,
  usePeople,
  useQuickCreate,
  useRemoveParent,
  useSetVisibility,
  useSpaces,
  useTicketTypes,
} from "../../api/hooks";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";
import { TypeMark } from "../setup/shared";
import { ParentTraces } from "../trash/Trash";

/** Полоса прогресса: дети и пункты чеклиста, общие считаются один раз (R-2.12). Число рядом — не только цвет. */
export function ProgressBar({ progress, label }: { progress: Progress; label?: string }) {
  const { t } = useI18n();
  const whole = Number.isInteger(progress.done) && Number.isInteger(progress.total);
  return (
    <div className="progress">
      <div className="progress__head">
        <span className="ui-field__hint">{label ?? t("ticket.progress")}</span>
        <strong>
          {whole ? t("ticket.progressOf", { done: progress.done, total: progress.total }) : `${progress.percent}%`}
        </strong>
      </div>
      <div
        aria-label={label ?? t("ticket.progress")}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percent}
        className="progress__track"
        role="progressbar"
      >
        <span className="progress__fill" style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

/** «Только заголовок» (R-2.20): название и прогресс, содержимое — только допущенным. */
export function TitleOnlyView({ ticket }: { ticket: TitleOnlyTicket }) {
  const { t } = useI18n();
  const types = useTicketTypes();
  const type = types.data?.items.find((item) => item.id === ticket.typeId);
  return (
    <>
      <header className="ticket-header">
        <p className="ticket-header__meta">
          {type ? <TypeMark color={type.color} icon={type.icon} /> : null}
          <span>{type?.name}</span>
          <span className="ticket-key">{ticket.key}</span>
          <Badge>
            <LockSimple aria-hidden="true" size={12} /> {t("ticket.titleOnlyBadge")}
          </Badge>
        </p>
        <div className="ticket-title">
          <h1>{ticket.title}</h1>
        </div>
      </header>
      {ticket.progress ? <ProgressBar progress={ticket.progress} /> : null}
      <Card className="ticket-section">
        <h2>{t("ticket.titleOnlyTitle")}</h2>
        <p>{t("ticket.titleOnlyText")}</p>
      </Card>
    </>
  );
}

function RelatedRow({
  item,
  onRemove,
  removing,
  removeLabel,
}: {
  item: RelatedTicket;
  onRemove?: (() => void) | undefined;
  removing?: boolean | undefined;
  removeLabel?: string | undefined;
}) {
  const { t } = useI18n();
  const types = useTicketTypes();
  if (!item.available) {
    return (
      <li className="relation relation--unavailable">
        <LockSimple aria-hidden="true" size={14} />
        <span>{t("relations.unavailable")}</span>
      </li>
    );
  }
  const type = types.data?.items.find((entry) => entry.id === item.typeId);
  return (
    <li className="relation">
      <span className="relation__main">
        <Link to={`/tickets/${item.key}`}>{item.key}</Link> <span>{item.title}</span>
      </span>
      <span className="relation__meta">
        {[
          type?.name,
          item.number ? t("flow.here", { number: item.number }) : null,
          item.titleOnly ? t("relations.titleOnly") : item.statusName,
          item.spaceName,
          item.assignees.map((person) => person.name).join(", ") || null,
          item.inChecklist ? t("relations.inChecklist") : null,
          item.progress ? `${item.progress.percent}%` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {onRemove ? (
        <Button aria-label={removeLabel ?? ""} loading={Boolean(removing)} onClick={onRemove} variant="ghost">
          <LinkBreak aria-hidden="true" size={16} />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * «+ ребёнок» и «+ родитель» одной строкой (R-2.17): название и тип, Enter — создан и связан.
 * Пространство по умолчанию — как у исходного; предлагаются только те, где есть право «Создавать».
 */
export function QuickLinkCreate({
  ticket,
  relation,
  onDone,
  siblings = [],
}: {
  ticket: Pick<Ticket, "key" | "spaceId" | "typeId">;
  relation: "child" | "parent";
  onDone?: () => void;
  /** Дети тикета: новый ребёнок может встать перед любым из них — вставка в середину потока (R-2.9). */
  siblings?: { key: string; title: string; number?: string | undefined }[];
}) {
  const { t } = useI18n();
  const types = useTicketTypes();
  const spaces = useSpaces();
  const create = useQuickCreate();
  const errorText = useErrorText();
  const allowed = (spaces.data?.items ?? []).filter((space) => space.rights.includes("create"));
  const defaultType =
    types.data?.items.find((type) => type.key === (relation === "child" ? "task" : "epic"))?.id ?? ticket.typeId;
  const [title, setTitle] = useState("");
  const [typeId, setTypeId] = useState("");
  const [spaceId, setSpaceId] = useState(ticket.spaceId);
  const [beforeKey, setBeforeKey] = useState("");
  const label = relation === "child" ? t("relations.newChild") : t("relations.newParent");
  return (
    <form
      aria-label={label}
      className="quick-link"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!title.trim()) return;
        create.mutate(
          {
            title: title.trim(),
            typeId: typeId || defaultType,
            spaceId,
            ...(relation === "child" ? { parentKey: ticket.key } : { childKey: ticket.key }),
            ...(relation === "child" && beforeKey ? { beforeKey } : {}),
          },
          {
            onSuccess: () => {
              setTitle("");
              onDone?.();
            },
          },
        );
      }}
    >
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <Input
        className="quick-link__title"
        hint={t("relations.quickHint")}
        label={label}
        maxLength={500}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("relations.quickTitle")}
        value={title}
      />
      <Select label={t("tickets.type")} onChange={(e) => setTypeId(e.target.value)} value={typeId || defaultType}>
        {(types.data?.items ?? []).map((type) => (
          <option key={type.id} value={type.id}>
            {type.name}
          </option>
        ))}
      </Select>
      {relation === "child" && siblings.length ? (
        <Select label={t("flow.place")} onChange={(e) => setBeforeKey(e.target.value)} value={beforeKey}>
          <option value="">{t("flow.atEnd")}</option>
          {siblings.map((sibling) => (
            <option key={sibling.key} value={sibling.key}>
              {t("flow.before", {
                what: `${sibling.number ? `${sibling.number} · ` : ""}${sibling.key} ${sibling.title}`,
              })}
            </option>
          ))}
        </Select>
      ) : null}
      <Select label={t("relations.space")} onChange={(e) => setSpaceId(e.target.value)} value={spaceId}>
        {allowed.some((space) => space.id === ticket.spaceId) ? null : (
          <option disabled value={ticket.spaceId}>
            {t("relations.noCreateHere")}
          </option>
        )}
        {allowed.map((space) => (
          <option key={space.id} value={space.id}>
            {space.name}
          </option>
        ))}
      </Select>
      <Button aria-label={t("relations.create")} loading={create.isPending} type="submit" variant="secondary">
        <Plus aria-hidden="true" size={16} /> {t("relations.create")}
      </Button>
    </form>
  );
}

/** Варианты связи для одного списка: родитель и каждый тип со своей стороны («блокирует» / «заблокирован»). */
function useLinkOptions() {
  const { t } = useI18n();
  const types = useLinkTypes();
  const label = (key: string, fallback: string) => {
    const message = `links.type.${key}` as MessageKey;
    const text = t(message);
    return text === message ? fallback : text;
  };
  return (types.data?.items ?? []).flatMap((type) =>
    type.symmetric
      ? [{ value: `${type.id}:out`, label: label(`${type.key}.out`, type.name) }]
      : [
          { value: `${type.id}:out`, label: label(`${type.key}.out`, type.name) },
          { value: `${type.id}:in`, label: label(`${type.key}.in`, type.inverseName) },
        ],
  );
}

/**
 * Блок «Связи» (R-2.8, R-2.13, R-2.17): родители с охватом, дети, связи с обеих сторон, «+ ребёнок», «+ родитель»
 * и одна форма «Добавить связь или родителя». Недоступный связанный тикет — строка без ключа и названия.
 */
export function RelationsCard({ ticket, spaceSlug }: { ticket: Ticket; spaceSlug?: string | undefined }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const addParent = useAddParent(ticket.key);
  const removeParent = useRemoveParent(ticket.key);
  const addLink = useAddLink(ticket.key);
  const changeLink = useChangeLink(ticket.key);
  const removeLink = useRemoveLink(ticket.key);
  const options = useLinkOptions();
  const [targetKey, setTargetKey] = useState("");
  const [kind, setKind] = useState("parent");
  const [adding, setAdding] = useState<"child" | "parent" | null>(null);
  const { parents, children, coverage, links } = ticket.relations;
  const canMove = ticket.permissions.move;
  const canEdit = ticket.permissions.edit;
  const mutations = [addParent, removeParent, addLink, changeLink, removeLink];
  const failed = mutations.find((mutation) => mutation.isError);
  const groups = new Map<string, typeof links>();
  for (const link of links) {
    const key = `${link.typeId}:${link.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  const optionLabel = (value: string, fallback: string) =>
    options.find((option) => option.value === value)?.label ?? fallback;
  return (
    <Card className="ticket-section relations">
      <div className="ticket-section__head">
        <h2>{t("relations.title")}</h2>
        {coverage ? (
          <Badge variant="info">
            <Target aria-hidden="true" size={12} /> {t("relations.coverage", { count: coverage })}
          </Badge>
        ) : null}
      </div>
      <Notice
        error={failed ? errorText(failed.error) : null}
        onDismiss={() => mutations.forEach((mutation) => mutation.reset())}
      />
      <h3 className="ui-eyebrow">{t("relations.parents", { count: parents.length })}</h3>
      {parents.length ? (
        <ul className="relation-list">
          {parents.map((item, index) => (
            <RelatedRow
              item={item}
              key={item.available ? item.key : `hidden-${index}`}
              onRemove={canMove && item.available ? () => removeParent.mutate(item.key) : undefined}
              removeLabel={item.available ? t("relations.removeParent", { key: item.key }) : undefined}
              removing={removeParent.isPending && item.available && removeParent.variables === item.key}
            />
          ))}
        </ul>
      ) : (
        <p className="ui-field__hint">{t("relations.noParents")}</p>
      )}
      <h3 className="ui-eyebrow">{t("relations.children", { count: children.length })}</h3>
      {children.length ? (
        <ul className="relation-list">
          {children.map((item, index) => (
            <RelatedRow item={item} key={item.available ? item.key : `hidden-${index}`} />
          ))}
        </ul>
      ) : (
        <p className="ui-field__hint">{t("relations.noChildren")}</p>
      )}
      {[...groups].map(([group, items]) => {
        const first = items[0] as (typeof links)[number];
        return (
          <section aria-label={optionLabel(group, first.label)} key={group}>
            <h3 className="ui-eyebrow">
              {optionLabel(group, first.label)} · {items.length}
              {first.typeKey === "causes" && first.direction === "out" ? ` · ${t("links.causesHint")}` : ""}
            </h3>
            <ul className="relation-list">
              {items.map((link) => (
                <li className="relation-link" key={link.id}>
                  <ul className="relation-list relation-list--inline">
                    <RelatedRow
                      item={link.ticket}
                      onRemove={canEdit ? () => removeLink.mutate(link.id) : undefined}
                      removeLabel={t("links.remove")}
                      removing={removeLink.isPending && removeLink.variables === link.id}
                    />
                  </ul>
                  {canEdit && link.ticket.available ? (
                    <select
                      aria-label={t("links.changeType")}
                      className="ui-select relation-link__type"
                      onChange={(event) => {
                        const [typeId, direction] = event.target.value.split(":") as [string, "out" | "in"];
                        changeLink.mutate({ id: link.id, typeId, direction });
                      }}
                      value={`${link.typeId}:${link.direction}`}
                    >
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <ParentTraces spaceSlug={spaceSlug} ticket={ticket} />
      <div className="page-actions">
        <Button onClick={() => setAdding(adding === "child" ? null : "child")} variant="secondary">
          <Plus aria-hidden="true" size={16} /> {t("relations.newChild")}
        </Button>
        {canMove ? (
          <Button onClick={() => setAdding(adding === "parent" ? null : "parent")} variant="secondary">
            <Plus aria-hidden="true" size={16} /> {t("relations.newParent")}
          </Button>
        ) : null}
      </div>
      {adding ? (
        <QuickLinkCreate
          relation={adding}
          siblings={children.flatMap((item) =>
            item.available ? [{ key: item.key, title: item.title, number: item.number }] : [],
          )}
          ticket={ticket}
        />
      ) : null}
      {canEdit || canMove ? (
        <form
          aria-label={t("links.addTitle")}
          className="ticket-inline-form ticket-inline-form--relation"
          onSubmit={(event) => {
            event.preventDefault();
            const key = targetKey.trim().toUpperCase();
            if (!key) return;
            const done = { onSuccess: () => setTargetKey("") };
            if (kind === "parent") addParent.mutate(key, done);
            else {
              const [typeId, direction] = kind.split(":") as [string, "out" | "in"];
              addLink.mutate({ typeId, targetKey: key, direction }, done);
            }
          }}
        >
          <Select label={t("links.kind")} onChange={(e) => setKind(e.target.value)} value={kind}>
            {canMove ? <option value="parent">{t("links.parent")}</option> : null}
            {canEdit
              ? options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              : null}
          </Select>
          <Input
            hint={t("relations.parentByKeyHint")}
            label={t("links.target")}
            maxLength={40}
            onChange={(e) => setTargetKey(e.target.value)}
            value={targetKey}
          />
          <Button loading={addParent.isPending || addLink.isPending} type="submit" variant="secondary">
            {t("relations.link")}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Блок «Ссылки» (R-2.24, R-2.40): любой адрес с заголовком страницы; документ YourWiki — живое название,
 * доступ этого человека, состояние, «Открыть оригинал» при доступе в источнике, «Запросить» без доступа.
 */
export function WebLinksCard({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const links = useWebLinks(ticket.key);
  const add = useAddWebLink(ticket.key);
  const remove = useRemoveWebLink(ticket.key);
  const request = useRequestDocAccess(ticket.key);
  const [url, setUrl] = useState("");
  const failed = [add, remove, request].find((mutation) => mutation.isError);
  const items = links.data?.items ?? [];
  return (
    <Card className="ticket-section">
      <h2>{t("weblinks.title")}</h2>
      <Notice
        error={failed ? errorText(failed.error) : null}
        onDismiss={() => [add, remove, request].forEach((m) => m.reset())}
      />
      {items.length ? (
        <ul className="relation-list">
          {items.map((link) => {
            const doc = link.document;
            const title = link.kind === "web" ? (link.title ?? link.url) : (link.title ?? t("weblinks.wikiDocument"));
            const href = link.kind === "web" ? link.url : (doc?.wikiUrl ?? null);
            return (
              <li className="relation weblink" key={link.id}>
                <span className="relation__main">
                  {href ? (
                    <a href={href} rel="noopener noreferrer nofollow" target="_blank">
                      {title}
                    </a>
                  ) : (
                    <span>{title}</span>
                  )}{" "}
                  <span className="relation__meta">
                    ·{" "}
                    {link.kind === "web"
                      ? t("weblinks.external")
                      : doc?.source && doc.source.type !== "local"
                        ? `YourWiki · ${doc.source.name}`
                        : "YourWiki"}
                  </span>
                </span>
                {link.kind === "yourwiki" ? (
                  <span className="weblink__state">
                    {link.unavailable ? (
                      <Badge variant="warning">{t(`weblinks.unavailable.${link.unavailable}` as MessageKey)}</Badge>
                    ) : doc?.state === "trashed" ? (
                      <Badge variant="warning">{t("weblinks.trashed")}</Badge>
                    ) : doc?.state === "deleted" ? (
                      <Badge variant="danger">{t("weblinks.deleted")}</Badge>
                    ) : doc?.state === "unavailable" ? (
                      <Badge variant="danger">
                        <LockSimple aria-hidden="true" size={12} /> {t("weblinks.noAccess")}
                      </Badge>
                    ) : doc ? (
                      <Badge variant="success">{t("weblinks.hasAccess")}</Badge>
                    ) : null}
                    {doc?.originalUrl ? (
                      <a
                        className="ui-button ui-button--ghost"
                        href={doc.originalUrl}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {t("weblinks.openOriginal")}
                      </a>
                    ) : null}
                    {doc?.state === "unavailable" && doc.canRequestAccess ? (
                      doc.requested ? (
                        <span className="ui-field__hint">{t("weblinks.requested")}</span>
                      ) : (
                        <Button
                          loading={request.isPending && request.variables === link.id}
                          onClick={() => request.mutate(link.id)}
                          variant="secondary"
                        >
                          {t("weblinks.request")}
                        </Button>
                      )
                    ) : null}
                  </span>
                ) : null}
                {link.warning ? (
                  <p className="weblink__warning" role="note">
                    <Warning aria-hidden="true" size={14} /> {t(`weblinks.warning.${link.warning}` as MessageKey)}
                  </p>
                ) : null}
                {ticket.permissions.edit ? (
                  <Button
                    aria-label={t("weblinks.remove", { title })}
                    loading={remove.isPending && remove.variables === link.id}
                    onClick={() => remove.mutate(link.id)}
                    variant="ghost"
                  >
                    <Trash aria-hidden="true" size={16} />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : links.isPending ? null : (
        <p className="ui-field__hint">{t("weblinks.empty")}</p>
      )}
      {ticket.permissions.edit ? (
        <form
          className="ticket-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) add.mutate({ url: url.trim() }, { onSuccess: () => setUrl("") });
          }}
        >
          <Input
            hint={t("weblinks.hint")}
            label={t("weblinks.add")}
            maxLength={2000}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            value={url}
          />
          <Button loading={add.isPending} type="submit" variant="secondary">
            {t("weblinks.addButton")}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

const VISIBILITY_OPTIONS: (Visibility | "inherit")[] = ["inherit", "open", "title_only", "hidden"];

/** Видимость (R-2.20): своя или унаследованная; менять — с правом «менять видимость». */
export function VisibilityCard({ ticket }: { ticket: Ticket }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const people = usePeople();
  const teams = useGroups("feature-teams");
  const guilds = useGroups("guilds");
  const save = useSetVisibility(ticket.key);
  const { own, effective, inheritedFrom, allow } = ticket.visibility;
  const [value, setValue] = useState<Visibility | "inherit">(own ?? "inherit");
  const [chosen, setChosen] = useState<string[]>(allow.map((entry) => `${entry.kind}:${entry.id}`));
  const [saved, setSaved] = useState(false);
  const status = t(`ticket.visibility.${effective}` as MessageKey);
  const options = [
    ...(people.data?.items ?? []).map((item) => ({ id: `person:${item.id}`, label: item.name })),
    ...(teams.data?.items ?? []).map((item) => ({
      id: `team:${item.id}`,
      label: `${t("access.subject.team")}: ${item.name}`,
    })),
    ...(guilds.data?.items ?? []).map((item) => ({
      id: `guild:${item.id}`,
      label: `${t("access.subject.guild")}: ${item.name}`,
    })),
  ];
  return (
    <Card className="ticket-section">
      <div className="ticket-section__head">
        <h2>{t("ticket.visibility")}</h2>
        <Badge variant={effective === "open" ? "neutral" : "warning"}>
          {effective !== "open" ? <LockSimple aria-hidden="true" size={12} /> : null} {status}
        </Badge>
      </div>
      {!own && inheritedFrom ? (
        <p className="ui-field__hint">{t("ticket.visibility.inheritedFrom", { key: inheritedFrom })}</p>
      ) : null}
      {!ticket.permissions.visibility ? (
        allow.length ? (
          <p className="ui-field__hint">
            {t("ticket.visibility.allow")}: {allow.map((entry) => entry.name).join(", ")}
          </p>
        ) : null
      ) : (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate(
              {
                version: ticket.version,
                visibility: value === "inherit" ? null : value,
                allow: chosen.map((entry) => {
                  const [kind, id] = entry.split(":") as ["person" | "team" | "guild", string];
                  return { kind, id };
                }),
              },
              { onSuccess: () => setSaved(true) },
            );
          }}
        >
          <Notice
            error={save.isError ? errorText(save.error) : null}
            message={saved ? t("common.saved") : null}
            onDismiss={() => {
              save.reset();
              setSaved(false);
            }}
          />
          <Select
            hint={t("ticket.visibility.hint")}
            label={t("ticket.visibility.mode")}
            onChange={(e) => setValue(e.target.value as Visibility | "inherit")}
            value={value}
          >
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t(`ticket.visibility.${option}` as MessageKey)}
              </option>
            ))}
          </Select>
          {value === "title_only" || value === "hidden" ? (
            <CheckboxPicker
              label={t("ticket.visibility.allow")}
              onChange={setChosen}
              options={options}
              value={chosen}
            />
          ) : null}
          <Button loading={save.isPending} type="submit" variant="secondary">
            {t("ticket.visibility.save")}
          </Button>
        </form>
      )}
    </Card>
  );
}
