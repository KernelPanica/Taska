import { LockSimple, Prohibit, Target, TreeStructure, Tray } from "@phosphor-icons/react";
import { useState, type FormEvent, type MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Space, TicketSummary, TicketType } from "@yourtask/contracts";
import { useCreateTicket, useScheme, useTicketTypes, useTickets } from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n } from "../../i18n";
import { Notice, useErrorText } from "../directory/shared";
import { TypeMark } from "../setup/shared";

/** Тикеты пространства (YT-06): быстрое создание одной строкой, создание по шаблону, список. */
export function TicketsPanel({ space }: { space: Space }) {
  const { t } = useI18n();
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<"number" | "flow" | "coverage">("number");
  // Поиск из адреса: ссылка «parentTrace(AOS-199)» со следа родителя открывает список бывших детей.
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const tickets = useTickets(space.id, archived ? "only" : "exclude", sort, query);
  const types = useTicketTypes();
  const typeById = new Map((types.data?.items ?? []).map((type) => [type.id, type]));

  return (
    <section aria-labelledby="tickets-title" className="tickets-panel">
      <div className="tickets-panel__head">
        <h2 id="tickets-title">{t("tickets.title")}</h2>
        <Link className="nav-link" to={`/spaces/${space.slug}/tree`}>
          <TreeStructure aria-hidden="true" size={16} /> {t("tree.open")}
        </Link>
        <label className="tickets-panel__sort">
          <span className="ui-field__hint">{t("tickets.sort")}</span>
          <select
            className="ui-select"
            onChange={(e) => setSort(e.target.value as "number" | "flow" | "coverage")}
            value={sort}
          >
            <option value="number">{t("tickets.sortNewest")}</option>
            <option value="flow">{t("tickets.sortFlow")}</option>
            <option value="coverage">{t("tickets.sortCoverage")}</option>
          </select>
        </label>
        <label className="checkbox-inline">
          <input checked={archived} onChange={(e) => setArchived(e.target.checked)} type="checkbox" />
          {t("tickets.showArchived")}
        </label>
      </div>
      <form
        className="tickets-panel__search"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get("q") ?? "").trim();
          setParams(value ? { q: value } : {}, { replace: true });
        }}
        role="search"
      >
        <Input defaultValue={query} hint={t("tickets.searchHint")} key={query} label={t("tickets.search")} name="q" />
      </form>
      {space.rights.includes("create") ? <QuickCreate space={space} types={types.data?.items ?? []} /> : null}
      {tickets.isPending ? <Loading /> : null}
      {tickets.isError ? <ErrorState error={tickets.error} onRetry={() => void tickets.refetch()} /> : null}
      {tickets.data?.items.length === 0 ? (
        <Card className="empty-state">
          <Tray aria-hidden="true" size={32} />
          <p>{t("tickets.empty")}</p>
        </Card>
      ) : null}
      {tickets.data?.items.length ? (
        <ul className="ticket-list">
          {tickets.data.items.map((ticket) => (
            <TicketCard key={ticket.id} space={space} ticket={ticket} type={typeById.get(ticket.typeId)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const INTERACTIVE = "a, button, input, select, textarea, label";

/** Карточка в списке открывается кликом по любой свободной части (R-3.3); с клавиатуры — по ссылке в названии. */
function TicketCard({ ticket, type, space }: { ticket: TicketSummary; type: TicketType | undefined; space: Space }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const scheme = useScheme(ticket.typeId, space.id);
  const status = scheme.data?.statuses.find((item) => item.id === ticket.statusId);
  const open = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
    navigate(`/tickets/${ticket.key}`);
  };
  return (
    <li>
      <article className="ui-card ticket-card" onClick={open}>
        <div className="ticket-card__top">
          {type ? <TypeMark color={type.color} icon={type.icon} size={16} /> : null}
          <span className="ticket-key">{ticket.key}</span>
          {ticket.numbers.length ? (
            <span className="flow-number" title={t("flow.hint")}>
              {ticket.numbers.join(" · ")}
            </span>
          ) : null}
          {status ? (
            <Badge
              variant={status.category === "done" ? "success" : status.category === "in_progress" ? "info" : "neutral"}
            >
              {status.name}
            </Badge>
          ) : null}
          {ticket.blocked ? (
            <Badge variant="danger">
              <Prohibit aria-hidden="true" size={12} /> {t("tickets.blockedBadge")}
            </Badge>
          ) : null}
          {ticket.archived ? <Badge variant="warning">{t("tickets.archivedBadge")}</Badge> : null}
          {ticket.titleOnly ? (
            <Badge>
              <LockSimple aria-hidden="true" size={12} /> {t("relations.titleOnly")}
            </Badge>
          ) : null}
          {ticket.coverage ? (
            <Badge variant="info" title={t("tickets.coverage")}>
              <Target aria-hidden="true" size={12} /> {t("relations.coverage", { count: ticket.coverage })}
            </Badge>
          ) : null}
          {ticket.progress ? <span className="ui-field__hint">{ticket.progress.percent}%</span> : null}
        </div>
        <Link className="ticket-card__title" to={`/tickets/${ticket.key}`}>
          {ticket.title}
        </Link>
        {!ticket.titleOnly ? (
          <span className="data-table__sub">
            {ticket.assignees.map((person) => person.name).join(", ") || t("tickets.unassigned")}
          </span>
        ) : null}
      </article>
    </li>
  );
}

function QuickCreate({ space, types }: { space: Space; types: TicketType[] }) {
  const { t } = useI18n();
  const create = useCreateTicket();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [title, setTitle] = useState("");
  const [typeId, setTypeId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const type = types.find((item) => item.id === typeId) ?? types.find((item) => item.key === "task") ?? types[0];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !type) return;
    create.mutate(
      { spaceId: space.id, typeId: type.id, title: title.trim(), ...(templateId ? { templateId } : {}) },
      {
        onSuccess: (ticket) => {
          setTitle("");
          navigate(`/tickets/${ticket.key}`);
        },
      },
    );
  }

  return (
    <>
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <form className="inline-form ticket-create" onSubmit={submit}>
        <Input
          label={t("tickets.quickTitle")}
          maxLength={500}
          onChange={(e) => setTitle(e.target.value)}
          required
          value={title}
        />
        <Select
          label={t("tickets.type")}
          onChange={(e) => {
            setTypeId(e.target.value);
            setTemplateId("");
          }}
          value={type?.id ?? ""}
        >
          {types.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select label={t("tickets.template")} onChange={(e) => setTemplateId(e.target.value)} value={templateId}>
          <option value="">{t("tickets.noTemplate")}</option>
          {(type?.templates ?? []).map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
        <Button loading={create.isPending} type="submit">
          {t("tickets.create")}
        </Button>
      </form>
    </>
  );
}
