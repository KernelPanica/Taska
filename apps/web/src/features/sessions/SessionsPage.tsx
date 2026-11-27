import { useState } from "react";
import { useRevokeOtherSessions, useRevokeSession, useSessions } from "../../api/hooks";
import { Badge, Button, Card, Toast } from "../../components/ui";
import { useI18n } from "../../i18n";
import { ErrorState, Loading } from "../../app/states";

export function SessionsPage() {
  const { t, locale } = useI18n();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const [notice, setNotice] = useState<string | null>(null);
  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const others = sessions.data?.items.filter((item) => !item.current).length ?? 0;

  return (
    <section className="page">
      <header className="page-heading">
        <h1>{t("sessions.title")}</h1>
        <p>{t("sessions.description")}</p>
      </header>
      {notice ? (
        <Toast dismissLabel={t("common.dismiss")} onDismiss={() => setNotice(null)} title={notice} variant="success" />
      ) : null}
      {sessions.isPending ? <Loading /> : null}
      {sessions.isError ? <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} /> : null}
      {sessions.data ? (
        <>
          <ul className="session-list">
            {sessions.data.items.map((session) => (
              <li key={session.id}>
                <Card className="session-card">
                  <div className="session-card__main">
                    <strong>{session.userAgent ?? t("sessions.unknownDevice")}</strong>
                    <span>
                      {t(`sessions.method.${session.method}`)}
                      {session.ip ? ` · ${session.ip}` : ""} · {t("sessions.lastSeen")}:{" "}
                      {format.format(new Date(session.lastSeenAt))}
                    </span>
                    <span className="session-card__badges">
                      {session.current ? <Badge variant="success">{t("sessions.current")}</Badge> : null}
                      {session.mfa ? <Badge variant="info">{t("sessions.mfa")}</Badge> : null}
                    </span>
                  </div>
                  {session.current ? null : (
                    <Button
                      loading={revoke.isPending && revoke.variables === session.id}
                      onClick={() => revoke.mutate(session.id, { onSuccess: () => setNotice(t("sessions.revoked")) })}
                      variant="danger"
                    >
                      {t("sessions.revoke")}
                    </Button>
                  )}
                </Card>
              </li>
            ))}
          </ul>
          {others > 0 ? (
            <Button
              loading={revokeOthers.isPending}
              onClick={() =>
                revokeOthers.mutate(undefined, {
                  onSuccess: (result) => setNotice(t("sessions.revokedOthers", { count: result.revoked })),
                })
              }
              variant="secondary"
            >
              {t("sessions.revokeOthers")}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
