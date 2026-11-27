import { Plus, TextT, X, SquaresFour } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  TQL_FIELDS,
  TQL_FUNCTIONS,
  TQL_PERSON_PARTS,
  checkTql,
  completeTql,
  operatorsFor,
  printExpr,
  printTql,
  printValue,
  tqlField,
  valueFromInput,
  vocabularyFor,
  type TqlCompletion,
  type TqlExpr,
  type TqlFieldInfo,
  type TqlOperator,
  type TqlOrder,
  type TqlProblem,
  type TqlQuery,
  type TqlVocabulary,
} from "@yourtask/contracts";
import { Button, Select } from "../../components/ui";
import { useI18n, type MessageKey } from "../../i18n";

/**
 * Редактор запроса TQL (R-2.28; YT-15, docs/adr/0021): конструктор из чипов (поле → оператор → значение)
 * и текст с автодополнением и подсветкой ошибок. Оба режима — над одним деревом запроса из общего
 * разборщика, поэтому переключение без потерь: чипы → текст → чипы дают то же дерево.
 */

// ---- Текст ошибки по коду: что не так и что сделать ----

export function useTqlProblemText() {
  const { t } = useI18n();
  return (problem: TqlProblem) =>
    t(`tql.error.${problem.code}` as MessageKey, {
      found: problem.found ?? "",
      suggestion: problem.suggestion ?? "",
      detail: problem.detail ?? "",
    }) +
    (problem.suggestion && problem.code !== "unquoted_text"
      ? ` ${t("tql.didYouMean", { suggestion: problem.suggestion })}`
      : "");
}

/** Строка запроса с подсвеченным местом ошибки. */
export function TqlProblemView({ text, problem }: { text: string; problem: TqlProblem }) {
  const describe = useTqlProblemText();
  const located = problem.end > problem.start;
  // Ошибка значения приходит с сервера без места: находим слово в тексте.
  let start = problem.start;
  let end = problem.end;
  if (!located && problem.found) {
    const at = text.toLowerCase().indexOf(problem.found.toLowerCase());
    if (at >= 0) {
      start = at;
      end = at + problem.found.length;
    }
  }
  const hasPlace = end > start;
  return (
    <div className="tql-error" role="alert">
      {hasPlace ? (
        <code className="tql-error__text">
          {text.slice(0, start)}
          <mark>{text.slice(start, end) || " "}</mark>
          {text.slice(end)}
        </code>
      ) : null}
      <span>{describe(problem)}</span>
    </div>
  );
}

// ---- Чипы: дерево запроса как группы условий ----

type Leaf = Extract<TqlExpr, { kind: "cond" } | { kind: "pred" }>;
export type ChipNode =
  | { id: string; kind: "leaf"; expr: Leaf; not: boolean }
  | { id: string; kind: "group"; op: "and" | "or"; items: ChipNode[]; paren: boolean; not: boolean };
type Group = Extract<ChipNode, { kind: "group" }>;

let nextId = 0;
const newId = () => `chip-${++nextId}`;

function toNode(expr: TqlExpr): ChipNode {
  switch (expr.kind) {
    case "cond":
    case "pred":
      return { id: newId(), kind: "leaf", expr, not: false };
    case "and":
    case "or":
      return { id: newId(), kind: "group", op: expr.kind, items: expr.items.map(toNode), paren: false, not: false };
    case "group": {
      const inner = expr.item;
      return inner.kind === "and" || inner.kind === "or"
        ? { id: newId(), kind: "group", op: inner.kind, items: inner.items.map(toNode), paren: true, not: false }
        : { id: newId(), kind: "group", op: "and", items: [toNode(inner)], paren: true, not: false };
    }
    case "not": {
      const node = toNode(expr.item);
      if (!node.not) return { ...node, not: true };
      return { id: newId(), kind: "group", op: "and", items: [node], paren: false, not: true };
    }
  }
}

function fromNode(node: ChipNode): TqlExpr {
  let core: TqlExpr;
  if (node.kind === "leaf") core = node.expr;
  else {
    core =
      node.items.length === 1 && !node.paren
        ? fromNode(node.items[0] as ChipNode)
        : { kind: node.op, items: node.items.map(fromNode) };
    if (node.paren)
      core = { kind: "group", item: node.items.length === 1 ? fromNode(node.items[0] as ChipNode) : core };
  }
  return node.not ? { kind: "not", item: core } : core;
}

