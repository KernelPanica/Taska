import { SquaresFour } from "@phosphor-icons/react";
import { Link, useNavigate } from "react-router-dom";
import { useCreateSpace, useSpaces } from "../../api/hooks";
import { Notice, PageHeader, QuickCreate, useErrorText } from "../directory/shared";
import { Badge, Card } from "../../components/ui";
import { useI18n } from "../../i18n";
import { ErrorState, Loading } from "../../app/states";

export function SpacesPage() {
  const { t } = useI18n();
  const spaces = useSpaces();
  const create = useCreateSpace();
  const navigate = useNavigate();
  const errorText = useErrorText();

  return (
    <section className="page">
      <PageHeader description={t("spaces.description")} title={t("spaces.title")} />
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <QuickCreate
        label={t("common.name")}
        onCreate={(name, reset) =>
          create.mutate({ name }, { onSuccess: (space) => (reset(), navigate(`/spaces/${space.slug}`)) })
        }
        pending={create.isPending}
        submitLabel={t("spaces.add")}
      />
      {spaces.isPending ? <Loading /> : null}
      {spaces.isError ? <ErrorState error={spaces.error} onRetry={() => void spaces.refetch()} /> : null}
      {spaces.data?.items.length === 0 ? (
        <Card className="empty-state">
          <SquaresFour aria-hidden="true" size={32} />
          <h2>{t("spaces.none.title")}</h2>
          <p>{t("spaces.none.text")}</p>
        </Card>
      ) : null}
      {spaces.data?.items.length ? (
        <ul className="space-grid">
          {spaces.data.items.map((space) => (
            <li key={space.id}>
              <Link className="ui-card space-card" to={`/spaces/${encodeURIComponent(space.slug)}`}>
                <strong>{space.name}</strong>
                <Badge>{t(space.role ? `spaces.role.${space.role}` : "spaces.role.none")}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
