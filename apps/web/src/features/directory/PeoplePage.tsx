import { useState } from "react";
import { Link } from "react-router-dom";
import { usePeople } from "../../api/hooks";
import { Badge, Card } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n } from "../../i18n";
import { PageHeader, ReadOnlyNote, useIsSuperadmin } from "./shared";

/** Люди из общего каталога YourSpace (R-2.2): заводят их там, здесь — распределяют (YT-03). */
export function PeoplePage() {
  const { t } = useI18n();
  const [showDeactivated, setShowDeactivated] = useState(false);
  const people = usePeople(showDeactivated);
  const isSuperadmin = useIsSuperadmin();

  return (
    <section className="page">
      <PageHeader description={t("people.description")} title={t("people.title")} />
      <ReadOnlyNote />
      <div className="page-toolbar">
        <p className="ui-field__hint">{t("people.addInCatalog")}</p>
        <label className="checkbox-inline">
          <input checked={showDeactivated} onChange={(e) => setShowDeactivated(e.target.checked)} type="checkbox" />
          {t("people.showDeactivated")}
        </label>
        {isSuperadmin ? <Link to="/people/catalog-report">{t("catalog.report")}</Link> : null}
      </div>
      {people.isPending ? <Loading /> : null}
      {people.isError ? <ErrorState error={people.error} onRetry={() => void people.refetch()} /> : null}
      {people.data?.items.length === 0 ? <Card className="empty-state">{t("people.empty")}</Card> : null}
      {people.data?.items.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("people.name")}</th>
                <th scope="col">{t("people.telegram")}</th>
                <th scope="col">{t("people.teams")}</th>
                <th scope="col">{t("people.guilds")}</th>
                <th scope="col">{t("people.wip")}</th>
              </tr>
            </thead>
            <tbody>
              {people.data.items.map((person) => (
                <tr className={person.deactivated ? "is-deactivated" : undefined} key={person.id}>
                  <td>
                    <Link to={`/people/${person.id}`}>{person.name}</Link>
                    {person.email ? <span className="data-table__sub">{person.email}</span> : null}
                    {person.role === "superadmin" ? <Badge variant="info">{t("shell.superadmin")}</Badge> : null}
                    {person.deactivated ? <Badge variant="warning">{t("people.deactivated")}</Badge> : null}
                    {!person.linked ? <Badge variant="danger">{t("people.notLinked")}</Badge> : null}
                  </td>
                  <td>{person.catalog?.telegram ?? "—"}</td>
                  <td>{person.teams.map((team) => team.name).join(", ") || "—"}</td>
                  <td>{person.guilds.map((guild) => guild.name).join(", ") || "—"}</td>
                  <td>{person.wipLimit ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