/** Запрос → корневая группа чипов. */
export function toChips(query: TqlQuery): Group {
  if (!query.where) return { id: newId(), kind: "group", op: "and", items: [], paren: false, not: false };
  const node = toNode(query.where);
  if (node.kind === "group" && !node.paren && !node.not) return node;
  return { id: newId(), kind: "group", op: "and", items: [node], paren: false, not: false };
}

/** Корневая группа чипов → запрос. */
export function fromChips(root: Group, orderBy: TqlOrder[]): TqlQuery {
  return { where: root.items.length ? fromNode(root) : null, orderBy };
}

// ---- Редактор ----

export function QueryEditor({
  value,
  onChange,
  onSubmit,
  vocabulary,
}: {
  value: string;
  onChange(text: string): void;
  onSubmit(text: string): void;
  vocabulary: TqlVocabulary | undefined;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"chips" | "text">(() => {
    try {
      return localStorage.getItem("tql.mode") === "text" ? "text" : "chips";
    } catch {
      return "chips";
    }
  });
  const customFields = useMemo(() => (vocabulary?.customFields ?? []).map((field) => field.key), [vocabulary]);
  const checked = useMemo(() => checkTql(value, { customFields }), [value, customFields]);
  const switchTo = (next: "chips" | "text") => {
    setMode(next);
    try {
      localStorage.setItem("tql.mode", next);
    } catch {
      /* без хранилища режим просто не запоминается */
    }
  };
  const chipsBlocked = mode === "text" && !checked.ok && value.trim() !== "";

  return (
    <div className="query-editor">
      <div className="query-editor__modes" role="group" aria-label={t("tql.mode")}>
        <Button
          aria-pressed={mode === "chips"}
          disabled={chipsBlocked}
          onClick={() => switchTo("chips")}
          variant={mode === "chips" ? "secondary" : "ghost"}
        >
          <SquaresFour aria-hidden="true" size={16} /> {t("tql.chips")}
        </Button>
        <Button
          aria-pressed={mode === "text"}
          onClick={() => switchTo("text")}
          variant={mode === "text" ? "secondary" : "ghost"}
        >
          <TextT aria-hidden="true" size={16} /> {t("tql.text")}
        </Button>
        {chipsBlocked ? <span className="ui-field__hint">{t("tql.fixToChips")}</span> : null}
      </div>
      {mode === "chips" && checked.ok ? (
        <ChipsEditor onChange={(query) => onChange(printTql(query))} query={checked.query} vocabulary={vocabulary} />
      ) : (
        <TextEditor
          customFields={customFields}
          onChange={onChange}
          onSubmit={onSubmit}
          problem={!checked.ok && value.trim() ? checked.problem : null}
          value={value}
          vocabulary={vocabulary}
        />
      )}
    </div>
  );
}

function TextEditor({
  value,
  onChange,
  onSubmit,
  problem,
  vocabulary,
  customFields,
}: {
  value: string;
  onChange(text: string): void;
  onSubmit(text: string): void;
  problem: TqlProblem | null;
  vocabulary: TqlVocabulary | undefined;
  customFields: string[];
}) {
  const { t } = useI18n();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const completion = useMemo(
    () =>
      completeTql(value, cursor, {
        customFields,
        values: (field: TqlFieldInfo) => vocabularyFor(field, vocabulary),
      }),
    [value, cursor, customFields, vocabulary],
  );
  const items = completion.items.slice(0, 12);
  useEffect(() => setActive(0), [value, cursor]);

  const apply = (item: TqlCompletion) => {
    const next = value.slice(0, completion.replaceFrom) + item.insert + value.slice(cursor);
    const at = completion.replaceFrom + item.insert.length;
    onChange(next);
    setCursor(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const listShown = open && items.length > 0;
    if (listShown && event.key === "ArrowDown") {
      event.preventDefault();
      setActive((active + 1) % items.length);
    } else if (listShown && event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active - 1 + items.length) % items.length);
    } else if (listShown && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      apply(items[active] as TqlCompletion);
    } else if (event.key === "Escape" && listShown) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit(value);
    }
  };

  return (
    <div className="ui-field tql-text">
      <label className="ui-field__label" htmlFor={id}>
        {t("tql.query")}
      </label>
      <textarea
        aria-autocomplete="list"
        aria-controls={`${id}-list`}
        aria-describedby={`${id}-hint`}
        aria-expanded={open && items.length > 0}
        aria-invalid={problem ? true : undefined}
        className="ui-input tql-text__input"
        id={id}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          onChange(event.target.value);
          setCursor(event.target.selectionStart);
          setOpen(true);
        }}
        onClick={(event) => {
          setCursor(event.currentTarget.selectionStart);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            setCursor(event.currentTarget.selectionStart);
        }}
        placeholder="stream = GD or assignee.guild = GD"
        ref={area}
        rows={2}
        spellCheck={false}
        value={value}
      />
      {open && items.length ? (
        <ul className="tql-complete" id={`${id}-list`} role="listbox" aria-label={t("tql.suggestions")}>
          {items.map((item, index) => (
            <li
              aria-selected={index === active}
              className={index === active ? "is-active" : ""}
              key={`${item.kind}-${item.label}`}
              onMouseDown={(event) => {
                event.preventDefault();
                apply(item);
              }}
              role="option"
            >
              <span className={`tql-complete__kind tql-complete__kind--${item.kind}`}>
                {t(`tql.kind.${item.kind}` as MessageKey)}
              </span>
              <span>{item.label}</span>
              {item.detail ? <span className="ui-field__hint">{item.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="ui-field__hint" id={`${id}-hint`}>
        {t("tql.textHint")}
      </p>
      {problem ? <TqlProblemView problem={problem} text={value} /> : null}
    </div>
  );
}

// ---- Конструктор из чипов ----

function ChipsEditor({
  query,
  onChange,
  vocabulary,
}: {
  query: TqlQuery;
  onChange(query: TqlQuery): void;
  vocabulary: TqlVocabulary | undefined;
}) {
  const { t } = useI18n();
  // Дерево чипов живёт своим состоянием, пока его правят; текст снаружи — производное.
  const [root, setRoot] = useState<Group>(() => toChips(query));
  const [orderBy, setOrderBy] = useState<TqlOrder[]>(query.orderBy);
  const lastPrinted = useRef(printTql(query));
  useEffect(() => {
    const text = printTql(query);
    if (text !== lastPrinted.current) {
      lastPrinted.current = text;
      setRoot(toChips(query));
      setOrderBy(query.orderBy);
    }
  }, [query]);
  const commit = (nextRoot: Group, nextOrder = orderBy) => {
    setRoot(nextRoot);
    setOrderBy(nextOrder);
    const next = fromChips(nextRoot, nextOrder);
    lastPrinted.current = printTql(next);
    onChange(next);
  };
  const sortable = TQL_FIELDS.filter((field) => field.sortable);

  return (
    <div className="chips-editor">
      <GroupView group={root} isRoot onChange={(group) => commit(group)} vocabulary={vocabulary} />
      <div className="chips-order">
        <span className="ui-eyebrow">{t("tql.orderBy")}</span>
        {orderBy.map((item, index) => (
          <span className="chip" key={`${item.field}-${index}`}>
            {item.field} {item.dir}
            <button
              aria-label={t("tql.removeOrder", { field: item.field })}
              className="chip__remove"
              onClick={() =>
                commit(
                  root,
                  orderBy.filter((_, at) => at !== index),
                )
              }
              type="button"
            >
              <X aria-hidden="true" size={12} />
            </button>
          </span>
        ))}
        <select
          aria-label={t("tql.addOrder")}
          className="ui-select chips-order__add"
          onChange={(event) => {
            const [field, dir] = event.target.value.split(":") as [string, "asc" | "desc"];
            if (field) commit(root, [...orderBy, { field, dir }]);
            event.target.value = "";
          }}
          value=""
        >
          <option value="">{t("tql.addOrder")}</option>
          {sortable.flatMap((field) =>
            (["asc", "desc"] as const).map((dir) => (
              <option key={`${field.name}:${dir}`} value={`${field.name}:${dir}`}>
                {field.name} {dir}
              </option>
            )),
          )}
        </select>
      </div>
    </div>
  );
}

function GroupView({
  group,
  onChange,
  onRemove,
  vocabulary,
  isRoot = false,
}: {
  group: Group;
  onChange(group: Group): void;
  onRemove?: () => void;
  vocabulary: TqlVocabulary | undefined;
  isRoot?: boolean;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const set = (items: ChipNode[]) => onChange({ ...group, items });
  return (
    <div
      className={`chip-group ${isRoot ? "chip-group--root" : ""}`}
      role="group"
      aria-label={isRoot ? t("tql.conditions") : t("tql.group")}
    >
      {!isRoot ? (
        <label className="checkbox-inline chip-group__not">
          <input
            checked={group.not}
            onChange={(event) => onChange({ ...group, not: event.target.checked })}
            type="checkbox"
          />
          {t("tql.not")}
        </label>
      ) : null}
      {group.items.map((item, index) => (
        <span className="chip-group__item" key={item.id}>
          {index > 0 ? (
            <button
              aria-label={t("tql.switchLogic", { op: group.op === "and" ? t("tql.and") : t("tql.or") })}
              className="chip-logic"
              onClick={() => onChange({ ...group, op: group.op === "and" ? "or" : "and" })}
              type="button"
            >
              {group.op === "and" ? t("tql.and") : t("tql.or")}
            </button>
          ) : null}
          {item.kind === "group" ? (
            <GroupView
              group={item}
              onChange={(next) => set(group.items.map((entry) => (entry.id === item.id ? next : entry)))}
              onRemove={() => set(group.items.filter((entry) => entry.id !== item.id))}
              vocabulary={vocabulary}
            />
          ) : (
            <LeafChip
              node={item}
              onChange={(next) => set(group.items.map((entry) => (entry.id === item.id ? next : entry)))}
              onRemove={() => set(group.items.filter((entry) => entry.id !== item.id))}
              vocabulary={vocabulary}
            />
          )}
        </span>
      ))}
      {adding ? (
        <ConditionForm
          onCancel={() => setAdding(false)}
          onSave={(expr) => {
            setAdding(false);
            set([...group.items, { id: newId(), kind: "leaf", expr, not: false }]);
          }}
          vocabulary={vocabulary}
        />
      ) : (
        <span className="chip-group__actions">
          <Button onClick={() => setAdding(true)} variant="ghost">
            <Plus aria-hidden="true" size={14} /> {t("tql.addCondition")}
          </Button>
          <Button
            onClick={() =>
              set([
                ...group.items,
                {
                  id: newId(),
                  kind: "group",
                  op: group.op === "and" ? "or" : "and",
                  items: [],
                  paren: true,
                  not: false,
                },
              ])
            }
            variant="ghost"
          >
            <Plus aria-hidden="true" size={14} /> {t("tql.addGroup")}
          </Button>
          {onRemove ? (
            <Button aria-label={t("tql.removeGroup")} onClick={onRemove} variant="ghost">
              <X aria-hidden="true" size={14} />
            </Button>
          ) : null}
        </span>
      )}
    </div>
  );
}

function LeafChip({
  node,
  onChange,
  onRemove,
  vocabulary,
}: {
  node: Extract<ChipNode, { kind: "leaf" }>;
  onChange(node: ChipNode): void;
  onRemove(): void;
  vocabulary: TqlVocabulary | undefined;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const text = printExpr(node.not ? { kind: "not", item: node.expr } : node.expr);
  if (editing) {
    return (
      <ConditionForm
        initial={node.expr}
        initialNot={node.not}
        onCancel={() => setEditing(false)}
        onSave={(expr, not) => {
          setEditing(false);
          onChange({ ...node, expr, not });
        }}
        vocabulary={vocabulary}
      />
    );
  }
  return (
    <span className="chip">
      <button className="chip__body" onClick={() => setEditing(true)} title={t("tql.editCondition")} type="button">
        {text}
      </button>
      <button
        aria-label={t("tql.removeCondition", { condition: text })}
        className="chip__remove"
        onClick={onRemove}
        type="button"
      >
        <X aria-hidden="true" size={12} />
      </button>
    </span>
  );
}

const PREDICATES = TQL_FUNCTIONS.filter((fn) => fn.role === "predicate");

/** Условие чипом: поле → оператор → значение, или функция-условие (branch, causedBy…). */
function ConditionForm({
  initial,
  initialNot = false,
  onSave,
  onCancel,
  vocabulary,
}: {
  initial?: Leaf;
  initialNot?: boolean;
  onSave(expr: Leaf, not: boolean): void;
  onCancel(): void;
  vocabulary: TqlVocabulary | undefined;
}) {
  const { t } = useI18n();
  const listId = useId();
  const fieldNames = useMemo(
    () => [
      ...TQL_FIELDS.map((field) => field.name),
      ...TQL_FIELDS.filter((field) => field.kind === "person" && !field.pending).flatMap((field) =>
        Object.keys(TQL_PERSON_PARTS).map((part) => `${field.name}.${part}`),
      ),
      ...(vocabulary?.customFields ?? [])
        .map((field) => field.key)
        .filter((key) => !TQL_FIELDS.some((field) => field.name.toLowerCase() === key.toLowerCase())),
    ],
    [vocabulary],
  );
  const [subject, setSubject] = useState(
    initial ? (initial.kind === "cond" ? initial.field : `fn:${initial.name}`) : "",
  );
  const [op, setOp] = useState<TqlOperator>(initial?.kind === "cond" ? initial.op : "=");
  const [input, setInput] = useState(() => {
    if (!initial) return "";
    if (initial.kind === "pred") return initial.args.map(printValue).join(", ");
    if (initial.values) return initial.values.map(printValue).join(", ");
    return initial.value ? (initial.value.kind === "string" ? initial.value.text : printValue(initial.value)) : "";
  });
  const [not, setNot] = useState(initialNot);
  const isFunction = subject.startsWith("fn:");
  const field: TqlFieldInfo | null =
    isFunction || !subject ? null : (tqlField(subject) ?? { name: subject, kind: "custom" });
  const operators = field ? operatorsFor(field) : [];
  useEffect(() => {
    if (field && !operators.includes(op)) setOp(operators[0] as TqlOperator);
  }, [subject]);
  const needsValue = !isFunction && op !== "is empty" && op !== "is not empty";
  const suggestions = field ? vocabularyFor(field, vocabulary) : [];
  const parts = input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const ready =
    Boolean(subject) &&
    (!needsValue || parts.length > 0) &&
    (!isFunction || parts.length >= (PREDICATES.find((fn) => `fn:${fn.name}` === subject)?.required ?? 0));

  const save = () => {
    if (!ready) return;
    if (isFunction) {
      onSave({ kind: "pred", name: subject.slice(3), args: parts.map(valueFromInput) }, not);
      return;
    }
    const name = field?.name ?? subject;
    if (!needsValue) onSave({ kind: "cond", field: name, op }, not);
    else if (op === "in" || op === "not in")
      onSave({ kind: "cond", field: name, op, values: parts.map(valueFromInput) }, not);
    else onSave({ kind: "cond", field: name, op, value: valueFromInput(input) }, not);
  };

  return (
    <span className="chip-form" role="group" aria-label={t("tql.condition")}>
      <label className="checkbox-inline">
        <input checked={not} onChange={(event) => setNot(event.target.checked)} type="checkbox" />
        {t("tql.not")}
      </label>
      <Select label={t("tql.field")} onChange={(event) => setSubject(event.target.value)} value={subject}>
        <option value="">{t("tql.chooseField")}</option>
        <optgroup label={t("tql.fields")}>
          {fieldNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("tql.functions")}>
          {PREDICATES.map((fn) => (
            <option key={fn.name} value={`fn:${fn.name}`}>
              {fn.name}()
            </option>
          ))}
        </optgroup>
      </Select>
      {field ? (
        <Select label={t("tql.operator")} onChange={(event) => setOp(event.target.value as TqlOperator)} value={op}>
          {operators.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      ) : null}
      {needsValue || isFunction ? (
        <span className="ui-field">
          <label className="ui-field__label" htmlFor={`${listId}-value`}>
            {isFunction ? t("tql.arguments") : op === "in" || op === "not in" ? t("tql.values") : t("tql.value")}
          </label>
          <input
            className="ui-input"
            id={`${listId}-value`}
            list={suggestions.length ? listId : undefined}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
            placeholder={isFunction ? "AOS-201" : (suggestions[0]?.name ?? "")}
            value={input}
          />
          {suggestions.length ? (
            <datalist id={listId}>
              {suggestions.map((item) => (
                <option key={item.name} label={item.label} value={item.name} />
              ))}
            </datalist>
          ) : null}
        </span>
      ) : null}
      <Button disabled={!ready} onClick={save}>
        {t("common.save")}
      </Button>
      <Button onClick={onCancel} variant="ghost">
        {t("common.cancel")}
      </Button>
    </span>
  );
}
