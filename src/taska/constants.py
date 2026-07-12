TASK_STATUS_UNASSIGNED = "unassigned"
TASK_STATUS_IN_PROGRESS = "in_progress"
TASK_STATUS_IN_REVIEW = "in_review"
TASK_STATUS_PAUSED = "paused"
TASK_STATUS_NEEDS_CHANGES = "needs_changes"
TASK_STATUS_DONE = "done"
TASK_STATUS_CLOSED = "closed"

TASK_STATUSES: dict[str, str] = {
    TASK_STATUS_UNASSIGNED: "Не назначена",
    TASK_STATUS_IN_PROGRESS: "В работе",
    TASK_STATUS_IN_REVIEW: "На проверке",
    TASK_STATUS_PAUSED: "Приостановлена",
    TASK_STATUS_NEEDS_CHANGES: "Требует изменений",
    TASK_STATUS_DONE: "Готово",
    TASK_STATUS_CLOSED: "Закрыта",
}

# Статусы, при которых исполнитель занят и не может взять другую задачу
BLOCKING_ASSIGNEE_STATUSES = {
    TASK_STATUS_IN_PROGRESS,
    TASK_STATUS_IN_REVIEW,
    TASK_STATUS_NEEDS_CHANGES,
}

APPLICATION_PENDING = "pending"
APPLICATION_APPROVED = "approved"
APPLICATION_REJECTED = "rejected"

PM_POSITION_PREFIX = "PM-"
