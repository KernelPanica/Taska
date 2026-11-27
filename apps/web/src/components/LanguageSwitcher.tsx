import { LOCALES, type Locale } from "@yourtask/contracts";
import { useI18n } from "../i18n";
import { useMe, useUpdateLocale } from "../api/hooks";

/** Переключатель RU ↔ EN. Для вошедшего пользователя язык сохраняется в профиле. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const me = useMe();
  const update = useUpdateLocale();

  function choose(next: Locale) {
    if (next === locale) return;
    setLocale(next);
    if (me.data) update.mutate(next);
  }

  return (
    <div aria-label={t("language.label")} className="language-switcher" role="group">
      {LOCALES.map((item) => (
        <button
          aria-pressed={item === locale}
          className={`language-switcher__option ${item === locale ? "is-active" : ""}`}
          key={item}
          lang={item}
          onClick={() => choose(item)}
          title={t(`language.${item}`)}
          type="button"
        >
          {item.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
