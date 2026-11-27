import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { PersonRef } from "@yourtask/contracts";
import {
  useCreateGroup,
  useDeleteGroup,
  useGroup,
  useGroups,
  usePeople,
  useUpdateGroup,
  type Group,
  type GroupKind,
} from "../../api/hooks";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Button, Card, Input, Select } from "../../components/ui";
import { ErrorState, Loading } from "../../app/states";
import { useI18n } from "../../i18n";
import { Notice, PageHeader, QuickCreate, ReadOnlyNote, useErrorText, useIsSuperadmin } from "./shared";

/** Колодцы (лид) и фичекоманды (ПМ) — одинаковые экраны с разными подписями. */
const TEXT = {
  guilds: {
    title: "guilds.title",
    description: "guilds.description",
    add: "guilds.add",
    head: "guilds.head",
    empty: "guilds.empty",
  },
  "feature-teams": {
    title: "teams.title",
    description: "teams.description",
    add: "teams.add",
    head: "teams.head",
    empty: "teams.empty",
  },
} as const;

const route = (kind: GroupKind) => (kind === "guilds" ? "/guilds" : "/teams");
const headOf = (group: Group): PersonRef | null => ("lead" in group ? group.lead : group.pm);
const headField = (kind: GroupKind) => (kind === "guilds" ? "leadId" : "pmId");

export function GroupsPage({ kind }: { kind: GroupKind }) {
  const { t } = useI18n();
  const text = TEXT[kind];
  const groups = useGroups(kind);
  const create = useCreateGroup(kind);
  const navigate = useNavigate();
  const errorText = useErrorText();

  return (
    <section className="page">
      <PageHeader description={t(text.description)} title={t(text.title)} />
      <ReadOnlyNote />
      <Notice error={create.isError ? errorText(create.error) : null} onDismiss={() => create.reset()} />
      <QuickCreate
        label={t("common.name")}
        onCreate={(name, reset) =>
          create.mutate({ name }, { onSuccess: (group) => (reset(), navigate(`${route(kind)}/${group.id}`)) })
        }
        pending={create.isPending}
        submitLabel={t(text.add)}
      />
      {groups.isPending ? <Loading /> : null}
      {groups.isError ? <ErrorState error={groups.error} onRetry={() => void groups.refetch()} /> : null}
      {groups.data?.items.length === 0 ? <Card className="empty-state">{t(text.empty)}</Card> : null}
      {groups.data?.items.length ? (
        <ul className="space-grid">
          {groups.data.items.map((group) => (
            <li key={group.id}>
              <Link className="ui-card space-card" to={`${route(kind)}/${group.id}`}>
                <strong>{group.name}</strong>
                <span className="data-table__sub">
                  {t(text.head)}: {headOf(group)?.name ?? t("groups.noHead")}
                </span>
                <span className="data-table__sub">{t("groups.membersCount", { count: group.members.length })}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function GroupPage({ kind }: { kind: GroupKind }) {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const group = useGroup(kind, id);
  return (
    <section className="page">
      <PageHeader back={route(kind)} title={group.data?.name ?? t(TEXT[kind].title)} />
      {group.isPending ? <Loading /> : null}
      {group.isError ? <ErrorState error={group.error} /> : null}
      {group.data ? <GroupForm group={group.data} key={group.data.id} kind={kind} /> : null}
    </section>
  );
}

function GroupForm({ kind, group }: { kind: GroupKind; group: Group }) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const people = usePeople();
  const update = useUpdateGroup(kind);
  const remove = useDeleteGroup(kind);
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [form, setForm] = useState(() => toForm(group));
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm(group)), [group]);

  // Назначать можно активных; уже назначенные деактивированные остаются в списке с пометкой.
  const head = headOf(group);
  const current = head ? [head, ...group.members] : group.members;
  const options = [
    ...(people.data?.items ?? []).map((person) => ({
      id: person.id,
      label: person.name,
      hint: person.email ?? undefined,
    })),
    ...current
      .filter((person) => person.deactivated)
      .map((person) => ({ id: person.id, label: `${person.name} · ${t("people.deactivated")}`, hint: undefined })),
  ].filter((option, index, all) => all.findIndex((item) => item.id === option.id) === index);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      {
        id: group.id,
        body: {
          name: form.name,
          key: form.key.trim() || null,
          [headField(kind)]: form.headId || null,
          memberIds: form.memberIds,
        },
      },
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <Card>
      <ReadOnlyNote />
      <Notice
        error={update.isError ? errorText(update.error) : remove.isError ? errorText(remove.error) : null}
        message={saved ? t("common.saved") : null}
        onDismiss={() => {
          update.reset();
          remove.reset();
          setSaved(false);
        }}
      />
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack" disabled={!isSuperadmin}>
          <Input
            label={t("common.name")}
            maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            value={form.name}
          />
          <Input
            hint={t("groups.keyHint")}
            label={t("groups.key")}
            maxLength={40}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            pattern="[A-Za-z][A-Za-z0-9_\-]*"
            value={form.key}
          />
          <Select
            label={t(TEXT[kind].head)}
            onChange={(e) => setForm({ ...form, headId: e.target.value })}
            value={form.headId}
          >
            <option value="">{t("common.none")}</option>
            {options.map((person) => (
              <option key={person.id} value={person.id}>
                {person.label}
              </option>
            ))}
          </Select>
          <CheckboxPicker
            label={t("groups.members")}
            onChange={(memberIds) => setForm({ ...form, memberIds })}
            options={options}
            value={form.memberIds}
          />
        </fieldset>
        {isSuperadmin ? (
          <div className="page-actions">
            <Button loading={update.isPending} type="submit">
              {t("common.save")}
            </Button>
            <Button
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm(`${t("common.delete")}: ${group.name}?`)) {
                  remove.mutate(group.id, { onSuccess: () => navigate(route(kind)) });
                }
              }}
              variant="danger"
            >
              {t("common.delete")}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

function toForm(group: Group) {
  return {
    name: group.name,
    key: group.key ?? "",
    headId: headOf(group)?.id ?? "",
    memberIds: group.members.map((member) => member.id),
  };
}
