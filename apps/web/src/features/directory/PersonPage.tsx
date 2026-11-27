import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LOCALES, type CatalogProfile, type Locale, type Person } from "@yourtask/contracts";
import { Eye, SignOut } from "@phosphor-icons/react";
import { useGroups, useLens, useLogout, useMe, usePerson, useUpdatePerson } from "../../api/hooks";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Badge, Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, ReadOnlyNote, useErrorText, useIsSuperadmin } from "./shared";

/**
 * Карточка человека (R-2.15, YT-03): профиль из каталога YourSpace только для показа
 * (чувствительные поля — маской) и то, что ведёт YourTask: язык, норма WIP, колодцы, команды.
 */
export function PersonPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const person = usePerson(id);
  return (
    <section className="page">
      <PageHeader back="/people" title={person.data?.name ?? t("people.title")} />
      {me.data?.user.id === id ? (
        <div className="page-actions">
          <LanguageSwitcher />
          <Notice error={logout.isError ? errorText(logout.error) : null} onDismiss={() => logout.reset()} />
          <Button
            loading={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSuccess: () => navigate("/login", { replace: true }) })}
            variant="ghost"
          >
            <SignOut aria-hidden="true" size={20} />
            {t("shell.signOut")}
          </Button>
        </div>
      ) : null}
      {person.isPending ? <Loading /> : null}
      {person.isError ? <ErrorState error={person.error} /> : null}
      {person.data ? (
        <div className="person-layout">
          <CatalogCard person={person.data} />
          <PersonForm key={person.data.id} person={person.data} />
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, children, locked = false }: { label: string; children: ReactNode; locked?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="fields__row">
      <dt>{label}</dt>
      <dd>
        {children ?? "—"}
        {locked ? <span className="fields__lock"> · {t("people.hidden")}</span> : null}
      </dd>
    </div>
  );
}

function CatalogCard({ person }: { person: Person }) {
  const { t, locale } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const me = useMe();
  const lens = useLens();
  const profile: CatalogProfile | null = person.catalog;
  return (
    <Card className="person-card">
      <div className="person-card__head">
        <h2>{t("people.profile")}</h2>
        {person.deactivated ? <Badge variant="warning">{t("people.deactivated")}</Badge> : null}
        {isSuperadmin && !person.deactivated && me.data?.user.id !== person.id ? (
          <Button
            loading={lens.on.isPending}
            onClick={() => lens.on.mutate({ kind: "person", id: person.id })}
            variant="secondary"
          >
            <Eye aria-hidden="true" size={16} /> {t("lens.viewAsPerson")}
          </Button>
        ) : null}
      </div>
      {person.deactivated ? <p className="person-card__note">{t("people.deactivatedNote")}</p> : null}
      {!profile ? (
        <p className="ui-field__hint">
          {t("people.noCatalog")} {isSuperadmin ? <Link to="/people/catalog-report">{t("catalog.report")}</Link> : null}
        </p>
      ) : (
        <>
          <dl className="fields">
            <Field label={t("people.fullName")}>{profile.fullName ?? person.name}</Field>
            <Field label={t("people.nickname")}>{profile.nickname}</Field>
            <Field label={t("people.login")}>{profile.username}</Field>
            <Field label={t("people.email")}>{person.email}</Field>
            <Field label={t("people.telegram")}>
              {profile.telegram ? (
                <a href={`https://t.me/${profile.telegram.replace(/^@/, "")}`} rel="noreferrer" target="_blank">
                  {profile.telegram}
                </a>
              ) : null}
            </Field>
            <Field label={t("people.vk")}>{profile.vk}</Field>
            <Field label={t("people.city")}>
              {profile.city || profile.timezone ? `${profile.city ?? "—"} · ${profile.timezone ?? "—"}` : null}
            </Field>
            <Field label={t("people.roleTitle")}>{profile.roleTitle}</Field>
            <Field label={t("people.status")}>
              {profile.membershipStatus ? t(`people.status.${profile.membershipStatus}` as MessageKey) : null}
            </Field>
            <Field label={t("people.tenure")}>{profile.tenure}</Field>
            <Field label={t("people.availability")}>
              {profile.availabilityHours === null
                ? null
                : t("people.availabilityValue", { hours: profile.availabilityHours })}
            </Field>
            <Field label={t("people.logins")}>
              {profile.giteaLogin || profile.perforceLogin
                ? `${profile.giteaLogin ?? "—"} · ${profile.perforceLogin ?? "—"}`
                : null}
            </Field>
            <Field label={t("people.phone")} locked={profile.masked.phone !== null}>
              {profile.masked.phone}
            </Field>
            <Field label={t("people.extraEmail")} locked={profile.masked.extraEmail !== null}>
              {profile.masked.extraEmail}
            </Field>
            <Field label={t("people.birthDate")} locked={profile.masked.birthDate !== null}>
              {profile.masked.birthDate}
            </Field>
          </dl>
          <p className="ui-field__hint">{t("people.profileNote")}</p>
          <p className="person-card__links">
            <a href={profile.profileUrl} rel="noreferrer" target="_blank">
              {t("people.openProfile")}
            </a>
            <span className="ui-field__hint">
              {t("people.syncedAt", { time: new Date(profile.syncedAt).toLocaleString(locale) })}
            </span>
          </p>
        </>
      )}
    </Card>
  );
}

function PersonForm({ person }: { person: Person }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const update = useUpdatePerson();
  const errorText = useErrorText();
  const guilds = useGroups("guilds");
  const teams = useGroups("feature-teams");
  const [form, setForm] = useState(() => toForm(person));
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm(person)), [person]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const wip = form.wipLimit.trim();
    update.mutate(
      {
        id: person.id,
        body: {
          locale: form.locale,
          wipLimit: wip === "" ? null : Number(wip),
          guildIds: form.guildIds,
          teamIds: form.teamIds,
        },
      },
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <Card>
      <h2>{t("people.inYourTask")}</h2>
      <ReadOnlyNote />
      <Notice
        error={update.isError ? errorText(update.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          update.reset();
          setSaved(false);
        }}
      />
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={!isSuperadmin}>
          <Select
            label={t("people.locale")}
            onChange={(e) => setForm({ ...form, locale: e.target.value as Locale })}
            value={form.locale}
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {t(`language.${locale}`)}
              </option>
            ))}
          </Select>
          <Input
            hint={t("people.wipHint")}
            inputMode="numeric"
            label={t("people.wip")}
            max={1000}
            min={0}
            onChange={(e) => setForm({ ...form, wipLimit: e.target.value })}
            type="number"
            value={form.wipLimit}
          />
          <CheckboxPicker
            label={t("people.teams")}
            onChange={(teamIds) => setForm({ ...form, teamIds })}
            options={(teams.data?.items ?? []).map((team) => ({ id: team.id, label: team.name }))}
            value={form.teamIds}
          />
          <CheckboxPicker
            label={t("people.guilds")}
            onChange={(guildIds) => setForm({ ...form, guildIds })}
            options={(guilds.data?.items ?? []).map((guild) => ({ id: guild.id, label: guild.name }))}
            value={form.guildIds}
          />
        </fieldset>
        {isSuperadmin ? (
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("common.save")}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function toForm(person: Person) {
  return {
    locale: person.locale,
    wipLimit: person.wipLimit === null ? "" : String(person.wipLimit),
    guildIds: person.guilds.map((guild) => guild.id),
    teamIds: person.teams.map((team) => team.id),
  };
}
