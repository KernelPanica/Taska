import { useState } from "react";
import { Link } from "react-router-dom";
import { CATALOG_MATCHES, type CatalogMatch, type CatalogReportRow } from "@yourtask/contracts";
import { useCatalogReport, useCatalogSync, useResolveCatalogRow } from "../../api/hooks";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, useErrorText } from "./shared";

const VARIANT: Record<CatalogMatch, "neutral" | "info" | "success" | "warning" | "danger"> = {
  subject: "success",
  email: "success",
  manual: "info",
  created: "neutral",
  retired: "warning",
  unresolved: "danger",
};

/** Отчёт сопоставления людей YourTask с каталогом YourSpace (YT-03, docs/adr/0009). Только суперадмин. */
export function CatalogReportPage() {
  const { t, locale } = useI18n();
  const report = useCatalogReport();
  const sync = useCatalogSync();
  const errorText = useErrorText();
  const data = report.data;

  return (
    <section className="page">
      <PageHeader back="/people" description={t("catalog.description")} title={t("catalog.title")} />
      <Notice error={sync.isError ? errorText(sync.error) : null} onDismiss={() => sync.reset()} />
      {report.isPending ? <Loading /> : null}
      {report.isError ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : null}
      {data ? (
        <>
          <Card className="catalog-summary">
            <p>
              {t("catalog.lastSync", {
                time: data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString(locale) : t("catalog.never"),
              })}
            </p>
            {data.lastError ? (
              <p className="catalog-summary__error">{t("catalog.lastError", { error: data.lastError })}</p>
            ) : null}
            <p className="catalog-summary__counts">
              {CATALOG_MATCHES.map((match) => (
                <Badge key={match} variant={VARIANT[match]}>
                  {t(`catalog.match.${match}` as MessageKey)}: {data.counts[match]}
                </Badge>
              ))}
            </p>
            <p role="status">
              <strong>
                {data.counts.unresolved === 0
                  ? t("catalog.allResolved")
                  : t("catalog.unresolvedLeft", { count: data.counts.unresolved })}
              </strong>
            </p>
            <Button loading={sync.isPending} onClick={() => sync.mutate()} variant="secondary">
              {t("catalog.syncNow")}
            </Button>
          </Card>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("catalog.person")}</th>
                  <th scope="col">{t("catalog.match")}</th>
                  <th scope="col">{t("catalog.action")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.person.id}>
                    <td>
                      <Link to={`/people/${row.person.id}`}>{row.person.name}</Link>
                      {row.person.email ? <span className="data-table__sub">{row.person.email}</span> : null}
                      {row.person.deactivated ? <Badge variant="warning">{t("people.deactivated")}</Badge> : null}
                    </td>
                    <td>
                      <Badge variant={VARIANT[row.match]}>{t(`catalog.match.${row.match}` as MessageKey)}</Badge>
                    </td>
                    <td>{row.match === "unresolved" ? <ResolveRow row={row} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ResolveRow({ row }: { row: CatalogReportRow }) {
  const { t } = useI18n();
  const resolve = useResolveCatalogRow();
  const errorText = useErrorText();
  const [catalogId, setCatalogId] = useState(row.candidates[0]?.catalogId ?? "");
  const [manualId, setManualId] = useState("");
  const target = manualId.trim() || catalogId;

  return (
    <div className="resolve-row">
      <Notice error={resolve.isError ? errorText(resolve.error) : null} onDismiss={() => resolve.reset()} />
      {row.candidates.length ? (
        <Select label={t("catalog.linkTo")} onChange={(e) => setCatalogId(e.target.value)} value={catalogId}>
          <option value="">{t("catalog.chooseAccount")}</option>
          {row.candidates.map((candidate) => (
            <option key={candidate.catalogId} value={candidate.catalogId}>
              {candidate.name}
              {candidate.email ? ` · ${candidate.email}` : ""}
            </option>
          ))}
        </Select>
      ) : (
        <p className="ui-field__hint">{t("catalog.noCandidates")}</p>
      )}
      <Input
        label={t("catalog.otherId")}
        maxLength={100}
        onChange={(e) => setManualId(e.target.value)}
        value={manualId}
      />
      <div className="resolve-row__actions">
        <Button
          disabled={!target}
          loading={resolve.isPending}
          onClick={() => resolve.mutate({ id: row.person.id, body: { action: "link", catalogId: target } })}
        >
          {t("catalog.link")}
        </Button>
        <Button
          onClick={() => {
            if (window.confirm(t("catalog.retireConfirm", { name: row.person.name }))) {
              resolve.mutate({ id: row.person.id, body: { action: "retire" } });
            }
          }}
          variant="secondary"
        >
          {t("catalog.retire")}
        </Button>
      </div>
    </div>
  );
}
