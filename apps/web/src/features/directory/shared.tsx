import { ArrowLeft } from "@phosphor-icons/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../api/client";
import { useMe } from "../../api/hooks";
import { Button, Input, Toast } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";

export function useIsSuperadmin() {
  return useMe().data?.user.role === "superadmin";
}

/** Текст ошибки API по коду + поля из `errors`. */
export function useErrorText() {
  const { t } = useI18n();
  return (error: unknown) => {
    if (!(error instanceof ApiError)) return t("error.internal_error");
    const fields = error.problem?.errors?.map((item) => item.field).join(", ");
    return `${t(`error.${error.code}` as MessageKey)}${fields ? ` (${fields})` : ""}`;
  };
}

export function PageHeader({ title, description, back }: { title: string; description?: string; back?: string }) {
  const { t } = useI18n();
  return (
    <>
      {back ? (
        <Link className="back-link" to={back}>
          <ArrowLeft aria-hidden="true" size={16} />
          {t("common.back")}
        </Link>
      ) : null}
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
    </>
  );
}

export function ReadOnlyNote() {
  const { t } = useI18n();
  return useIsSuperadmin() ? null : <p className="ui-field__hint">{t("common.readOnly")}</p>;
}

/** Компактная форма «название + Создать» над списком справочника. */
export function QuickCreate({
  label,
  submitLabel,
  onCreate,
  pending,
  extra,
}: {
  label: string;
  submitLabel: string;
  onCreate(name: string, reset: () => void): void;
  pending: boolean;
  extra?: ReactNode;
}) {
  const [name, setName] = useState("");
  if (!useIsSuperadmin()) return null;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim(), () => setName(""));
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <Input label={label} maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
      {extra}
      <Button loading={pending} type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}

export function Notice({
  message,
  error,
  onDismiss,
}: {
  message?: string | null;
  error?: string | null;
  onDismiss(): void;
}) {
  const { t } = useI18n();
  if (error) return <Toast dismissLabel={t("common.dismiss")} onDismiss={onDismiss} title={error} variant="danger" />;
  if (message)
    return <Toast dismissLabel={t("common.dismiss")} onDismiss={onDismiss} title={message} variant="success" />;
  return null;
}
