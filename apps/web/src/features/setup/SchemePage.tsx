import { ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  RESPONSIBLE_ROLES,
  STATUS_CATEGORIES,
  type EntryRequirement,
  type StatusCategory,
  type StatusScheme,
  type TicketField,
  type TicketType,
  type WorkflowStatusInput,
} from "@yourtask/contracts";
import { useFields, useResetScheme, useSaveScheme, useScheme, useSpaces, useTicketType } from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";
import { TypeMark } from "./shared";

type Draft = Omit<WorkflowStatusInput, "category"> & { draftId: string; category: StatusCategory | "" };

const requirementId = (requirement: EntryRequirement) =>
  requirement.kind === "field"
    ? `field:${requirement.fieldKey}`
    : requirement.kind === "people"
      ? `people:${requirement.role}`
      : requirement.kind;

function fromId(id: string): EntryRequirement {
  const [kind, value] = id.split(":");
  if (kind === "field") return { kind: "field", fieldKey: value ?? "" };
  if (kind === "people") return { kind: "people", role: value as "assignees" | "customer" | "tester" };
  return { kind: kind as "description" | "checklist_done" };
}

/** Схема статусов типа (R-2.10, R-5.1; YT-05). `?space=<id>` — своя схема пространства. */
export function SchemePage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const type = useTicketType(id);
  const [params, setParams] = useSearchParams();
  const spaceId = params.get("space") || null;
  const scheme = useScheme(id, spaceId);
  const spaces = useSpaces();
  return (
    <section className="page">
      <PageHeader
        back={`/types/${id}`}
        description={t("scheme.description")}
        title={t("scheme.title", { type: type.data?.name ?? "" })}
      />
      <ReadOnlyNote />
      <div className="scheme-toolbar">
        {type.data ? <TypeMark color={type.data.color} icon={type.data.icon} /> : null}
        <Select
          label={t("scheme.space")}
          onChange={(e) => setParams(e.target.value ? { space: e.target.value } : {})}
          value={spaceId ?? ""}
        >
          <option value="">{t("scheme.default")}</option>
          {(spaces.data?.items ?? []).map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </Select>
      </div>
      {scheme.isPending || type.isPending ? <Loading /> : null}
      {scheme.isError ? <ErrorState error={scheme.error} /> : null}
      {scheme.data && type.data ? (
        <SchemeEditor key={`${scheme.data.spaceId}-${scheme.data.inherited}`} scheme={scheme.data} type={type.data} />
      ) : null}
    </section>
  );
}

function toDrafts(scheme: StatusScheme): Draft[] {
  return scheme.statuses.map((status) => ({ ...status, draftId: status.id }));
}

