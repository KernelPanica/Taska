import { useEffect, useState } from "react";
import { FILE_KIND_KEYS, FILE_KINDS, type AttachmentSettings, type FileKind } from "@yourtask/contracts";
import { useAttachmentSettings, useUpdateAttachmentSettings } from "../../api/hooks";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Button, Card, Input } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "../directory/shared";

const MB = 1024 * 1024;

/** Лимиты вложений (R-2.24; YT-13): на файл, на тикет, на пространство и допустимые типы. Действуют сразу. */
export function AttachmentSettingsPage() {
  const { t } = useI18n();
  const settings = useAttachmentSettings();
  return (
    <section className="page">
      <PageHeader description={t("attachments.settingsLead")} title={t("attachments.settingsTitle")} />
      <ReadOnlyNote />
      {settings.isPending ? <Loading /> : null}
      {settings.isError ? <ErrorState error={settings.error} /> : null}
      {settings.data ? <SettingsForm settings={settings.data} /> : null}
    </section>
  );
}

function SettingsForm({ settings }: { settings: AttachmentSettings }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const save = useUpdateAttachmentSettings();
  const errorText = useErrorText();
  const toMb = (bytes: number) => String(Math.round((bytes / MB) * 100) / 100);
  const [file, setFile] = useState(toMb(settings.maxFileBytes));
  const [ticket, setTicket] = useState(toMb(settings.maxTicketBytes));
  const [space, setSpace] = useState(toMb(settings.maxSpaceBytes));
  const [allowed, setAllowed] = useState<string[]>(settings.allowed);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [file, ticket, space, allowed]);
  return (
    <Card>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            {
              maxFileBytes: Math.round(Number(file) * MB),
              maxTicketBytes: Math.round(Number(ticket) * MB),
              maxSpaceBytes: Math.round(Number(space) * MB),
              allowed: allowed as FileKind[],
            },
            { onSuccess: () => setSaved(true) },
          );
        }}
      >
        <Notice
          error={save.isError ? errorText(save.error) : null}
          message={saved ? t("common.saved") : null}
          onDismiss={() => {
            save.reset();
            setSaved(false);
          }}
        />
        <fieldset className="plain-fieldset form-stack" disabled={!isSuperadmin}>
          <div className="form-row">
            <Input
              label={t("attachments.maxFile")}
              min={0.01}
              onChange={(e) => setFile(e.target.value)}
              step="any"
              type="number"
              value={file}
            />
            <Input
              label={t("attachments.maxTicket")}
              min={0.01}
              onChange={(e) => setTicket(e.target.value)}
              step="any"
              type="number"
              value={ticket}
            />
            <Input
              label={t("attachments.maxSpace")}
              min={0.01}
              onChange={(e) => setSpace(e.target.value)}
              step="any"
              type="number"
              value={space}
            />
          </div>
          <CheckboxPicker
            label={t("attachments.allowed")}
            onChange={setAllowed}
            options={FILE_KIND_KEYS.map((kind) => ({
              id: kind,
              label: `${FILE_KINDS[kind].extensions.map((extension) => `.${extension}`).join(", ")}`,
              hint: t(`attachments.group.${FILE_KINDS[kind].group}` as MessageKey),
            }))}
            value={allowed}
          />
        </fieldset>
        {isSuperadmin ? (
          <div className="page-actions">
            <Button loading={save.isPending} type="submit">
              {t("common.save")}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
