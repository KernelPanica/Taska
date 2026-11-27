import { Eye, EyeSlash, Presentation } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { Me } from "@yourtask/contracts";
import { useLens, useProfiles } from "../api/hooks";
import { useI18n } from "../i18n";
import { Button, Select } from "./ui";

/**
 * «Режим показа» (R-2.20): одно нажатие в шапке; роль выбирается один раз и запоминается.
 * Ограничение действует на сервере: пока режим включён, API отдаёт только то, что видит роль.
 */
export function ShowModeButton({ me }: { me: Me }) {
  const { t } = useI18n();
  const { on, off } = useLens();
  const [choosing, setChoosing] = useState(false);
  const profiles = useProfiles(choosing);
  const active = Boolean(me.lens);
  const busy = on.isPending || off.isPending;

  const control = useRef<HTMLDivElement>(null);
  const closeChooser = () => {
    setChoosing(false);
    queueMicrotask(() => control.current?.querySelector("button")?.focus());
  };

  return (
    <div className="lens-control" ref={control}>
      <Button
        aria-expanded={choosing}
        aria-label={active ? t("lens.off") : t("lens.showMode")}
        aria-pressed={active}
        className="lens-button"
        loading={busy}
        onClick={() => {
          if (active) off.mutate();
          else if (me.showProfileId) on.mutate({ kind: "profile", id: me.showProfileId, show: true });
          else setChoosing(!choosing);
        }}
        title={t("lens.showHint")}
        variant={active ? "primary" : "secondary"}
      >
        <Presentation aria-hidden="true" size={18} />
        <span className="lens-button__label">{active ? t("lens.off") : t("lens.showMode")}</span>
      </Button>
      {choosing ? (
        <div className="lens-choose">
          <Select
            autoFocus
            label={t("lens.chooseRole")}
            defaultValue=""
            disabled={busy}
            onBlur={(event) => {
              if (!control.current?.contains(event.relatedTarget)) setChoosing(false);
            }}
            onChange={(event) => {
              if (!event.target.value) return;
              on.mutate({ kind: "profile", id: event.target.value, show: true }, { onSettled: closeChooser });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeChooser();
              }
            }}
          >
            <option disabled value="">
              {t("lens.chooseRole")}
            </option>
            {(profiles.data?.items ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </div>
  );
}

/** Плашка «Режим показа: роль» / «Вы смотрите глазами: человек» — видна на каждом экране. */
export function LensBanner({ me }: { me: Me }) {
  const { t } = useI18n();
  const { on, off } = useLens();
  const profiles = useProfiles(Boolean(me.lens));
  if (!me.lens) return null;
  const lens = me.lens;
  return (
    <div className="lens-banner" role="status">
      {lens.kind === "person" ? <Eye aria-hidden="true" size={18} /> : <EyeSlash aria-hidden="true" size={18} />}
      <strong>
        {lens.show
          ? t("lens.showBanner", { name: lens.name })
          : lens.kind === "person"
            ? t("lens.viewPersonBanner", { name: lens.name })
            : t("lens.viewRoleBanner", { name: lens.name })}
      </strong>
      <span className="lens-banner__hint">{lens.kind === "person" ? t("lens.readOnly") : t("lens.showHint")}</span>
      {lens.kind === "profile" ? (
        <select
          aria-label={t("lens.changeRole")}
          className="ui-select lens-banner__select"
          onChange={(event) => on.mutate({ kind: "profile", id: event.target.value, show: lens.show })}
          value={lens.id}
        >
          {(profiles.data?.items ?? []).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      ) : null}
      <Button loading={off.isPending} onClick={() => off.mutate()} variant="secondary">
        {t("lens.off")}
      </Button>
    </div>
  );
}
