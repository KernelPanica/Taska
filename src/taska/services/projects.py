from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from taska.constants import (
    APPLICATION_PENDING,
    BLOCKING_ASSIGNEE_STATUSES,
    PM_POSITION_PREFIX,
    TASK_STATUS_IN_PROGRESS,
    TASK_STATUS_UNASSIGNED,
)
from taska.models.project import Project, Task, TaskApplication, task_required_tags
from taska.models.tag import Tag
from taska.models.user import User
from taska.utils.datetime import utc_now


def is_pm(user: User) -> bool:
    if user.is_admin:
        return True
    return bool(user.position_code and user.position_code.startswith(PM_POSITION_PREFIX))


def list_projects(db: Session) -> list[Project]:
    return list(
        db.scalars(
            select(Project)
            .where(Project.is_active.is_(True))
            .options(selectinload(Project.tasks))
            .order_by(Project.name)
        ).all()
    )


def get_project(db: Session, project_id: int) -> Project | None:
    return db.scalar(
        select(Project)
        .where(Project.id == project_id)
        .options(
            selectinload(Project.tasks).selectinload(Task.required_tags),
            selectinload(Project.tasks).selectinload(Task.assignee),
            selectinload(Project.tasks).selectinload(Task.applications),
        )
    )


def get_task(db: Session, task_id: int) -> Task | None:
    return db.scalar(
        select(Task)
        .where(Task.id == task_id)
        .options(
            selectinload(Task.project),
            selectinload(Task.required_tags),
            selectinload(Task.assignee),
            selectinload(Task.applications).selectinload(TaskApplication.user),
            selectinload(Task.creator),
        )
    )


def create_project(db: Session, pm: User, *, name: str, description: str) -> Project:
    if not is_pm(pm):
        raise ValueError("Создавать проекты могут только PM")

    project = Project(
        name=name.strip(),
        description=description.strip(),
        created_by_id=pm.id,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def create_task(
    db: Session,
    pm: User,
    project: Project,
    *,
    title: str,
    description: str,
    enforce_single_task: bool,
    required_tag_ids: list[int],
) -> Task:
    if not is_pm(pm):
        raise ValueError("Создавать задачи могут только PM")

    task = Task(
        project_id=project.id,
        title=title.strip(),
        description=description.strip(),
        created_by_id=pm.id,
        status=TASK_STATUS_UNASSIGNED,
        enforce_single_task=enforce_single_task,
    )
    db.add(task)
    db.flush()

    if required_tag_ids:
        tags = list(db.scalars(select(Tag).where(Tag.id.in_(required_tag_ids))).all())
        task.required_tags = tags

    db.commit()
    db.refresh(task)
    return task


def user_has_required_tags(user: User, task: Task) -> bool:
    if not task.required_tags:
        return True
    user_tag_ids = {tag.id for tag in user.tags}
    return all(tag.id in user_tag_ids for tag in task.required_tags)


def user_has_blocking_task(db: Session, user_id: int) -> bool:
    blocking = db.scalar(
        select(Task.id)
        .where(Task.assignee_id == user_id, Task.status.in_(BLOCKING_ASSIGNEE_STATUSES))
        .limit(1)
    )
    return blocking is not None


def apply_for_task(db: Session, user: User, task: Task) -> TaskApplication:
    if user.is_admin:
        raise ValueError("Администратор не может подавать заявки на задачи")

    if task.status != TASK_STATUS_UNASSIGNED:
        raise ValueError("Заявку можно подать только на задачу в статусе «Не назначена»")

    if task.assignee_id is not None:
        raise ValueError("Задача уже назначена")

    if not user_has_required_tags(user, task):
        raise ValueError("У вас нет всех требуемых тегов для этой задачи")

    if task.enforce_single_task and user_has_blocking_task(db, user.id):
        raise ValueError("У вас уже есть активная задача. Завершите или приостановите её")

    existing = db.scalar(
        select(TaskApplication).where(
            TaskApplication.task_id == task.id,
            TaskApplication.user_id == user.id,
            TaskApplication.status == APPLICATION_PENDING,
        )
    )
    if existing is not None:
        raise ValueError("Вы уже подали заявку на эту задачу")

    application = TaskApplication(task_id=task.id, user_id=user.id, status=APPLICATION_PENDING)
    db.add(application)
    db.commit()
    db.refresh(application)
    return application


def approve_application(db: Session, pm: User, application: TaskApplication) -> Task:
    if not is_pm(pm):
        raise ValueError("Подтверждать заявки могут только PM")

    if application.status != APPLICATION_PENDING:
        raise ValueError("Заявка уже обработана")

    task = get_task(db, application.task_id)
    if task is None:
        raise ValueError("Задача не найдена")

    if task.status != TASK_STATUS_UNASSIGNED:
        raise ValueError("Задача уже не в статусе «Не назначена»")

    applicant = db.get(User, application.user_id)
    if applicant is None:
        raise ValueError("Участник не найден")

    if not user_has_required_tags(applicant, task):
        raise ValueError("У участника нет требуемых тегов")

    if task.enforce_single_task and user_has_blocking_task(db, applicant.id):
        raise ValueError("У участника уже есть активная задача")

    task.assignee_id = applicant.id
    task.status = TASK_STATUS_IN_PROGRESS
    application.status = "approved"
    application.reviewed_by_id = pm.id
    application.reviewed_at = utc_now()

    db.commit()
    db.refresh(task)
    return task


def reject_application(db: Session, pm: User, application: TaskApplication) -> None:
    if not is_pm(pm):
        raise ValueError("Отклонять заявки могут только PM")

    if application.status != APPLICATION_PENDING:
        raise ValueError("Заявка уже обработана")

    application.status = "rejected"
    application.reviewed_by_id = pm.id
    application.reviewed_at = utc_now()
    db.commit()


def update_task_status(db: Session, pm: User, task: Task, new_status: str) -> Task:
    if not is_pm(pm):
        raise ValueError("Менять статус могут только PM")

    from taska.constants import TASK_STATUSES

    if new_status not in TASK_STATUSES:
        raise ValueError("Неизвестный статус")

    task.status = new_status
    if new_status == TASK_STATUS_UNASSIGNED:
        task.assignee_id = None
    task.updated_at = utc_now()
    db.commit()
    db.refresh(task)
    return task


def pending_applications_for_task(db: Session, task_id: int) -> list[TaskApplication]:
    return list(
        db.scalars(
            select(TaskApplication)
            .where(TaskApplication.task_id == task_id, TaskApplication.status == APPLICATION_PENDING)
            .options(selectinload(TaskApplication.user))
            .order_by(TaskApplication.created_at)
        ).all()
    )
