import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BOARD_LANES, type BoardLanes } from "@yourtask/contracts";
import { useBoards, useCreateBoard } from "../../api/boards";
import { useSpaces } from "../../api/hooks";
import { ErrorState, Loading } from "../../app/states";
import { Button, Input, Select } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";
import { PageHeader, useErrorText } from "../directory/shared";

/** Все доски зрителя: личные (с «Мои задачи») и доски пространств; новая доска — фильтр TQL и раскладка. */
export function BoardsPage() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const boards = useBoards();
  const spaces = useSpaces();
  const create = useCreateBoard();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [lanes, setLanes] = useState<BoardLanes>("none");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name, query, spaceId: spaceId || null, lanes },
      { onSuccess: (board) => navigate(`/boards/${board.id}`) },
    );
  };
  const items = boards.data?.items ?? [];
  const personal = items.filter((item) => item.owner.kind === "person");
  const bySpace = items.filter((item) => item.owner.kind === "space");
  const label = (item: (typeof items)[number]) => (item.kind === "mine" ? t("boards.mine") : item.name);

  return (
    <section className="page">
      <PageHeader description={t("boards.lead")} title={t("boards.title")} />
      {boards.isPending ? <Loading /> : null}
      {boards.isError ? <ErrorState error={boards.error} /> : null}
      <div className="boards-list">
        <section>
          <h2>{t("boards.personal")}</h2>
          <ul>
            {personal.map((item) => (
              <li key={item.id}>
                <Link to={`/boards/${item.id}`}>{label(item)}</Link>
                <code>{item.query}</code>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2>{t("boards.spaceBoards")}</h2>
          {bySpace.length ? null : <p className="board-hint">{t("boards.noSpaceBoards")}</p>}
          <ul>
            {bySpace.map((item) => (
              <li key={item.id}>
                <Link to={`/boards/${item.id}`}>{item.name}</Link>
                <span className="board-hint">{item.owner.kind === "space" ? item.owner.spaceName : ""}</span>
                <code>{item.query}</code>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <form className="board-settings__form" onSubmit={submit}>
        <h2>{t("boards.new")}</h2>
        <Input label={t("board.name")} onChange={(event) => setName(event.target.value)} required value={name} />
        <Input
          error={create.isError ? errorText(create.error) : undefined}
          hint={t("boards.queryExample")}
          label={t("board.query")}
          onChange={(event) => setQuery(event.target.value)}
          value={query}
        />
        <Select label={t("boards.owner")} onChange={(event) => setSpaceId(event.target.value)} value={spaceId}>
          <option value="">{t("boards.ownerMe")}</option>
          {(spaces.data?.items ?? []).map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </Select>
        <Select label={t("board.lanes")} onChange={(event) => setLanes(event.target.value as BoardLanes)} value={lanes}>
          {BOARD_LANES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`board.lanes.${mode}` as MessageKey)}
            </option>
          ))}
        </Select>
        <div className="board-settings__actions">
          <Button loading={create.isPending} type="submit">
            {t("boards.createSubmit")}
          </Button>
        </div>
      </form>
    </section>
  );
}
