import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DAYS_SCALE_KEY,
  SCALE_KINDS,
  type Converter,
  type ConverterEntry,
  type EstimateScale,
  type ScaleKind,
} from "@yourtask/contracts";
import {
  useConverter,
  useCreateScale,
  useDeleteScale,
  useResetConverter,
  useSaveConverter,
  useScales,
  useSpaces,
  useUpdateScale,
} from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";
import { lines, Textarea } from "./shared";

/** Шкалы оценки и конвертер (R-2.26, YT-04). `?space=<id>` открывает конвертер пространства. */
export function EstimatesPage() {
  const { t } = useI18n();
  const scales = useScales();
  const isSuperadmin = useIsSuperadmin();
  return (
    <section className="page">
      <PageHeader description={t("estimates.description")} title={t("estimates.title")} />
      <ReadOnlyNote />
      {scales.isPending ? <Loading /> : null}
      {scales.isError ? <ErrorState error={scales.error} onRetry={() => void scales.refetch()} /> : null}
      {scales.data ? (
        <>
          <ConverterEditor scales={scales.data.items} />
          <div className="person-layout">
            <div className="form-stack">
              {scales.data.items.map((scale) => (
                <ScaleCard key={scale.id} scale={scale} />
              ))}
            </div>
            {isSuperadmin ? <ScaleBuilder /> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function ScaleCard({ scale }: { scale: EstimateScale }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const update = useUpdateScale();
  const remove = useDeleteScale();
  const errorText = useErrorText();
  const toForm = () => ({
    name: scale.name,
    unit: scale.unit ?? "",
    values: scale.values.map((value) => value.label).join("\n"),
  });
  const [form, setForm] = useState(toForm);
  useEffect(() => setForm(toForm()), [scale]);

  return (
    <Card>
      <div className="person-card__head">
        <h2>{scale.name}</h2>
        {scale.system ? <Badge>{t("types.system")}</Badge> : null}
      </div>
      <p className="ui-field__hint">
        <code>{scale.key}</code> · {t(`estimates.kind.${scale.kind}` as MessageKey)}
        {scale.kind === "ordinal" ? ` · ${scale.values.map((value) => value.label).join(", ")}` : ""}
        {scale.unit ? ` · ${scale.unit}` : ""}
      </p>
      <Notice
        error={update.isError ? errorText(update.error) : remove.isError ? errorText(remove.error) : null}
        onDismiss={() => {
          update.reset();
          remove.reset();
        }}
      />
      {isSuperadmin ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({
              id: scale.id,
              body: {
                name: form.name,
                ...(scale.kind === "numeric" ? { unit: form.unit || null } : { values: lines(form.values) }),
              },
            });
          }}
        >
          <Input
            label={t("common.name")}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          {scale.kind === "numeric" ? (
            <Input
              label={t("estimates.unit")}
              maxLength={20}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              value={form.unit}
            />
          ) : (
            <Textarea
              hint={t("estimates.valuesHint")}
              label={t("estimates.values")}
              onChange={(e) => setForm({ ...form, values: e.target.value })}
              rows={5}
              value={form.values}
            />
          )}
          <div className="page-actions">
            <Button loading={update.isPending} type="submit" variant="secondary">
              {t("common.save")}
            </Button>
            {!scale.system ? (
              <Button
                loading={remove.isPending}
                onClick={() => {
                  if (window.confirm(`${t("common.delete")}: ${scale.name}?`)) remove.mutate(scale.id);
                }}
                variant="danger"
              >
                {t("common.delete")}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function ScaleBuilder() {
  const { t } = useI18n();
  const create = useCreateScale();
  const errorText = useErrorText();
  const empty = { name: "", kind: "ordinal" as ScaleKind, unit: "", values: "" };
  const [form, setForm] = useState(empty);
  const [created, setCreated] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      {
        name: form.name,
        kind: form.kind,
        ...(form.kind === "numeric" ? { unit: form.unit || null } : { values: lines(form.values) }),
      },
      {
        onSuccess: (scale) => {
          setCreated(scale.name);
          setForm(empty);
        },
      },
    );
  }

  return (
    <Card>
      <h2>{t("estimates.addScale")}</h2>
      <Notice
        error={create.isError ? errorText(create.error) : null}
        message={created ? `${t("common.saved")}: ${created}` : null}
        onDismiss={() => {
          create.reset();
          setCreated(null);
        }}
      />
      <form className="form-stack" onSubmit={submit}>
        <Input
          label={t("common.name")}
          maxLength={120}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          value={form.name}
        />
        <Select
          label={t("estimates.kind")}
          onChange={(e) => setForm({ ...form, kind: e.target.value as ScaleKind })}
          value={form.kind}
        >
          {SCALE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`estimates.kind.${kind}` as MessageKey)}
            </option>
          ))}
        </Select>
        {form.kind === "numeric" ? (
          <Input
            label={t("estimates.unit")}
            maxLength={20}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            value={form.unit}
          />
        ) : (
          <Textarea
            hint={t("estimates.valuesHint")}
            label={t("estimates.values")}
            onChange={(e) => setForm({ ...form, values: e.target.value })}
            rows={5}
            value={form.values}
          />
        )}
        <div className="page-actions">
          <Button loading={create.isPending} type="submit">
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

type Rows = Record<string, { min: string; max: string }>;
const rowKey = (scaleId: string, valueId: string | null) => `${scaleId}|${valueId ?? ""}`;

function toRows(converter: Converter): Rows {
  return Object.fromEntries(
    converter.entries.map((entry) => [
      rowKey(entry.scaleId, entry.valueId),
      { min: String(entry.minDays), max: String(entry.maxDays) },
    ]),
  );
}

/** Таблица соответствия шкал дням: по умолчанию или своя у пространства. */
function ConverterEditor({ scales }: { scales: EstimateScale[] }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const spaces = useSpaces();
  const [params, setParams] = useSearchParams();
  const spaceId = params.get("space") || null;
  const converter = useConverter(spaceId);
  const save = useSaveConverter();
  const reset = useResetConverter();
  const errorText = useErrorText();
  const [rows, setRows] = useState<Rows>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (converter.data) setRows(toRows(converter.data));
  }, [converter.data]);

  const convertible = scales.filter((scale) => scale.key !== DAYS_SCALE_KEY);
  const lineItems = convertible.flatMap((scale) =>
    scale.kind === "ordinal"
      ? scale.values.map((value) => ({
          scale,
          valueId: value.id as string | null,
          label: `${scale.name}: ${value.label}`,
        }))
      : [{ scale, valueId: null, label: `${scale.name}: ${t("estimates.perUnit", { unit: scale.unit ?? "" })}` }],
  );
  const editable = isSuperadmin && converter.data && (!converter.data.inherited || spaceId === null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const entries: ConverterEntry[] = lineItems
      .map(({ scale, valueId }) => ({ scale, valueId, row: rows[rowKey(scale.id, valueId)] }))
      .filter(({ row }) => row && row.min !== "" && row.max !== "")
      .map(({ scale, valueId, row }) => ({
        scaleId: scale.id,
        valueId,
        minDays: Number(row?.min),
        maxDays: Number(row?.max),
      }));
    save.mutate({ spaceId, body: { entries } }, { onSuccess: () => setSaved(true) });
  }

  return (
    <Card className="converter">
      <div className="person-card__head">
        <h2>{t("estimates.converter")}</h2>
        <Select
          label={t("estimates.converterFor")}
          onChange={(e) => setParams(e.target.value ? { space: e.target.value } : {})}
          value={spaceId ?? ""}
        >
          <option value="">{t("estimates.converterDefault")}</option>
          {(spaces.data?.items ?? []).map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </Select>
      </div>
      <Notice
        error={save.isError ? errorText(save.error) : reset.isError ? errorText(reset.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          save.reset();
          reset.reset();
          setSaved(false);
        }}
      />
      {converter.isPending ? <Loading /> : null}
      {converter.data?.inherited ? (
        <div className="converter__inherited">
          <p>{t("estimates.inherited")}</p>
          {isSuperadmin && spaceId ? (
            <Button
              loading={save.isPending}
              onClick={() => save.mutate({ spaceId, body: { entries: converter.data?.entries ?? [] } })}
              variant="secondary"
            >
              {t("estimates.makeOwn")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <form onSubmit={submit}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("estimates.value")}</th>
                <th scope="col">{t("estimates.minDays")}</th>
                <th scope="col">{t("estimates.maxDays")}</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map(({ scale, valueId, label }) => {
                const key = rowKey(scale.id, valueId);
                const row = rows[key] ?? { min: "", max: "" };
                const set = (patch: Partial<typeof row>) => setRows({ ...rows, [key]: { ...row, ...patch } });
                return (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td>
                      <input
                        aria-label={`${label}: ${t("estimates.minDays")}`}
                        className="ui-input converter__number"
                        disabled={!editable}
                        min={0}
                        onChange={(e) => set({ min: e.target.value })}
                        step="0.5"
                        type="number"
                        value={row.min}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${label}: ${t("estimates.maxDays")}`}
                        className="ui-input converter__number"
                        disabled={!editable}
                        min={0}
                        onChange={(e) => set({ max: e.target.value })}
                        step="0.5"
                        type="number"
                        value={row.max}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="ui-field__hint">{t("estimates.daysNative")}</p>
        {editable ? (
          <div className="page-actions">
            <Button loading={save.isPending} type="submit">
              {t("common.save")}
            </Button>
            {spaceId && !converter.data?.inherited ? (
              <Button loading={reset.isPending} onClick={() => reset.mutate(spaceId)} variant="secondary">
                {t("estimates.resetOwn")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
