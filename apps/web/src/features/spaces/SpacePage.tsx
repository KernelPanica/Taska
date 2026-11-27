import { ArrowLeft } from "@phosphor-icons/react";
import { TicketsPanel } from "../tickets/TicketsPanel";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Space } from "@yourtask/contracts";
import { useRenameSpace, useSpace } from "../../api/hooks";
import { Badge, Button, Card, Input } from "../../components/ui";
import { Notice, useErrorText, useIsSuperadmin } from "../directory/shared";
import { useI18n } from "../../i18n";
import { ErrorState, Loading } from "../../app/states";

export function SpacePage() {
  const { t } = useI18n();
  const { slug = "" } = useParams();
  const space = useSpace(slug);

  return (
    <section className="page">
      <Link className="back-link" to="/">
        <ArrowLeft aria-hidden="true" size={16} />
        {t("spaces.back")}
      </Link>
      {space.isPending ? <Loading /> : null}
      {space.isError ? <ErrorState error={space.error} onRetry={() => void space.refetch()} /> : null}
      {space.data ? (
        <>
          <header className="page-heading">
            <h1>{space.data.name}</h1>
            <Badge>{t(space.data.role ? `spaces.role.${space.data.role}` : "spaces.role.none")}</Badge>
          </header>
          <RenameSpace space={space.data} />
          <SpaceSettings space={space.data} />
          <TicketsPanel space={space.data} />
        </>
      ) : null}
    </section>
  );
}

function RenameSpace({ space }: { space: Space }) {
  const { t } = useI18n();
  const rename = useRenameSpace();
  const errorText = useErrorText();
  const [name, setName] = useState(space.name);
  if (!useIsSuperadmin()) return null;
  return (
    <>
      <Notice error={rename.isError ? errorText(rename.error) : null} onDismiss={() => rename.reset()} />
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) rename.mutate({ id: space.id, body: { name: name.trim() } });
        }}
      >
        <Input
          label={t("common.name")}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <Button loading={rename.isPending} type="submit" variant="secondary">
          {t("spaces.rename")}
        </Button>
      </form>
    </>
  );
}

/** Ограничители подчинения и конвертер оценок пространства (R-2.7, R-2.26; YT-04). */
function SpaceSettings({ space }: { space: Space }) {
  const { t } = useI18n();
  const update = useRenameSpace();
  const errorText = useErrorText();
  const isSuperadmin = useIsSuperadmin();
  // Локальное состояние: переключатель отзывается сразу, при ошибке возвращается назад.
  const [enforced, setEnforced] = useState(space.enforceSubordination);
  useEffect(() => setEnforced(space.enforceSubordination), [space.enforceSubordination]);
  return (
    <Card className="space-settings">
      <Notice error={update.isError ? errorText(update.error) : null} onDismiss={() => update.reset()} />
      <label className="checkbox-inline">
        <input
          checked={enforced}
          disabled={!isSuperadmin}
          onChange={(e) => {
            const next = e.target.checked;
            setEnforced(next);
            update.mutate(
              { id: space.id, body: { enforceSubordination: next } },
              { onError: () => setEnforced(space.enforceSubordination) },
            );
          }}
          type="checkbox"
        />
        {t("spaces.subordination")}
      </label>
      <p className="ui-field__hint">{t("spaces.subordinationHint")}</p>
      <Link to={`/estimates?space=${space.id}`}>{t("spaces.converterLink")}</Link>
    </Card>
  );
}
