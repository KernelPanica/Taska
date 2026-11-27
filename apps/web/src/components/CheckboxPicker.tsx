import { useId, useState } from "react";
import { useI18n } from "../i18n";

export interface PickerOption {
  id: string;
  label: string;
  hint?: string | undefined;
}

interface CheckboxPickerProps {
  label: string;
  options: PickerOption[];
  value: string[];
  onChange(value: string[]): void;
  disabled?: boolean;
}

/** Множественный выбор с поиском: составы, колодцы и команды человека. */
export function CheckboxPicker({ label, options, value, onChange, disabled = false }: CheckboxPickerProps) {
  const { t } = useI18n();
  const id = useId();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLocaleLowerCase();
  const visible = needle
    ? options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLocaleLowerCase().includes(needle))
    : options;
  const selected = new Set(value);

  return (
    <fieldset className="picker" disabled={disabled}>
      <legend className="ui-field__label">
        {label} <span className="picker__count">{t("common.selected", { count: value.length })}</span>
      </legend>
      {options.length > 8 ? (
        <input
          aria-label={`${label}: ${t("common.filter")}`}
          className="ui-input picker__filter"
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("common.filter")}
          type="search"
          value={filter}
        />
      ) : null}
      <ul className="picker__list">
        {visible.map((option) => (
          <li key={option.id}>
            <label className="picker__option" htmlFor={`${id}-${option.id}`}>
              <input
                checked={selected.has(option.id)}
                id={`${id}-${option.id}`}
                onChange={(event) =>
                  onChange(event.target.checked ? [...value, option.id] : value.filter((item) => item !== option.id))
                }
                type="checkbox"
              />
              <span>{option.label}</span>
              {option.hint ? <span className="picker__hint">{option.hint}</span> : null}
            </label>
          </li>
        ))}
        {visible.length === 0 ? <li className="picker__empty">{t("common.nothingFound")}</li> : null}
      </ul>
    </fieldset>
  );
}
