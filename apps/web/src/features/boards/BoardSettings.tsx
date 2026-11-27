import { Plus, Trash as TrashIcon } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  BOARD_CHIPS,
  BOARD_LANES,
  BOARD_SORTS,
  type BoardChip,
  type BoardFilter,
  type BoardLanes,
  type BoardSort,
  type BoardZoneInput,
} from "@yourtask/contracts";
import { useDeleteBoard, useSetZones, useUpdateBoard, type LoadedBoard } from "../../api/boards";
import { useFields } from "../../api/hooks";
import { Button, Input, Select } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { useErrorText } from "../directory/shared";

/**
 * Настройка доски — у владельца (личная) или с правом «Настраивать доски пространства»:
 * фильтр, раскладка, сортировка, срок для завершённых, чипы и дерево зон (R-2.18, R-2.19).
 */
export function BoardSettings({ data, onClose }: { data: LoadedBoard; onClose(): void }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const { board } = data;
  const update = useUpdateBoard(board.id);
  const zonesSave = useSetZones(board.id);
  const remove = useDeleteBoard(board.id);
  const [name, setName] = useState(board.name);
  const [query, setQuery] = useState(board.query);
  const [lanes, setLanes] = useState<BoardLanes>(board.lanes);
  const [sort, setSort] = useState<BoardSort>(board.sort);
  const [doneDays, setDoneDays] = useState(String(board.doneDays));
  const [chips, setChips] = useState<BoardChip[]>(board.chips);
  const [tqlLanes, setTqlLanes] = useState<BoardFilter[]>(board.tqlLanes);
  const [tqlChips, setTqlChips] = useState<BoardFilter[]>(board.tqlChips);
  const fields = useFields();
  // Свои измерения (R-2.14): дорожки и чипы по любому из них.
  const dimensionFields = (fields.data?.items ?? []).filter(
    (field) => field.kind === "dimension" && field.key !== "team" && field.key !== "stream",
  );
  const [zones, setZones] = useState<(BoardZoneInput & { statusText: string })[]>(
    board.zones.map((zone) => ({ ...zone, statusText: zone.statuses.join(", ") })),
  );
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    update.mutate(
      { name, query, lanes, sort, doneDays: Number(doneDays) || 0, chips, tqlLanes, tqlChips },
      { onSuccess: () => setSaved(true) },
    );
  };
  const saveZones = () => {
    setSaved(false);
    zonesSave.mutate(
      zones.map(({ statusText, ...zone }) => ({
        ...zone,
        statuses: statusText
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        wipLimit: zone.wipLimit || null,
      })),
      { onSuccess: () => setSaved(true) },
    );
  };
  const patchZone = (index: number, patch: Partial<(typeof zones)[number]>) =>
    setZones(zones.map((zone, at) => (at === index ? { ...zone, ...patch } : zone)));

  return (
    <section aria-label={t("board.settings")} className="board-settings">
      <form className="board-settings__form" onSubmit={submit}>
        <Input label={t("board.name")} onChange={(event) => setName(event.target.value)} required value={name} />
        <Input
          error={update.isError ? errorText(update.error) : undefined}
          hint={t("board.queryHint")}
          label={t("board.query")}
          onChange={(event) => setQuery(event.target.value)}
          value={query}
        />
        <Select label={t("board.lanes")} onChange={(event) => setLanes(event.target.value as BoardLanes)} value={lanes}>
          {BOARD_LANES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`board.lanes.${mode}` as MessageKey)}
            </option>
          ))}
          {dimensionFields.map((field) => (
            <option key={field.key} value={`field:${field.key}`}>
              {t("board.lanes.byField", { name: field.name })}
            </option>
          ))}
        </Select>
        <Select label={t("board.sort")} onChange={(event) => setSort(event.target.value as BoardSort)} value={sort}>
          {BOARD_SORTS.map((mode) => (
            <option key={mode} value={mode}>
              {t(`board.sort.${mode}` as MessageKey)}
            </option>
          ))}
        </Select>
        <Input
          hint={t("board.doneDaysHint")}
          label={t("board.doneDays")}
          min={0}
          onChange={(event) => setDoneDays(event.target.value)}
          type="number"
          value={doneDays}
        />
        <fieldset className="board-settings__chips">
          <legend>{t("board.chipsLegend")}</legend>
          {BOARD_CHIPS.map((chip) => (
            <label key={chip}>
              <input
                checked={chips.includes(chip)}
                onChange={(event) =>
                  setChips(event.target.checked ? [...chips, chip] : chips.filter((item) => item !== chip))
                }
                type="checkbox"
              />
              {t(`board.chips.${chip}` as MessageKey)}
            </label>
          ))}
          {dimensionFields.map((field) => {
            const chip = `field:${field.key}` as BoardChip;
            return (
              <label key={chip}>
                <input
                  checked={chips.includes(chip)}
                  onChange={(event) =>
                    setChips(event.target.checked ? [...chips, chip] : chips.filter((item) => item !== chip))
                  }
                  type="checkbox"
                />
                {field.name}
              </label>
            );
          })}
        </fieldset>
        <FilterList label={t("board.tqlLanes")} onChange={setTqlLanes} value={tqlLanes} />
        <FilterList label={t("board.tqlChips")} onChange={setTqlChips} value={tqlChips} />
        <div className="board-settings__actions">
          <Button loading={update.isPending} type="submit">
            {t("common.save")}
          </Button>
          <Button onClick={onClose} variant="ghost">
            {t("board.close")}
          </Button>
          {board.kind !== "mine" ? (
            <Button
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => navigate("/boards") })}
              variant="danger"
            >
              {t("board.delete")}
            </Button>
          ) : null}
          {saved ? <span role="status">{t("board.saved")}</span> : null}
        </div>
      </form>

      <div className="board-zones-editor">
        <h2>{t("board.zones")}</h2>
        <p className="board-hint">{t("board.zonesHint")}</p>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("board.zoneName")}</th>
              <th scope="col">{t("board.zoneParent")}</th>
              <th scope="col">{t("board.zoneStatuses")}</th>
              <th scope="col">{t("board.zoneWip")}</th>
              <th scope="col">
                <span className="vh">{t("common.delete")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {zones.map((zone, index) => (
              <tr key={zone.id}>
                <td>
                  <input
                    aria-label={t("board.zoneName")}
                    className="ui-input"
                    onChange={(event) => patchZone(index, { name: event.target.value })}
                    value={zone.name}
                  />
                </td>
                <td>
                  <select
                    aria-label={t("board.zoneParent")}
                    className="board-select"
                    onChange={(event) => patchZone(index, { parentId: event.target.value || null })}
                    value={zone.parentId ?? ""}
                  >
                    <option value="">{t("board.zoneRoot")}</option>
                    {zones
                      .filter((item) => item.id !== zone.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={t("board.zoneStatuses")}
                    className="ui-input"
                    onChange={(event) => patchZone(index, { statusText: event.target.value })}
                    value={zone.statusText}
                  />
                </td>
                <td>
                  <input
                    aria-label={t("board.zoneWip")}
                    className="ui-input board-zones-editor__wip"
                    min={1}
                    onChange={(event) => patchZone(index, { wipLimit: Number(event.target.value) || null })}
                    type="number"
                    value={zone.wipLimit ?? ""}
                  />
                </td>
                <td>
                  <button
                    aria-label={t("board.zoneRemove", { zone: zone.name })}
                    className="ui-icon-button"
                    onClick={() =>
                      setZones(
                        zones
                          .filter((_, at) => at !== index)
                          .map((item) => (item.parentId === zone.id ? { ...item, parentId: zone.parentId } : item)),
                      )
                    }
                    type="button"
                  >
                    <TrashIcon aria-hidden="true" size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {zonesSave.isError ? (
          <p className="ui-field__error" role="alert">
            {errorText(zonesSave.error)}{" "}
            {(zonesSave.error as { problem?: { errors?: { message: string }[] } }).problem?.errors
              ?.map((item) => item.message)
              .join("; ")}
          </p>
        ) : null}
        <div className="board-settings__actions">
          <Button
            onClick={() =>
              setZones([
                ...zones,
                {
                  id: `zone-${Date.now().toString(36)}`,
                  name: t("board.zoneNew"),
                  parentId: null,
                  statuses: [],
                  statusText: "",
                  wipLimit: null,
                },
              ])
            }
            variant="secondary"
          >
            <Plus aria-hidden="true" size={16} />
            {t("board.zoneAdd")}
          </Button>
          <Button loading={zonesSave.isPending} onClick={saveZones}>
            {t("board.zonesSave")}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Дорожки или чипы-фильтры TQL: название и запрос; запрос проверяет тот же разборщик при сохранении. */
function FilterList({
  label,
  value,
  onChange,
}: {
  label: string;
  value: BoardFilter[];
  onChange(next: BoardFilter[]): void;
}) {
  const { t } = useI18n();
  const patch = (index: number, change: Partial<BoardFilter>) =>
    onChange(value.map((item, at) => (at === index ? { ...item, ...change } : item)));
  return (
    <fieldset className="board-settings__filters">
      <legend>{label}</legend>
      {value.map((item, index) => (
        <div className="board-settings__filter" key={item.id}>
          <input
            aria-label={`${label}: ${t("board.filterName")}`}
            className="ui-input"
            onChange={(event) => patch(index, { name: event.target.value })}
            placeholder={t("board.filterName")}
            value={item.name}
          />
          <input
            aria-label={`${label}: ${t("board.filterQuery")}`}
            className="ui-input"
            onChange={(event) => patch(index, { query: event.target.value })}
            placeholder="priority = Urgent"
            value={item.query}
          />
          <button
            aria-label={t("board.filterRemove", { name: item.name })}
            className="ui-icon-button"
            onClick={() => onChange(value.filter((_, at) => at !== index))}
            type="button"
          >
            <TrashIcon aria-hidden="true" size={16} />
          </button>
        </div>
      ))}
      <Button
        onClick={() => onChange([...value, { id: `f-${Date.now().toString(36)}`, name: "", query: "" }])}
        variant="secondary"
      >
        <Plus aria-hidden="true" size={16} />
        {t("board.filterAdd")}
      </Button>
    </fieldset>
  );
}
