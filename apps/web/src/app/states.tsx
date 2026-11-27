import { CircleNotch } from "@phosphor-icons/react";
import { ApiError } from "../api/client";
import { Button, Card } from "../components/ui";
import { useI18n } from "../i18n";

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="loading-screen" role="status">
      <CircleNotch aria-hidden="true" className="ui-spinner" size={24} />
      <span>{t("common.loading")}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const code = error instanceof ApiError ? error.code : "internal_error";
  return (
    <Card className="error-state" role="alert">
      <h2>{code === "not_found" ? t("error.notFound") : t("error.title")}</h2>
      <p>{t(`error.${code}`)}</p>
      {error instanceof ApiError && error.problem?.requestId ? (
        <p className="ui-field__hint">ID: {error.problem.requestId}</p>
      ) : null}
      {onRetry && code !== "not_found" ? <Button onClick={onRetry}>{t("common.retry")}</Button> : null}
    </Card>
  );
}
