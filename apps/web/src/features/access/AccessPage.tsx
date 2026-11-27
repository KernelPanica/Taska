import { Copy, Eye, Trash } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  RIGHT_SCOPES,
  RIGHTS,
  type AccessGrant,
  type AccessProfile,
  type ProfileRights,
  type RightScope,
  type SubjectKind,
} from "@yourtask/contracts";
import {
  useCreateGrant,
  useCreateProfile,
  useDeleteGrant,
  useDeleteProfile,
  useDimensions,
  useGrants,
  useGroups,
  useLens,
  usePeople,
  useProfiles,
  useSecurityLog,
  useSpaces,
  useUpdateProfile,
} from "../../api/hooks";
import { Badge, Button, Card, Input, Select, Tabs } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n, type MessageKey } from "../../i18n";
import { Notice, PageHeader, useErrorText, useIsSuperadmin } from "../directory/shared";

/** Права (R-2.20, R-5.2; YT-08): профили, выдачи «кто × где × профиль», журнал безопасности. */
export function AccessPage() {
  const { t } = useI18n();
  if (!useIsSuperadmin()) {
    return (
      <section className="page">
        <PageHeader title={t("access.title")} />
        <p className="ui-field__hint">{t("access.superadminOnly")}</p>
      </section>
    );
  }
  return (
    <section className="page">
      <PageHeader description={t("access.lead")} title={t("access.title")} />
      <Tabs
        aria-label={t("access.title")}
        tabs={[
          { id: "profiles", label: t("access.profiles"), content: <Profiles /> },
          { id: "grants", label: t("access.grants"), content: <Grants /> },
          { id: "log", label: t("access.log"), content: <SecurityLog /> },
        ]}
      />
    </section>
  );
}

