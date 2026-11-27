import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  rollupEstimates,
  type Converter,
  type Estimate,
  type EstimateScale,
  type FieldValue,
  type TicketField,
  type TicketTemplate,
  type TicketType,
} from "@yourtask/contracts";
import {
  useConverter,
  useDeleteTemplate,
  useDimensions,
  useFields,
  useGroups,
  usePeople,
  useScales,
  useSpaces,
  useTicketTemplate,
  useTicketType,
  useUpdateTemplate,
} from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n } from "../../i18n";
import { dimensionOptions, ValueEditor } from "./fieldValues";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";
import { estimateLabel, formatRange, lines, MarkdownPreview, Textarea, TypeMark, useEstimateHint } from "./shared";

/** Шаблон типа (R-2.7, YT-04): структура описания, чеклист, значения полей и предпросмотр тикета по нему. */
export function TemplatePage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const template = useTicketTemplate(id);
  const type = useTicketType(template.data?.typeId ?? "");
  return (
    <section className="page">
      <PageHeader
        back={template.data ? `/types/${template.data.typeId}` : "/types"}
        title={template.data ? `${t("template.title")}: ${template.data.name}` : t("template.title")}
      />
      {template.isPending || (template.data && type.isPending) ? <Loading /> : null}
      {template.isError ? <ErrorState error={template.error} /> : null}
      {template.data && type.data ? (
        <TemplateEditor key={template.data.id} template={template.data} type={type.data} />
      ) : null}
    </section>
  );
}

interface Form {
  name: string;
  description: string;
  checklist: string;
  values: Record<string, FieldValue>;
}

const toForm = (template: TicketTemplate): Form => ({
  name: template.name,
  description: template.description,
  checklist: template.checklist.join("\n"),
  values: template.values,
});