function SchemeEditor({ scheme, type }: { scheme: StatusScheme; type: TicketType }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const fields = useFields();
  const save = useSaveScheme();
  const reset = useResetScheme();
  const errorText = useErrorText();
  const [strictOrder, setStrictOrder] = useState(scheme.strictOrder);
  const [statuses, setStatuses] = useState(() => toDrafts(scheme));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setStrictOrder(scheme.strictOrder);
    setStatuses(toDrafts(scheme));
  }, [scheme]);

  const typeFields = useMemo(
    () =>
      type.fieldIds
        .map((fieldId) => fields.data?.items.find((field) => field.id === fieldId))
        .filter((field): field is TicketField => Boolean(field)),
    [fields.data, type.fieldIds],
  );
  const requirementOptions = [
    ...typeFields.map((field) => ({ id: `field:${field.key}`, label: field.name })),
    ...(["assignees", "customer", "tester"] as const).map((role) => ({
      id: `people:${role}`,
      label: t(`scheme.req.people.${role}`),
    })),
    { id: "description", label: t("scheme.req.description") },
    { id: "checklist_done", label: t("scheme.req.checklist_done") },
  ];
  const editable = isSuperadmin && (!scheme.inherited || scheme.spaceId === null);
  const patch = (index: number, change: Partial<Draft>) =>
    setStatuses(statuses.map((status, position) => (position === index ? { ...status, ...change } : status)));
  const move = (index: number, delta: number) => {
    const next = [...statuses];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item as Draft);
    setStatuses(next);
  };

  function body() {
    return {
      spaceId: scheme.spaceId,
      strictOrder,
      statuses: statuses.map(({ draftId, ...status }) => ({
        ...status,
        // Пустую категорию отправляем как есть: сервер ответит понятной ошибкой.
        category: (status.category || undefined) as StatusCategory,
        outcomes: status.category === "done" ? status.outcomes : [],
        ...(scheme.inherited ? { id: undefined } : {}),
      })),
    };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({ typeId: type.id, body: body() }, { onSuccess: () => setSaved(true) });
  }

  return (
    <Card className="scheme-editor">
      <Notice
        error={save.isError ? errorText(save.error) : reset.isError ? errorText(reset.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          save.reset();
          reset.reset();
          setSaved(false);
        }}
      />
      {scheme.inherited ? (
        <div className="converter__inherited">
          <p>{t("scheme.inherited")}</p>
          {isSuperadmin ? (
            <Button
              loading={save.isPending}
              onClick={() => save.mutate({ typeId: type.id, body: body() })}
              variant="secondary"
            >
              {t("scheme.makeOwn")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={!editable}>
          <label className="checkbox-inline">
            <input checked={strictOrder} onChange={(e) => setStrictOrder(e.target.checked)} type="checkbox" />
            {t("scheme.strictOrder")}
          </label>
          <p className="ui-field__hint">{t("scheme.strictOrderHint")}</p>
          <ol className="scheme-list">
            {statuses.map((status, index) => (
              <li className={`scheme-status scheme-status--${status.category || "none"}`} key={status.draftId}>
                <div className="scheme-status__head">
                  <span className="scheme-status__index">{index + 1}</span>
                  <Input
                    label={t("scheme.name")}
                    maxLength={60}
                    onChange={(e) => patch(index, { name: e.target.value })}
                    required
                    value={status.name}
                  />
                  <Select
                    label={t("scheme.category")}
                    onChange={(e) => patch(index, { category: e.target.value as StatusCategory })}
                    value={status.category}
                  >
                    <option value="">{t("scheme.category.none")}</option>
                    {STATUS_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {t(`scheme.category.${category}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                  <span className="order-list__actions">
                    <button
                      aria-label={t("types.moveUp", { name: status.name })}
                      className="ui-icon-button"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      type="button"
                    >
                      <ArrowUp aria-hidden="true" size={16} />
                    </button>
                    <button
                      aria-label={t("types.moveDown", { name: status.name })}
                      className="ui-icon-button"
                      disabled={index === statuses.length - 1}
                      onClick={() => move(index, 1)}
                      type="button"
                    >
                      <ArrowDown aria-hidden="true" size={16} />
                    </button>
                    <button
                      aria-label={t("scheme.remove", { name: status.name })}
                      className="ui-icon-button"
                      onClick={() => setStatuses(statuses.filter((_, position) => position !== index))}
                      type="button"
                    >
                      <Trash aria-hidden="true" size={16} />
                    </button>
                  </span>
                </div>
                <div className="scheme-status__body">
                  <label className="checkbox-inline">
                    <input
                      checked={status.waiting}
                      onChange={(e) => patch(index, { waiting: e.target.checked })}
                      type="checkbox"
                    />
                    {t("scheme.waiting")}
                  </label>
                  <label className="checkbox-inline">
                    <input
                      checked={status.freezeRequirements}
                      onChange={(e) => patch(index, { freezeRequirements: e.target.checked })}
                      type="checkbox"
                    />
                    {t("scheme.freeze")}
                  </label>
                  {status.category === "done" ? (
                    <fieldset className="chips" aria-label={`${status.name}: ${t("scheme.outcomes")}`}>
                      <legend className="ui-field__label">{t("scheme.outcomes")}</legend>
                      {type.outcomes.map((outcome) => (
                        <label className="checkbox-inline" key={outcome.key}>
                          <input
                            checked={status.outcomes.includes(outcome.key)}
                            onChange={(e) =>
                              patch(index, {
                                outcomes: e.target.checked
                                  ? [...status.outcomes, outcome.key]
                                  : status.outcomes.filter((key) => key !== outcome.key),
                              })
                            }
                            type="checkbox"
                          />
                          {outcome.label}
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  <fieldset className="chips" aria-label={`${status.name}: ${t("scheme.requirements")}`}>
                    <legend className="ui-field__label">{t("scheme.requirements")}</legend>
                    {requirementOptions.map((option) => {
                      const ids = status.requirements.map(requirementId);
                      return (
                        <label className="checkbox-inline" key={option.id}>
                          <input
                            checked={ids.includes(option.id)}
                            onChange={(e) =>
                              patch(index, {
                                requirements: e.target.checked
                                  ? [...status.requirements, fromId(option.id)]
                                  : status.requirements.filter((item) => requirementId(item) !== option.id),
                              })
                            }
                            type="checkbox"
                          />
                          {option.label}
                        </label>
                      );
                    })}
                  </fieldset>
                  <fieldset className="chips" aria-label={`${status.name}: ${t("scheme.roles")}`}>
                    <legend className="ui-field__label">{t("scheme.roles")}</legend>
                    {RESPONSIBLE_ROLES.map((role) => (
                      <label className="checkbox-inline" key={role}>
                        <input
                          checked={status.responsibleRoles.includes(role)}
                          onChange={(e) =>
                            patch(index, {
                              responsibleRoles: e.target.checked
                                ? [...status.responsibleRoles, role]
                                : status.responsibleRoles.filter((item) => item !== role),
                            })
                          }
                          type="checkbox"
                        />
                        {t(`scheme.role.${role}`)}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <p className="scheme-status__summary">
                  {status.category ? <Badge>{t(`scheme.category.${status.category}` as MessageKey)}</Badge> : null}
                  {status.waiting ? <Badge variant="warning">{t("scheme.badgeWaiting")}</Badge> : null}
                </p>
              </li>
            ))}
          </ol>
          <Button
            onClick={() =>
              setStatuses([
                ...statuses,
                {
                  draftId: crypto.randomUUID(),
                  name: t("scheme.newStatus"),
                  category: "",
                  waiting: false,
                  outcomes: [],
                  requirements: [],
                  responsibleRoles: [],
                  freezeRequirements: false,
                },
              ])
            }
            variant="secondary"
          >
            {t("scheme.addStatus")}
          </Button>
        </fieldset>
        {editable ? (
          <div className="page-actions">
            <Button loading={save.isPending} type="submit">
              {t("common.save")}
            </Button>
            {scheme.spaceId && !scheme.inherited ? (
              <Button
                loading={reset.isPending}
                onClick={() => reset.mutate({ typeId: type.id, spaceId: scheme.spaceId as string })}
                variant="secondary"
              >
                {t("scheme.resetOwn")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