function Profiles() {
  const { t } = useI18n();
  const profiles = useProfiles();
  const create = useCreateProfile();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  if (profiles.isPending) return <Loading />;
  if (profiles.isError) return <ErrorState error={profiles.error} />;
  return (
    <div className="form-stack">
      <form
        className="inline-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!name.trim()) return;
          create.mutate(
            { name: name.trim(), rights: { view: ["all"], comment: ["all"] } },
            { onSuccess: (profile) => navigate(`/access/profiles/${profile.id}`) },
          );
        }}
      >
        <Input label={t("access.newProfile")} maxLength={120} onChange={(e) => setName(e.target.value)} value={name} />
        <Button loading={create.isPending} type="submit">
          {t("access.build")}
        </Button>
      </form>
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <ul className="access-profiles">
        {profiles.data.items.map((profile) => (
          <li key={profile.id}>
            <Link to={`/access/profiles/${profile.id}`}>{profile.name}</Link>
            {profile.system ? <Badge>{t("access.system")}</Badge> : <Badge variant="info">{t("access.custom")}</Badge>}
            <span className="ui-field__hint">
              {t("access.rightsCount", { count: Object.keys(profile.rights).length, total: RIGHTS.length })} ·{" "}
              {t("access.grantsCount", { count: profile.grants })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Конструктор профиля: для каждого права — где оно действует. Готовые профили правятся и копируются. */
export function ProfilePage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const profiles = useProfiles();
  const profile = profiles.data?.items.find((item) => item.id === id);
  if (profiles.isPending) return <Loading />;
  if (!profile) return <ErrorState error={profiles.error ?? new Error("not found")} />;
  return (
    <section className="page">
      <PageHeader back="/access" description={t("access.constructorLead")} title={profile.name} />
      <ProfileEditor key={profile.id} profile={profile} />
    </section>
  );
}

function ProfileEditor({ profile }: { profile: AccessProfile }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const update = useUpdateProfile(profile.id);
  const copy = useCreateProfile();
  const remove = useDeleteProfile();
  const { on } = useLens();
  const errorText = useErrorText();
  const [name, setName] = useState(profile.name);
  const [rights, setRights] = useState<ProfileRights>(profile.rights);
  const [saved, setSaved] = useState(false);
  useEffect(() => setRights(profile.rights), [profile.rights]);
  const toggle = (right: (typeof RIGHTS)[number], scope: RightScope, checked: boolean) => {
    setSaved(false);
    const current = new Set(rights[right] ?? []);
    if (checked) current.add(scope);
    else current.delete(scope);
    setRights({ ...rights, [right]: RIGHT_SCOPES.filter((item) => current.has(item)) });
  };
  const error = update.error ?? copy.error ?? remove.error;
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({ name, rights }, { onSuccess: () => setSaved(true) });
      }}
    >
      <Notice
        error={error ? errorText(error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          [update, copy, remove].forEach((mutation) => mutation.reset());
          setSaved(false);
        }}
      />
      <Input label={t("access.profileName")} maxLength={120} onChange={(e) => setName(e.target.value)} value={name} />
      <div className="table-scroll">
        <table className="data-table access-matrix">
          <caption className="visually-hidden">{t("access.matrixCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("access.right")}</th>
              {RIGHT_SCOPES.map((scope) => (
                <th key={scope} scope="col" title={t(`access.scopeHint.${scope}` as MessageKey)}>
                  {t(`access.scope.${scope}` as MessageKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RIGHTS.map((right) => (
              <tr key={right}>
                <th scope="row">{t(`access.right.${right}` as MessageKey)}</th>
                {RIGHT_SCOPES.map((scope) => (
                  <td key={scope}>
                    <input
                      aria-label={`${t(`access.right.${right}` as MessageKey)}: ${t(`access.scope.${scope}` as MessageKey)}`}
                      checked={(rights[right] ?? []).includes(scope)}
                      onChange={(e) => toggle(right, scope, e.target.checked)}
                      type="checkbox"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="page-actions">
        <Button loading={update.isPending} type="submit">
          {t("ticket.save")}
        </Button>
        <Button
          loading={copy.isPending}
          onClick={() =>
            copy.mutate(
              { name: t("access.copyName", { name: profile.name }), rights },
              { onSuccess: (created) => navigate(`/access/profiles/${created.id}`) },
            )
          }
          variant="secondary"
        >
          <Copy aria-hidden="true" size={16} /> {t("access.copy")}
        </Button>
        <Button onClick={() => on.mutate({ kind: "profile", id: profile.id })} variant="secondary">
          <Eye aria-hidden="true" size={16} /> {t("lens.viewAsRole")}
        </Button>
        {!profile.system ? (
          <Button
            disabled={profile.grants > 0}
            loading={remove.isPending}
            onClick={() => remove.mutate(profile.id, { onSuccess: () => navigate("/access") })}
            title={profile.grants > 0 ? t("access.deleteUsed") : undefined}
            variant="danger"
          >
            <Trash aria-hidden="true" size={16} /> {t("access.delete")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

const SUBJECTS: SubjectKind[] = ["everyone", "person", "team", "guild", "team_pm", "guild_lead"];

/** Текст выдачи: «ПМ команды Жабы × Производство × ПМ команды». */
export function useGrantText() {
  const { t } = useI18n();
  return {
    subject: (grant: AccessGrant) => {
      const kind = t(`access.subject.${grant.subject.kind}` as MessageKey);
      if (grant.subject.kind === "everyone") return kind;
      if (!grant.subject.id) return t(`access.subject.any.${grant.subject.kind}` as MessageKey);
      return `${kind}: ${grant.subject.name ?? "?"}`;
    },
    place: (grant: AccessGrant) =>
      [
        grant.place.spaceName ?? (grant.place.branchKey ? null : t("access.place.anySpace")),
        grant.place.branchKey
          ? t("access.place.branchOf", { key: grant.place.branchKey, title: grant.place.branchTitle ?? "" })
          : null,
        grant.place.fieldKey
          ? `${grant.place.fieldKey} = ${grant.place.fieldValueName ?? grant.place.fieldValue}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
  };
}

function Grants() {
  const { t } = useI18n();
  const grants = useGrants();
  const remove = useDeleteGrant();
  const text = useGrantText();
  const errorText = useErrorText();
  if (grants.isPending) return <Loading />;
  if (grants.isError) return <ErrorState error={grants.error} />;
  return (
    <div className="form-stack">
      <GrantForm />
      <Notice error={remove.isError ? errorText(remove.error) : null} onDismiss={() => remove.reset()} />
      {grants.data.items.length === 0 ? <p className="ui-field__hint">{t("access.noGrants")}</p> : null}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t("access.who")}</th>
              <th scope="col">{t("access.where")}</th>
              <th scope="col">{t("access.profile")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("access.revoke")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grants.data.items.map((grant) => (
              <tr key={grant.id}>
                <td>{text.subject(grant)}</td>
                <td>{text.place(grant)}</td>
                <td>{grant.profileName}</td>
                <td>
                  <Button
                    aria-label={t("access.revokeOne", { who: text.subject(grant), profile: grant.profileName })}
                    loading={remove.isPending && remove.variables === grant.id}
                    onClick={() => remove.mutate(grant.id)}
                    variant="ghost"
                  >
                    {t("access.revoke")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GrantForm() {
  const { t } = useI18n();
  const people = usePeople();
  const teams = useGroups("feature-teams");
  const guilds = useGroups("guilds");
  const spaces = useSpaces();
  const profiles = useProfiles();
  const dimensions = useDimensions();
  const create = useCreateGrant();
  const errorText = useErrorText();
  const [kind, setKind] = useState<SubjectKind>("everyone");
  const [subjectId, setSubjectId] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [branchKey, setBranchKey] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [profileId, setProfileId] = useState("profile-member");
  const [saved, setSaved] = useState(false);

  const subjects =
    kind === "person"
      ? (people.data?.items ?? []).map((item) => ({ id: item.id, name: item.name }))
      : kind === "team" || kind === "team_pm"
        ? (teams.data?.items ?? []).map((item) => ({ id: item.id, name: item.name }))
        : kind === "guild" || kind === "guild_lead"
          ? (guilds.data?.items ?? []).map((item) => ({ id: item.id, name: item.name }))
          : [];
  const dimension = dimensions.data?.items.find((item) => item.key === fieldKey);
  const values = !dimension
    ? []
    : dimension.kind === "list"
      ? dimension.options.map((option) => ({ id: option.id, name: option.label }))
      : ((dimension.source === "guilds" ? guilds.data?.items : teams.data?.items) ?? []).map((item) => ({
          id: item.id,
          name: item.name,
        }));

  return (
    <Card className="form-stack">
      <h2>{t("access.addGrant")}</h2>
      <Notice
        error={create.isError ? errorText(create.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          create.reset();
          setSaved(false);
        }}
      />
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              subject: { kind, id: kind === "everyone" ? null : subjectId || null },
              place: {
                spaceId: spaceId || null,
                branchKey: branchKey.trim() || null,
                fieldKey: fieldKey || null,
                fieldValue: fieldKey ? fieldValue || null : null,
              },
              profileId,
            },
            { onSuccess: () => setSaved(true) },
          );
        }}
      >
        <div className="form-row">
          <Select
            label={t("access.who")}
            onChange={(e) => {
              setKind(e.target.value as SubjectKind);
              setSubjectId("");
            }}
            value={kind}
          >
            {SUBJECTS.map((item) => (
              <option key={item} value={item}>
                {t(`access.subject.${item}` as MessageKey)}
              </option>
            ))}
          </Select>
          {kind !== "everyone" ? (
            <Select
              label={t("access.whoExactly")}
              onChange={(e) => setSubjectId(e.target.value)}
              required={kind === "person" || kind === "team" || kind === "guild"}
              value={subjectId}
            >
              <option value="">
                {kind === "team_pm" || kind === "guild_lead"
                  ? t(`access.subject.any.${kind}` as MessageKey)
                  : t("access.choose")}
              </option>
              {subjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <div className="form-row">
          <Select label={t("access.place.space")} onChange={(e) => setSpaceId(e.target.value)} value={spaceId}>
            <option value="">{t("access.place.anySpace")}</option>
            {(spaces.data?.items ?? []).map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </Select>
          <Input
            hint={t("access.place.branchHint")}
            label={t("access.place.branch")}
            maxLength={40}
            onChange={(e) => setBranchKey(e.target.value)}
            value={branchKey}
          />
        </div>
        <div className="form-row">
          <Select
            label={t("access.place.field")}
            onChange={(e) => {
              setFieldKey(e.target.value);
              setFieldValue("");
            }}
            value={fieldKey}
          >
            <option value="">{t("access.place.anyValue")}</option>
            {(dimensions.data?.items ?? []).map((item) => (
              <option key={item.id} value={item.key}>
                {item.name}
              </option>
            ))}
          </Select>
          {fieldKey ? (
            <Select
              label={t("access.place.value")}
              onChange={(e) => setFieldValue(e.target.value)}
              required
              value={fieldValue}
            >
              <option value="">{t("access.choose")}</option>
              {values.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <div className="form-row">
          <Select label={t("access.profile")} onChange={(e) => setProfileId(e.target.value)} value={profileId}>
            {(profiles.data?.items ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="page-actions">
          <Button loading={create.isPending} type="submit">
            {t("access.grant")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SecurityLog() {
  const { t, locale } = useI18n();
  const log = useSecurityLog();
  if (log.isPending) return <Loading />;
  if (log.isError) return <ErrorState error={log.error} />;
  if (!log.data.items.length) return <p className="ui-field__hint">{t("access.logEmpty")}</p>;
  return (
    <ol className="history-list">
      {log.data.items.map((event) => (
        <li key={event.id}>
          <span className="history-list__when">
            {new Date(event.at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })} · {event.actorName}
          </span>
          <span className="history-list__what">
            {t(`access.action.${event.action}` as MessageKey)}{" "}
            <code className="access-log__detail">{JSON.stringify(event.detail)}</code>
          </span>
        </li>
      ))}
    </ol>
  );
}
