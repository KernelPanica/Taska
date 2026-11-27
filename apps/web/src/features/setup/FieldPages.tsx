import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FIELD_KINDS, type FieldKind, type TicketField } from "@yourtask/contracts";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import {
  useMasks,
  useProfiles,
  useSetMask,
  useCreateField,
  useDeleteField,
  useDimensions,
  useField,
  useFields,
  useScales,
  useTicketTypes,
  useUpdateField,
} from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";
import { lines, Textarea } from "./shared";

/** Поля тикетов (R-2.5, YT-04): список и конструктор. */
export function FieldsPage() {
  const { t } = useI18n();
  const fields = useFields();
  const types = useTicketTypes();
  const isSuperadmin = useIsSuperadmin();
  const usedBy = (field: TicketField) =>
    (types.data?.items ?? []).filter((type) => type.fieldIds.includes(field.id)).map((type) => type.name);
  return (
    <section className="page">
      <PageHeader description={t("fields.description")} title={t("fields.title")} />
      <ReadOnlyNote />
      {isSuperadmin ? <FieldBuilder /> : null}
      {fields.isPending ? <Loading /> : null}
      {fields.isError ? <ErrorState error={fields.error} onRetry={() => void fields.refetch()} /> : null}
      {fields.data ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("common.name")}</th>
                <th scope="col">{t("types.key")}</th>
                <th scope="col">{t("fields.kind")}</th>
                <th scope="col">{t("types.title")}</th>
              </tr>
            </thead>
            <tbody>
              {fields.data.items.map((field) => (
                <tr key={field.id}>
                  <td>
                    <Link to={`/fields/${field.id}`}>{field.name}</Link>
                    {field.system ? <Badge>{t("types.system")}</Badge> : null}
                  </td>
                  <td>
                    <code>{field.key}</code>
                  </td>
                  <td>{t(`fields.kind.${field.kind}` as MessageKey)}</td>
                  <td>{usedBy(field).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function FieldBuilder() {
  const { t } = useI18n();
  const create = useCreateField();
  const scales = useScales();
  const dimensions = useDimensions();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const empty = {
    name: "",
    key: "",
    kind: "text" as FieldKind,
    options: "",
    multiple: false,
    scaleId: "",
    dimensionId: "",
  };
  const [form, setForm] = useState(empty);

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      {
        name: form.name,
        kind: form.kind,
        ...(form.key.trim() ? { key: form.key.trim() } : {}),
        ...(form.kind === "list" ? { options: lines(form.options) } : {}),
        ...(form.kind === "list" || form.kind === "person" ? { multiple: form.multiple } : {}),
        ...(form.kind === "estimate" ? { scaleId: form.scaleId || (scales.data?.items[0]?.id ?? "") } : {}),
        ...(form.kind === "dimension"
          ? { dimensionId: form.dimensionId || (dimensions.data?.items[0]?.id ?? "") }
          : {}),
      },
      { onSuccess: (field) => navigate(`/fields/${field.id}`) },
    );
  }

  return (
    <Card>
      <h2>{t("fields.add")}</h2>
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <form className="form-stack" onSubmit={submit}>
        <div className="form-row">
          <Input
            label={t("common.name")}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          <Input
            hint={t("types.keyHint")}
            label={t("types.key")}
            maxLength={40}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            pattern="[a-z][a-z0-9_]{1,39}"
            value={form.key}
          />
        </div>
        <Select
          label={t("fields.kind")}
          onChange={(e) => setForm({ ...form, kind: e.target.value as FieldKind })}
          value={form.kind}
        >
          {FIELD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`fields.kind.${kind}` as MessageKey)}
            </option>
          ))}
        </Select>
        {form.kind === "list" ? (
          <Textarea
            hint={t("dimensions.optionsHint")}
            label={t("fields.options")}
            onChange={(e) => setForm({ ...form, options: e.target.value })}
            rows={4}
            value={form.options}
          />
        ) : null}
        {form.kind === "estimate" ? (
          <Select
            label={t("fields.scale")}
            onChange={(e) => setForm({ ...form, scaleId: e.target.value })}
            value={form.scaleId}
          >
            {(scales.data?.items ?? []).map((scale) => (
              <option key={scale.id} value={scale.id}>
                {scale.name}
              </option>
            ))}
          </Select>
        ) : null}
        {form.kind === "dimension" ? (
          <Select
            label={t("fields.dimension")}
            onChange={(e) => setForm({ ...form, dimensionId: e.target.value })}
            value={form.dimensionId}
          >
            {(dimensions.data?.items ?? []).map((dimension) => (
              <option key={dimension.id} value={dimension.id}>
                {dimension.name}
              </option>
            ))}
          </Select>
        ) : null}
        {form.kind === "list" || form.kind === "person" ? (
          <label className="checkbox-inline">
            <input
              checked={form.multiple}
              onChange={(e) => setForm({ ...form, multiple: e.target.checked })}
              type="checkbox"
            />
            {t("fields.multiple")}
          </label>
        ) : null}
        <div className="page-actions">
          <Button loading={create.isPending} type="submit">
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function FieldPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const field = useField(id);
  return (
    <section className="page">
      <PageHeader back="/fields" title={field.data?.name ?? t("fields.title")} />
      {field.isPending ? <Loading /> : null}
      {field.isError ? <ErrorState error={field.error} /> : null}
      {field.data ? <FieldForm field={field.data} key={field.data.id} /> : null}
      {field.data ? <FieldMask fieldId={field.data.id} /> : null}
    </section>
  );
}

/** Маска поля (R-2.20): от каких профилей поле скрыто. Видно, если хотя бы один профиль человека у тикета не скрывает его. */
function FieldMask({ fieldId }: { fieldId: string }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const profiles = useProfiles();
  const masks = useMasks();
  const save = useSetMask(fieldId);
  const errorText = useErrorText();
  const current = masks.data?.items.find((item) => item.fieldId === fieldId)?.profileIds ?? [];
  const [chosen, setChosen] = useState<string[] | null>(null);
  const value = chosen ?? current;
  const [saved, setSaved] = useState(false);
  return (
    <Card className="form-stack">
      <h2>{t("access.mask")}</h2>
      <p className="ui-field__hint">{t("access.maskHint")}</p>
      <Notice
        error={save.isError ? errorText(save.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          save.reset();
          setSaved(false);
        }}
      />
      <fieldset className="plain-fieldset" disabled={!isSuperadmin}>
        <CheckboxPicker
          label={t("access.maskProfiles")}
          onChange={setChosen}
          options={(profiles.data?.items ?? [])
            .filter((profile) => profile.key !== "superadmin")
            .map((profile) => ({ id: profile.id, label: profile.name }))}
          value={value}
        />
      </fieldset>
      {isSuperadmin ? (
        <div className="page-actions">
          <Button loading={save.isPending} onClick={() => save.mutate(value, { onSuccess: () => setSaved(true) })}>
            {t("common.save")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function FieldForm({ field }: { field: TicketField }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const update = useUpdateField();
  const remove = useDeleteField();
  const types = useTicketTypes();
  const scales = useScales();
  const dimensions = useDimensions();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const toForm = () => ({
    name: field.name,
    options: field.options.map((option) => option.label).join("\n"),
    multiple: field.multiple,
  });
  const [form, setForm] = useState(toForm);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm()), [field]);
  const usedBy = (types.data?.items ?? []).filter((type) => type.fieldIds.includes(field.id)).map((type) => type.name);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      {
        id: field.id,
        body: {
          name: form.name,
          ...(field.kind === "list" ? { options: lines(form.options) } : {}),
          ...(field.kind === "list" || field.kind === "person" ? { multiple: form.multiple } : {}),
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
      <dl className="fields">
        <div className="fields__row">
          <dt>{t("types.key")}</dt>
          <dd>
            <code>{field.key}</code>
          </dd>
        </div>
        <div className="fields__row">
          <dt>{t("fields.kind")}</dt>
          <dd>
            {t(`fields.kind.${field.kind}` as MessageKey)}
            {field.scaleId ? ` · ${scales.data?.items.find((scale) => scale.id === field.scaleId)?.name ?? ""}` : ""}
            {field.dimensionId
              ? ` · ${dimensions.data?.items.find((dimension) => dimension.id === field.dimensionId)?.name ?? ""}`
              : ""}
          </dd>
        </div>
        <div className="fields__row">
          <dt>{t("types.title")}</dt>
          <dd>{usedBy.length ? t("fields.usedBy", { types: usedBy.join(", ") }) : t("fields.unused")}</dd>
        </div>
      </dl>
      <p className="ui-field__hint">{t("fields.fixed")}</p>
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={!isSuperadmin}>
          <Input
            label={t("common.name")}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          {field.kind === "list" ? (
            <Textarea
              hint={t("dimensions.optionsHint")}
              label={t("fields.options")}
              onChange={(e) => setForm({ ...form, options: e.target.value })}
              rows={5}
              value={form.options}
            />
          ) : null}
          {field.kind === "list" || field.kind === "person" ? (
            <label className="checkbox-inline">
              <input
                checked={form.multiple}
                onChange={(e) => setForm({ ...form, multiple: e.target.checked })}
                type="checkbox"
              />
              {t("fields.multiple")}
            </label>
          ) : null}
        </fieldset>
        {isSuperadmin ? (
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("common.save")}
            </Button>
            {!field.system ? (
              <Button
                loading={remove.isPending}
                onClick={() => {
                  if (window.confirm(`${t("common.delete")}: ${field.name}?`)) {
                    remove.mutate(field.id, { onSuccess: () => navigate("/fields") });
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
