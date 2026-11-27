import { useState, type FormEvent } from "react";
import type { LinkType } from "@yourtask/contracts";
import { useCreateLinkType, useDeleteLinkType, useLinkTypes, useUpdateLinkType } from "../../api/hooks";
import { Badge, Button, Card, Input } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";

/** Типы связей (R-2.13; YT-12): системные — родные R-2.13, админ добавляет свои. */
export function LinkTypesPage() {
  const { t } = useI18n();
  const types = useLinkTypes();
  const isSuperadmin = useIsSuperadmin();
  const create = useCreateLinkType();
  const errorText = useErrorText();
  const [name, setName] = useState("");
  const [inverse, setInverse] = useState("");
  const [symmetric, setSymmetric] = useState(false);
  return (
    <section className="page">
      <PageHeader description={t("links.typesLead")} title={t("links.typesTitle")} />
      <ReadOnlyNote />
      {isSuperadmin ? (
        <form
          className="inline-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!name.trim()) return;
            create.mutate(
              {
                name: name.trim(),
                symmetric,
                ...(symmetric || !inverse.trim() ? {} : { inverseName: inverse.trim() }),
              },
              {
                onSuccess: () => {
                  setName("");
                  setInverse("");
                  setSymmetric(false);
                },
              },
            );
          }}
        >
          <Input label={t("links.typeName")} maxLength={120} onChange={(e) => setName(e.target.value)} value={name} />
          {!symmetric ? (
            <Input
              label={t("links.typeInverse")}
              maxLength={120}
              onChange={(e) => setInverse(e.target.value)}
              value={inverse}
            />
          ) : null}
          <label className="checkbox-inline">
            <input checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} type="checkbox" />
            {t("links.typeSymmetric")}
          </label>
          <Button loading={create.isPending} type="submit">
            {t("links.typeAdd")}
          </Button>
        </form>
      ) : null}
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      {types.isPending ? <Loading /> : null}
      {types.isError ? <ErrorState error={types.error} /> : null}
      <div className="form-stack">
        {(types.data?.items ?? []).map((type) => (
          <LinkTypeRow key={`${type.id}-${type.name}-${type.inverseName}`} type={type} />
        ))}
      </div>
    </section>
  );
}

function LinkTypeRow({ type }: { type: LinkType }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const update = useUpdateLinkType();
  const remove = useDeleteLinkType();
  const errorText = useErrorText();
  const [name, setName] = useState(type.name);
  const [inverse, setInverse] = useState(type.inverseName);
  const failed = update.error ?? remove.error;
  const translated = (key: string, fallback: string) => {
    const message = `links.type.${key}` as MessageKey;
    const text = t(message);
    return text === message ? fallback : text;
  };
  return (
    <Card className="form-stack">
      <p>
        <strong>{translated(`${type.key}.out`, type.name)}</strong>
        {type.symmetric ? null : <> ↔ {translated(`${type.key}.in`, type.inverseName)}</>}{" "}
        {type.system ? <Badge>{t("links.typeSystem")}</Badge> : <Badge variant="info">{t("access.custom")}</Badge>}{" "}
        <span className="ui-field__hint">{t("links.typeCount", { count: type.links })}</span>
      </p>
      <Notice
        error={failed ? errorText(failed) : null}
        onDismiss={() => {
          update.reset();
          remove.reset();
        }}
      />
      {isSuperadmin ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({ id: type.id, name, ...(type.symmetric ? {} : { inverseName: inverse }) });
          }}
        >
          <Input label={t("links.typeName")} maxLength={120} onChange={(e) => setName(e.target.value)} value={name} />
          {!type.symmetric ? (
            <Input
              label={t("links.typeInverse")}
              maxLength={120}
              onChange={(e) => setInverse(e.target.value)}
              value={inverse}
            />
          ) : null}
          <Button loading={update.isPending} type="submit" variant="secondary">
            {t("common.save")}
          </Button>
          {!type.system ? (
            <Button
              disabled={type.links > 0}
              loading={remove.isPending}
              onClick={() => remove.mutate(type.id)}
              variant="danger"
            >
              {t("common.delete")}
            </Button>
          ) : null}
        </form>
      ) : null}
    </Card>
  );
}
