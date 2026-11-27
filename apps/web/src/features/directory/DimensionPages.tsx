import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DIMENSION_SOURCES, type Dimension, type DimensionKind, type DimensionSource } from "@yourtask/contracts";
import {
  useCreateDimension,
  useDeleteDimension,
  useDimension,
  useDimensions,
  useUpdateDimension,
} from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "./shared";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function SelectionField({ multiple, onChange }: { multiple: boolean; onChange(multiple: boolean): void }) {
  const { t } = useI18n();
  return (
    <fieldset className="radio-group">
      <legend className="ui-field__label">{t("dimensions.selection")}</legend>
      <label>
        <input checked={!multiple} name="selection" onChange={() => onChange(false)} type="radio" />{" "}
        {t("dimensions.single")}
      </label>
      <label>
        <input checked={multiple} name="selection" onChange={() => onChange(true)} type="radio" />{" "}
        {t("dimensions.multiple")}
      </label>
    </fieldset>
  );
}

function OptionsField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t } = useI18n();
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor="dimension-options">
        {t("dimensions.options")}
      </label>
      <textarea
        className="ui-input"
        id="dimension-options"
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        value={value}
      />
      <p className="ui-field__hint">{t("dimensions.optionsHint")}</p>
    </div>
  );
}

function describe(dimension: Dimension, t: ReturnType<typeof useI18n>["t"]) {
  const kind = t(`dimensions.kind.${dimension.kind}`);
  const source = dimension.source ? ` · ${t(`dimensions.source.${dimension.source}`)}` : "";
  return `${kind}${source} · ${dimension.multiple ? t("dimensions.multiple") : t("dimensions.single")}`;
}

export function DimensionsPage() {
  const { t } = useI18n();
  const dimensions = useDimensions();
  const isSuperadmin = useIsSuperadmin();
  return (
    <section className="page">
      <PageHeader description={t("dimensions.description")} title={t("dimensions.title")} />
      <ReadOnlyNote />
      {isSuperadmin ? <DimensionBuilder /> : null}
      {dimensions.isPending ? <Loading /> : null}
      {dimensions.isError ? <ErrorState error={dimensions.error} onRetry={() => void dimensions.refetch()} /> : null}
      {dimensions.data ? (
        <ul className="space-grid">
          {dimensions.data.items.map((dimension) => (
            <li key={dimension.id}>
              <Link className="ui-card space-card" to={`/dimensions/${dimension.id}`}>
                <strong>{dimension.name}</strong>
                <span className="data-table__sub">{describe(dimension, t)}</span>
                {dimension.kind === "list" ? (
                  <span className="data-table__sub">{dimension.options.map((option) => option.label).join(", ")}</span>
                ) : null}
                {dimension.system ? <Badge>{t("dimensions.system")}</Badge> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Конструктор измерения: название, тип, источник для группы людей, режим выбора, значения списка. */
function DimensionBuilder() {
  const { t } = useI18n();
  const create = useCreateDimension();
  const errorText = useErrorText();
  const empty = {
    name: "",
    kind: "list" as DimensionKind,
    source: "feature_teams" as DimensionSource,
    multiple: false,
    options: "",
  };
  const [form, setForm] = useState(empty);
  const [created, setCreated] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      {
        name: form.name,
        kind: form.kind,
        multiple: form.multiple,
        ...(form.kind === "people_group" ? { source: form.source } : { options: lines(form.options) }),
      },
      {
        onSuccess: (dimension) => {
          setCreated(dimension.name);
          setForm(empty);
        },
      },
    );
  }

  return (
    <Card>
      <h2>{t("dimensions.add")}</h2>
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
          label={t("dimensions.kind")}
          onChange={(e) => setForm({ ...form, kind: e.target.value as DimensionKind })}
          value={form.kind}
        >
          <option value="list">{t("dimensions.kind.list")}</option>
          <option value="people_group">{t("dimensions.kind.people_group")}</option>
        </Select>
        {form.kind === "people_group" ? (
          <Select
            label={t("dimensions.source")}
            onChange={(e) => setForm({ ...form, source: e.target.value as DimensionSource })}
            value={form.source}
          >
            {DIMENSION_SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`dimensions.source.${source}`)}
              </option>
            ))}
          </Select>
        ) : (
          <OptionsField onChange={(options) => setForm({ ...form, options })} value={form.options} />
        )}
        <SelectionField multiple={form.multiple} onChange={(multiple) => setForm({ ...form, multiple })} />
        <div className="page-actions">
          <Button loading={create.isPending} type="submit">
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function DimensionPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const dimension = useDimension(id);
  return (
    <section className="page">
      <PageHeader back="/dimensions" title={dimension.data?.name ?? t("dimensions.title")} />
      {dimension.isPending ? <Loading /> : null}
      {dimension.isError ? <ErrorState error={dimension.error} /> : null}
      {dimension.data ? <DimensionForm dimension={dimension.data} key={dimension.data.id} /> : null}
    </section>
  );
}

function DimensionForm({ dimension }: { dimension: Dimension }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const update = useUpdateDimension();
  const remove = useDeleteDimension();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const toForm = (item: Dimension) => ({
    name: item.name,
    multiple: item.multiple,
    options: item.options.map((o) => o.label).join("\n"),
  });
  const [form, setForm] = useState(() => toForm(dimension));
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm(dimension)), [dimension]);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      {
        id: dimension.id,
        body: {
          name: form.name,
          multiple: form.multiple,
          ...(dimension.kind === "list" ? { options: lines(form.options) } : {}),
        },
      },
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
      <p className="data-table__sub">
        {describe(dimension, t)} · {t("dimensions.key")}: <code>{dimension.key}</code>
      </p>
      <p className="ui-field__hint">{t("dimensions.kindFixed")}</p>
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={!isSuperadmin}>
          <Input
            label={t("common.name")}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          <SelectionField multiple={form.multiple} onChange={(multiple) => setForm({ ...form, multiple })} />
          {dimension.kind === "list" ? (
            <OptionsField onChange={(options) => setForm({ ...form, options })} value={form.options} />
          ) : null}
        </fieldset>
        {isSuperadmin ? (
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("common.save")}
            </Button>
            {dimension.system ? null : (
              <Button
                loading={remove.isPending}
                onClick={() => {
                  if (window.confirm(`${t("common.delete")}: ${dimension.name}?`)) {
                    remove.mutate(dimension.id, { onSuccess: () => navigate("/dimensions") });
                  }
                }}
                variant="danger"
              >
                {t("common.delete")}
              </Button>
            )}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
