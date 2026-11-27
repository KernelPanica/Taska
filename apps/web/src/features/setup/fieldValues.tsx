import type { Dimension, FieldValue, TicketField } from "@yourtask/contracts";
import { useDimensions, useGroups, usePeople, useScales } from "../../api/hooks";
import { CheckboxPicker } from "../../components/CheckboxPicker";
import { Input, Select } from "../../components/ui";
import { useI18n } from "../../i18n";

/** Редактор значения поля по его виду: шаблоны (YT-04) и карточка тикета (YT-06). */
export function ValueEditor({
  field,
  value,
  onChange,
}: {
  field: TicketField;
  value: FieldValue;
  onChange(value: FieldValue): void;
}) {
  const { t } = useI18n();
  const scales = useScales();
  const dimensions = useDimensions();
  const people = usePeople();
  const teams = useGroups("feature-teams");
  const guilds = useGroups("guilds");
  const single = typeof value === "string" ? value : "";
  const many = Array.isArray(value) ? value : value ? [String(value)] : [];

  const choice = (options: { id: string; label: string }[], multiple: boolean) =>
    multiple ? (
      <CheckboxPicker label={field.name} onChange={(ids) => onChange(ids)} options={options} value={many} />
    ) : (
      <Select label={field.name} onChange={(e) => onChange(e.target.value || null)} value={single}>
        <option value="">{t("template.notSet")}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    );

  switch (field.kind) {
    case "text":
      return <Input label={field.name} onChange={(e) => onChange(e.target.value || null)} value={single} />;
    case "number":
      return (
        <Input
          label={field.name}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          type="number"
          value={typeof value === "number" ? value : ""}
        />
      );
    case "date":
      return <Input label={field.name} onChange={(e) => onChange(e.target.value || null)} type="date" value={single} />;
    case "list":
      return choice(field.options, field.multiple);
    case "person":
      return choice(
        (people.data?.items ?? []).map((person) => ({ id: person.id, label: person.name })),
        field.multiple,
      );
    case "estimate": {
      const scale = scales.data?.items.find((item) => item.id === field.scaleId);
      if (scale?.kind === "numeric") {
        return (
          <Input
            label={`${field.name}${scale.unit ? `, ${scale.unit}` : ""}`}
            min={0}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            step="0.5"
            type="number"
            value={typeof value === "number" ? value : ""}
          />
        );
      }
      return choice(
        (scale?.values ?? []).map((item) => ({ id: item.id, label: item.label })),
        false,
      );
    }
    case "dimension": {
      const dimension = dimensions.data?.items.find((item) => item.id === field.dimensionId);
      return choice(
        dimensionOptions(dimension, teams.data?.items ?? [], guilds.data?.items ?? []),
        Boolean(dimension?.multiple),
      );
    }
  }
}

export function dimensionOptions(
  dimension: Dimension | undefined,
  teams: { id: string; name: string }[],
  guilds: { id: string; name: string }[],
) {
  if (!dimension) return [];
  if (dimension.kind === "list") return dimension.options;
  return (dimension.source === "guilds" ? guilds : teams).map((group) => ({ id: group.id, label: group.name }));
}
