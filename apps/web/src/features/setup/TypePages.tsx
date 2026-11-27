import { ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  PROGRESS_SOURCES,
  TYPE_ICONS,
  type ProgressSource,
  type RollupSettings,
  type TicketType,
  type TypeIcon,
} from "@yourtask/contracts";
import {
  useCreateTemplate,
  useCreateTicketType,
  useDeleteTicketType,
  useFields,
  useTicketType,
  useTicketTypes,
  useUpdateTicketType,
} from "../../api/hooks";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, QuickCreate, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";
import { lines, Textarea, TypeMark } from "./shared";

const NEW_TYPE_COLOR = "#0C5CAB";

/** Типы тикетов (R-2.7, YT-04): список и создание. */
export function TypesPage() {
  const { t } = useI18n();
  const types = useTicketTypes();
  const create = useCreateTicketType();
  const navigate = useNavigate();
  const errorText = useErrorText();
  return (
    <section className="page">
      <PageHeader description={t("types.description")} title={t("types.title")} />
      <ReadOnlyNote />
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <QuickCreate
        label={t("common.name")}
        onCreate={(name, reset) =>
          create.mutate(
            { name, color: NEW_TYPE_COLOR, icon: "flag" },
            {
              onSuccess: (type) => {
                reset();
                navigate(`/types/${type.id}`);
              },
            },
          )
        }
        pending={create.isPending}
        submitLabel={t("types.add")}
      />
      {types.isPending ? <Loading /> : null}
      {types.isError ? <ErrorState error={types.error} onRetry={() => void types.refetch()} /> : null}
      {types.data ? (
        <ul className="space-grid">
          {types.data.items.map((type) => (
            <li key={type.id}>
              <Link className="ui-card space-card type-card" to={`/types/${type.id}`}>
                <span className="type-card__title">
                  <TypeMark color={type.color} icon={type.icon} />
                  <strong>{type.name}</strong>
                </span>
                <span className="data-table__sub">
                  {type.key} · {t("types.templates")}: {type.templates.map((item) => item.name).join(", ") || "—"}
                </span>
                {type.system ? <Badge>{t("types.system")}</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TypePage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const type = useTicketType(id);
  return (
    <section className="page">
      <PageHeader back="/types" title={type.data?.name ?? t("types.title")} />
      {type.isPending ? <Loading /> : null}
      {type.isError ? <ErrorState error={type.error} /> : null}
      {type.data ? (
        <div className="person-layout">
          <TypeForm key={type.data.id} type={type.data} />
          <TemplatesCard type={type.data} />
        </div>
      ) : null}
    </section>
  );
}

function toForm(type: TicketType) {
  return {
    name: type.name,
    color: type.color,
    icon: type.icon,
    fieldIds: type.fieldIds,
    rollups: type.rollups,
    allowedParentTypeIds: type.allowedParentTypeIds,
    outcomes: type.outcomes.map((outcome) => `${outcome.key} — ${outcome.label}`).join("\n"),
  };
}

/** «done — Выполнено» по строке → исходы типа. */
function parseOutcomes(text: string) {
  return lines(text).map((line) => {
    const [key, ...label] = line.split(/\s+[—–-]\s+/);
    return { key: (key ?? "").trim(), label: label.join(" — ").trim() || (key ?? "").trim() };
  });
}

function TypeForm({ type }: { type: TicketType }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const fields = useFields();
  const types = useTicketTypes();
  const update = useUpdateTicketType();
  const remove = useDeleteTicketType();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [form, setForm] = useState(() => toForm(type));
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm(type)), [type]);

  const fieldById = new Map((fields.data?.items ?? []).map((field) => [field.id, field]));
  const setRollup = <K extends keyof RollupSettings>(key: K, value: RollupSettings[K]) =>
    setForm({ ...form, rollups: { ...form.rollups, [key]: value } });
  const move = (index: number, delta: number) => {
    const next = [...form.fieldIds];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item as string);
    setForm({ ...form, fieldIds: next });
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      { id: type.id, body: { ...form, outcomes: parseOutcomes(form.outcomes) } },
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <Card>
      <ReadOnlyNote />
      <Notice
        error={update.isError ? errorText(update.error) : remove.isError ? errorText(remove.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          update.reset();
          remove.reset();
          setSaved(false);
        }}
      />
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={!isSuperadmin}>
          <div className="type-preview-line">
            <TypeMark color={form.color} icon={form.icon} size={22} />
            <span className="data-table__sub">
              {t("types.key")}: <code>{type.key}</code>
            </span>
          </div>
          <Input
            label={t("common.name")}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          <div className="form-row">
            <Input
              label={t("types.color")}
              onChange={(e) => setForm({ ...form, color: e.target.value.toUpperCase() })}
              type="color"
              value={form.color}
            />
            <Select
              label={t("types.icon")}
              onChange={(e) => setForm({ ...form, icon: e.target.value as TypeIcon })}
              value={form.icon}
            >
              {TYPE_ICONS.map((icon) => (
                <option key={icon} value={icon}>
                  {icon}
                </option>
              ))}
            </Select>
          </div>

          <CheckboxPicker
            label={t("types.fields")}
            onChange={(fieldIds) =>
              // Новые поля — в конец, порядок уже выбранных сохраняем.
              setForm({
                ...form,
                fieldIds: [
                  ...form.fieldIds.filter((fieldId) => fieldIds.includes(fieldId)),
                  ...fieldIds.filter((fieldId) => !form.fieldIds.includes(fieldId)),
                ],
              })
            }
            options={(fields.data?.items ?? []).map((field) => ({
              id: field.id,
              label: field.name,
              hint: `${field.key} · ${t(`fields.kind.${field.kind}` as MessageKey)}`,
            }))}
            value={form.fieldIds}
          />
          <div className="ui-field">
            <span className="ui-field__label">{t("types.fieldsHint")}</span>
            {form.fieldIds.length === 0 ? <p className="ui-field__hint">{t("types.noFields")}</p> : null}
            <ol className="order-list">
              {form.fieldIds.map((fieldId, index) => {
                const name = fieldById.get(fieldId)?.name ?? fieldId;
                return (
                  <li key={fieldId}>
                    <span>{name}</span>
                    <span className="order-list__actions">
                      <button
                        aria-label={t("types.moveUp", { name })}
                        className="ui-icon-button"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        type="button"
                      >
                        <ArrowUp aria-hidden="true" size={16} />
                      </button>
                      <button
                        aria-label={t("types.moveDown", { name })}
                        className="ui-icon-button"
                        disabled={index === form.fieldIds.length - 1}
                        onClick={() => move(index, 1)}
                        type="button"
                      >
                        <ArrowDown aria-hidden="true" size={16} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          <fieldset className="form-stack rollups">
            <legend className="ui-field__label">{t("types.rollups")}</legend>
            <p className="ui-field__hint">{t("types.rollupsHint")}</p>
            <label className="checkbox-inline">
              <input
                checked={form.rollups.status}
                onChange={(e) => setRollup("status", e.target.checked)}
                type="checkbox"
              />
              {t("types.rollup.status")}
            </label>
            <Select
              label={t("types.rollup.progress")}
              onChange={(e) => setRollup("progress", e.target.value as ProgressSource)}
              value={form.rollups.progress}
            >
              {PROGRESS_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`types.rollup.progress.${source}` as MessageKey)}
                </option>
              ))}
            </Select>
            <label className="checkbox-inline">
              <input
                checked={form.rollups.progressByEstimate}
                onChange={(e) => setRollup("progressByEstimate", e.target.checked)}
                type="checkbox"
              />
              {t("types.rollup.progressByEstimate")}
            </label>
            <label className="checkbox-inline">
              <input
                checked={form.rollups.dates}
                onChange={(e) => setRollup("dates", e.target.checked)}
                type="checkbox"
              />
              {t("types.rollup.dates")}
            </label>
            <label className="checkbox-inline">
              <input
                checked={form.rollups.estimates}
                onChange={(e) => setRollup("estimates", e.target.checked)}
                type="checkbox"
              />
              {t("types.rollup.estimates")}
            </label>
          </fieldset>

          <Textarea
            hint={t("types.outcomesHint")}
            label={t("types.outcomes")}
            onChange={(e) => setForm({ ...form, outcomes: e.target.value })}
            rows={4}
            value={form.outcomes}
          />
          <CheckboxPicker
            label={t("types.parents")}
            onChange={(allowedParentTypeIds) => setForm({ ...form, allowedParentTypeIds })}
            options={(types.data?.items ?? []).map((item) => ({ id: item.id, label: item.name }))}
            value={form.allowedParentTypeIds}
          />
          <p className="ui-field__hint">{t("types.parentsHint")}</p>
        </fieldset>
        {isSuperadmin ? (
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("common.save")}
            </Button>
            {!type.system ? (
              <Button
                loading={remove.isPending}
                onClick={() => {
                  if (window.confirm(t("types.deleteConfirm", { name: type.name }))) {
                    remove.mutate(type.id, { onSuccess: () => navigate("/types") });
                  }
                }}
                variant="danger"
              >
                {t("common.delete")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function TemplatesCard({ type }: { type: TicketType }) {
  const { t } = useI18n();
  const create = useCreateTemplate();
  const navigate = useNavigate();
  const errorText = useErrorText();
  return (
    <Card>
      <h2>{t("types.scheme")}</h2>
      <p>
        <Link to={`/types/${type.id}/scheme`}>{t("types.schemeOpen")}</Link>
      </p>
      <h2>{t("types.templates")}</h2>
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      {type.templates.length === 0 ? <p className="ui-field__hint">{t("types.templatesEmpty")}</p> : null}
      <ul className="link-list">
        {type.templates.map((template) => (
          <li key={template.id}>
            <Link to={`/templates/${template.id}`}>{template.name}</Link>
          </li>
        ))}
      </ul>
      <QuickCreate
        label={t("types.templateName")}
        onCreate={(name, reset) =>
          create.mutate(
            { typeId: type.id, body: { name } },
            {
              onSuccess: (template) => {
                reset();
                navigate(`/templates/${template.id}`);
              },
            },
          )
        }
        pending={create.isPending}
        submitLabel={t("types.addTemplate")}
      />
    </Card>
  );
}
