/**
 * Схемы статусов и их правила (R-2.10, R-2.7, R-5.1; YT-05, docs/adr/0011).
 * Чистые функции: ими пользуются сервер (проверка переходов) и интерфейс (подсказки до отправки).
 */

export const STATUS_CATEGORIES = ["queue", "in_progress", "done"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Исход «отменено» есть у каждого типа: отмена доступна из любого статуса. */
export const CANCELLED_OUTCOME = "cancelled";

export interface Outcome {
  key: string;
  label: string;
}

export const DEFAULT_OUTCOMES: Outcome[] = [
  { key: "done", label: "Выполнено" },
  { key: CANCELLED_OUTCOME, label: "Отменено" },
];

export const RESPONSIBLE_ROLES = ["gd", "pm", "assignees", "tester"] as const;
export type ResponsibleRole = (typeof RESPONSIBLE_ROLES)[number];

/** Что должно быть заполнено на входе в статус. */
export type EntryRequirement =
  | { kind: "field"; fieldKey: string }
  | { kind: "people"; role: "assignees" | "customer" | "tester" }
  | { kind: "description" }
  | { kind: "checklist_done" };

export interface WorkflowStatus {
  id: string;
  name: string;
  category: StatusCategory;
  /** Статус-буфер: метрики видят простой, в WIP не считается. */
  waiting: boolean;
  /** Исходы, с которыми тикет может стоять в завершённом статусе. */
  outcomes: string[];
  requirements: EntryRequirement[];
  responsibleRoles: ResponsibleRole[];
  /** Требования заморожены: описание меняется только действием «Изменить требования» (YT-07). */
  freezeRequirements: boolean;
}

export interface StatusScheme {
  typeId: string;
  /** null — схема по умолчанию для всех пространств. */
  spaceId: string | null;
  /** У пространства нет своей схемы для типа — действует схема по умолчанию. */
  inherited: boolean;
  /** Строгий порядок: только на следующий статус или назад на любой. Иначе переходы свободные. */
  strictOrder: boolean;
  statuses: WorkflowStatus[];
}

export type WorkflowStatusInput = Omit<WorkflowStatus, "id"> & { id?: string | undefined };

export interface StatusSchemeInput {
  spaceId?: string | null;
  strictOrder: boolean;
  statuses: WorkflowStatusInput[];
}

export interface SchemeProblem {
  field: string;
  message: string;
}

/** Проверка схемы перед сохранением: категория, исходы у завершённых, место для отмены. */
export function validateScheme(
  scheme: { statuses: readonly Partial<WorkflowStatusInput>[] },
  typeOutcomes: readonly Outcome[],
): SchemeProblem[] {
  const problems: SchemeProblem[] = [];
  const known = new Set(typeOutcomes.map((outcome) => outcome.key));
  const names = new Set<string>();
  if (scheme.statuses.length === 0) problems.push({ field: "statuses", message: "a scheme needs at least one status" });
  scheme.statuses.forEach((status, index) => {
    const field = `statuses/${index}`;
    const name = status.name?.trim() ?? "";
    if (!name) problems.push({ field: `${field}/name`, message: "a status needs a name" });
    const key = name.toLocaleLowerCase("ru");
    if (name && names.has(key)) problems.push({ field: `${field}/name`, message: "status names must be unique" });
    names.add(key);
    if (!status.category || !STATUS_CATEGORIES.includes(status.category)) {
      problems.push({ field: `${field}/category`, message: "a status needs a category" });
    }
    const outcomes = status.outcomes ?? [];
    if (status.category === "done" && outcomes.length === 0) {
      problems.push({ field: `${field}/outcomes`, message: "a done status needs at least one outcome" });
    }
    if (status.category !== "done" && outcomes.length > 0) {
      problems.push({ field: `${field}/outcomes`, message: "only a done status has outcomes" });
    }
    for (const outcome of outcomes) {
      if (!known.has(outcome)) problems.push({ field: `${field}/outcomes`, message: `unknown outcome "${outcome}"` });
    }
  });
  if (!scheme.statuses.some((status) => status.category === "done" && status.outcomes?.includes(CANCELLED_OUTCOME))) {
    problems.push({
      field: "statuses",
      message: 'a done status with the outcome "cancelled" is required for cancelling',
    });
  }
  return problems;
}

/** Можно ли перейти из статуса в статус. Отмена — отдельное действие и разрешена всегда. */
export function canTransition(scheme: Pick<StatusScheme, "strictOrder" | "statuses">, fromId: string, toId: string) {
  const from = scheme.statuses.findIndex((status) => status.id === fromId);
  const to = scheme.statuses.findIndex((status) => status.id === toId);
  if (to < 0) return false;
  if (from < 0 || from === to) return from !== to;
  if (!scheme.strictOrder) return true;
  return to === from + 1 || to < from;
}

/** Куда ведёт отмена: первый завершённый статус, где разрешён исход «отменено». */
export function cancelTarget(scheme: Pick<StatusScheme, "statuses">) {
  return scheme.statuses.find((status) => status.category === "done" && status.outcomes.includes(CANCELLED_OUTCOME));
}

/** Тикет глазами проверки входа в статус. */
export interface RequirementSubject {
  values: Record<string, unknown>;
  description: string;
  checklist: readonly { done: boolean }[];
  people: { assignees: readonly unknown[]; customer: unknown; tester: unknown };
}

const filled = (value: unknown) =>
  value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);

/** Какие требования входа не выполнены. Пусто — можно входить. */
export function missingRequirements(status: Pick<WorkflowStatus, "requirements">, ticket: RequirementSubject) {
  return status.requirements.filter((requirement) => {
    switch (requirement.kind) {
      case "field":
        return !filled(ticket.values[requirement.fieldKey]);
      case "people":
        return requirement.role === "assignees"
          ? ticket.people.assignees.length === 0
          : !filled(ticket.people[requirement.role]);
      case "description":
        return !ticket.description.trim();
      case "checklist_done":
        return ticket.checklist.some((item) => !item.done);
    }
  });
}

export type StatusMapping = { kind: "name" | "category"; statusId: string } | { kind: "ask"; candidates: string[] };

/**
 * Перенос статуса при смене типа (R-2.7): по имени, иначе по категории;
 * если вариантов по категории несколько или ни одного — спросить человека.
 */
export function mapStatusOnTypeChange(
  current: Pick<WorkflowStatus, "name" | "category">,
  target: readonly Pick<WorkflowStatus, "id" | "name" | "category">[],
): StatusMapping {
  const name = current.name.trim().toLocaleLowerCase("ru");
  const byName = target.find((status) => status.name.trim().toLocaleLowerCase("ru") === name);
  if (byName) return { kind: "name", statusId: byName.id };
  const byCategory = target.filter((status) => status.category === current.category);
  if (byCategory.length === 1 && byCategory[0]) return { kind: "category", statusId: byCategory[0].id };
  return { kind: "ask", candidates: (byCategory.length ? byCategory : target).map((status) => status.id) };
}