function TemplateEditor({ template, type }: { template: TicketTemplate; type: TicketType }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const allFields = useFields();
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [form, setForm] = useState(() => toForm(template));
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm(template)), [template]);

  const fields = useMemo(() => {
    const byId = new Map((allFields.data?.items ?? []).map((field) => [field.id, field]));
    return type.fieldIds.map((fieldId) => byId.get(fieldId)).filter((field): field is TicketField => Boolean(field));
  }, [allFields.data, type.fieldIds]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const values = Object.fromEntries(
      Object.entries(form.values).filter(([, value]) => value !== null && value !== ""),
    );
    update.mutate(
      {
        id: template.id,
        body: { name: form.name, description: form.description, checklist: lines(form.checklist), values },
      },
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <div className="person-layout">
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
            <Input
              label={t("common.name")}
              maxLength={120}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              value={form.name}
            />
            <Textarea
              hint={t("template.descriptionHint")}
              label={t("template.description")}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={12}
              value={form.description}
            />
            <Textarea
              hint={t("template.checklistHint")}
              label={t("template.checklist")}
              onChange={(e) => setForm({ ...form, checklist: e.target.value })}
              rows={4}
              value={form.checklist}
            />
            <fieldset className="form-stack">
              <legend className="ui-field__label">{t("template.values")}</legend>
              {fields.map((field) => (
                <ValueEditor
                  field={field}
                  key={field.id}
                  onChange={(value) => setForm({ ...form, values: { ...form.values, [field.key]: value } })}
                  value={form.values[field.key] ?? null}
                />
              ))}
            </fieldset>
          </fieldset>
          {isSuperadmin ? (
            <div className="page-actions">
              <Button loading={update.isPending} type="submit">
                {t("common.save")}
              </Button>
              {!template.system ? (
                <Button
                  loading={remove.isPending}
                  onClick={() => {
                    if (window.confirm(t("template.deleteConfirm", { name: template.name }))) {
                      remove.mutate(template.id, { onSuccess: () => navigate(`/types/${type.id}`) });
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
      <TemplatePreview fields={fields} form={form} type={type} />
    </div>
  );
}

/** Как будет выглядеть новый тикет по шаблону: поля с ориентиром, описание, чеклист, пример свёртки. */
function TemplatePreview({ type, fields, form }: { type: TicketType; fields: TicketField[]; form: Form }) {
  const { t, locale } = useI18n();
  const spaces = useSpaces();
  const scales = useScales();
  const dimensions = useDimensions();
  const people = usePeople();
  const teams = useGroups("feature-teams");
  const guilds = useGroups("guilds");
  const [spaceId, setSpaceId] = useState<string>("");
  const converter = useConverter(spaceId || null);
  const hint = useEstimateHint();
  const scaleList = scales.data?.items ?? [];
  const scaleOf = (field: TicketField) => scaleList.find((scale) => scale.id === field.scaleId);

  const estimates: Estimate[] = fields
    .filter(
      (field) => field.kind === "estimate" && form.values[field.key] !== null && form.values[field.key] !== undefined,
    )
    .map((field) => ({ scaleId: field.scaleId as string, value: form.values[field.key] as string | number }));
  const [rollupScaleId, setRollupScaleId] = useState("");
  // По умолчанию — шкала первой оценки шаблона: так свёртка сразу показывает знакомые единицы.
  const rollupScale =
    scaleList.find((scale) => scale.id === rollupScaleId) ??
    scaleList.find((scale) => scale.id === estimates[0]?.scaleId) ??
    scaleList[0];

  const display = (field: TicketField, value: FieldValue): string => {
    const ids = Array.isArray(value) ? value : [String(value)];
    const name = (list: { id: string; label?: string; name?: string }[]) =>
      ids
        .map((id) => list.find((item) => item.id === id))
        .map((item) => item?.label ?? item?.name ?? "?")
        .join(", ");
    switch (field.kind) {
      case "list":
        return name(field.options);
      case "person":
        return name(people.data?.items ?? []);
      case "estimate":
        return estimateLabel(scaleOf(field), value as string | number);
      case "dimension": {
        const dimension = dimensions.data?.items.find((item) => item.id === field.dimensionId);
        return name(dimensionOptions(dimension, teams.data?.items ?? [], guilds.data?.items ?? []));
      }
      case "date":
        return new Date(`${String(value)}T00:00:00`).toLocaleDateString(locale);
      default:
        return String(value);
    }
  };

  return (
    <Card className="ticket-preview" aria-label={t("template.preview")}>
      <div className="ticket-preview__head">
        <h2>{t("template.preview")}</h2>
        <Select label={t("template.previewSpace")} onChange={(e) => setSpaceId(e.target.value)} value={spaceId}>
          <option value="">{t("estimates.converterDefault")}</option>
          {(spaces.data?.items ?? []).map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </Select>
      </div>
      <article className="ticket-preview__card">
        <p className="ticket-preview__type">
          <TypeMark color={type.color} icon={type.icon} />
          <span>{type.name}</span>
          <Badge>{form.name}</Badge>
        </p>
        <h3 className="ticket-preview__title">{t("template.previewTitle", { type: type.name })}</h3>
        <dl className="fields">
          {fields.map((field) => {
            const value = form.values[field.key];
            const set =
              value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length);
            const guide =
              set && field.kind === "estimate" ? hint(scaleOf(field), value as string | number, converter.data) : null;
            return (
              <div className="fields__row" key={field.id}>
                <dt>{field.name}</dt>
                <dd>
                  {set ? display(field, value) : "—"}
                  {guide ? <span className="estimate-hint"> {guide}</span> : null}
                </dd>
              </div>
            );
          })}
        </dl>
        <MarkdownPreview source={form.description} />
        {lines(form.checklist).length ? (
          <ul className="checklist-preview">
            {lines(form.checklist).map((item, index) => (
              <li key={index}>
                <input aria-label={item} disabled type="checkbox" /> {item}
              </li>
            ))}
          </ul>
        ) : null}
      </article>
      <RollupDemo
        converter={converter.data}
        estimates={estimates}
        onScale={setRollupScaleId}
        scale={rollupScale}
        scales={scaleList}
      />
    </Card>
  );
}

/** Свёртка родителя с двумя такими тикетами в шкале, которую выбрал смотрящий (R-2.12, R-2.26). */
function RollupDemo({
  estimates,
  scales,
  scale,
  converter,
  onScale,
}: {
  estimates: Estimate[];
  scales: EstimateScale[];
  scale: EstimateScale | undefined;
  converter: Converter | undefined;
  onScale(id: string): void;
}) {
  const { t, locale } = useI18n();
  if (!scale || !converter) return null;
  const { result } = rollupEstimates([estimates, estimates], scale, scales, converter);
  let text = t("template.rollupNone");
  if (result) {
    const range = formatRange(result, locale);
    text =
      scale.kind === "numeric"
        ? t("template.rollupResult", { value: `${range}${scale.unit ? ` ${scale.unit}` : ""}` })
        : `${estimateLabel(scale, result.valueId ?? "")} · ${t("estimates.hint", { range })}`;
  }
  return (
    <div className="rollup-demo">
      <h3>{t("template.rollup")}</h3>
      <Select label={t("template.rollupScale")} onChange={(e) => onScale(e.target.value)} value={scale.id}>
        {scales.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
      <p className="rollup-demo__result" role="status">
        {text}
        {result && !result.exact ? <span className="estimate-hint"> · {t("template.converted")}</span> : null}
      </p>
    </div>
  );
}
