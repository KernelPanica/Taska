from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models, transaction
from django.db.models import F
from django.db.models.signals import post_delete
from django.dispatch import receiver
from django.utils.translation import gettext_lazy as _
from django.utils.translation import gettext_noop

DEFAULT_ISSUE_TYPES = (
    gettext_noop("Task"),
    gettext_noop("Bug"),
    gettext_noop("Request"),
    gettext_noop("Story"),
    gettext_noop("Epic"),
)


class Project(models.Model):
    key = models.CharField(
        _("Key"),
        max_length=12,
        unique=True,
        validators=[
            RegexValidator(
                r"^[A-Z][A-Z0-9]{1,11}$",
                _("Use 2–12 uppercase letters or digits, starting with a letter."),
            )
        ],
    )
    name = models.CharField(_("Name"), max_length=120)
    description = models.TextField(_("Description"), blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    next_issue_number = models.PositiveIntegerField(default=1, editable=False)
    version = models.PositiveIntegerField(default=1, editable=False)

    class Meta:
        ordering = ["name", "pk"]

    def __str__(self):
        return f"{self.key} · {self.name}"


class Membership(models.Model):
    class Role(models.TextChoices):
        MANAGER = "manager", _("Project manager")
        MEMBER = "member", _("Member")
        OBSERVER = "observer", _("Observer")

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    role = models.CharField(max_length=12, choices=Role, default=Role.MEMBER)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["project", "user"], name="unique_project_member")
        ]


class Status(models.Model):
    class Category(models.TextChoices):
        QUEUE = "queue", _("Queue")
        ACTIVE = "active", _("Active")
        DONE = "done", _("Done")

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="statuses")
    name = models.CharField(_("Name"), max_length=80)
    category = models.CharField(_("Category"), max_length=8, choices=Category)
    position = models.PositiveIntegerField(default=0)
    is_review = models.BooleanField(default=False)

    class Meta:
        ordering = ["position", "pk"]
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="unique_project_status"),
            models.UniqueConstraint(
                fields=["project"], condition=models.Q(is_review=True), name="one_review_status"
            ),
            models.CheckConstraint(
                condition=models.Q(is_review=False) | models.Q(category="active"),
                name="review_is_active",
            ),
        ]

    def __str__(self):
        return self.name

    def clean(self):
        if self.pk and self.issues.exclude(project_id=self.project_id).exists():
            raise ValidationError({"project": _("A status in use cannot move to another project.")})


class IssueType(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="issue_types")
    name = models.CharField(_("Name"), max_length=40)
    color = models.CharField(
        default="#74c7ec", max_length=7, validators=[RegexValidator(r"^#[0-9a-fA-F]{6}$")]
    )
    icon = models.CharField(
        max_length=20, default="issue", choices=[("issue", _("Issue")), ("bug", _("Bug"))]
    )

    class Meta:
        ordering = ["pk"]
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="unique_project_issue_type")
        ]

    def __str__(self):
        return self.name

    def clean(self):
        if self.pk and self.issue_set.exclude(project_id=self.project_id).exists():
            raise ValidationError(
                {"project": _("An issue type in use cannot move to another project.")}
            )


class Board(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="boards")
    name = models.CharField(_("Name"), max_length=120)

    class Meta:
        ordering = ["pk"]
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="unique_project_board")
        ]

    def __str__(self):
        return self.name


class Tag(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tags")
    name = models.CharField(max_length=40)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["project", "name"], name="unique_project_tag")
        ]

    def __str__(self):
        return self.name


class Issue(models.Model):
    class Priority(models.TextChoices):
        LOW = "low", _("Low")
        NORMAL = "normal", _("Normal")
        HIGH = "high", _("High")
        URGENT = "urgent", _("Urgent")

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="issues")
    number = models.PositiveIntegerField()
    title = models.CharField(_("Title"), max_length=200)
    description = models.TextField(_("Description"), blank=True)
    status = models.ForeignKey(Status, on_delete=models.PROTECT, related_name="issues")
    issue_type = models.ForeignKey(IssueType, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    estimate = models.PositiveIntegerField(_("Estimate"), null=True, blank=True)
    priority = models.CharField(
        _("Priority"), max_length=8, choices=Priority, default=Priority.NORMAL
    )
    start_date = models.DateField(_("Start date"), null=True, blank=True)
    due_date = models.DateField(_("Due date"), null=True, blank=True)
    tags = models.ManyToManyField(Tag, blank=True)
    assignees = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="assigned_issues"
    )
    customers = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="requested_issues"
    )
    watchers = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="watched_issues"
    )
    version = models.PositiveIntegerField(default=1, editable=False)
    position = models.PositiveIntegerField(default=0, editable=False)

    class Meta:
        ordering = ["number"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "number"], name="unique_project_issue_number"
            ),
            models.CheckConstraint(condition=models.Q(number__gte=1), name="positive_issue_number"),
        ]

    @property
    def reference(self):
        return f"{self.project.key}-{self.number}"

    def clean(self):
        errors = {}
        for field in ("status", "issue_type"):
            if getattr(self, f"{field}_id") and getattr(self, field).project_id != self.project_id:
                errors[field] = _("Choose a value from this project.")
        if self.start_date and self.due_date and self.due_date < self.start_date:
            errors["due_date"] = _("The due date cannot be earlier than the start date.")
        if errors:
            raise ValidationError(errors)

    @transaction.atomic
    def save(self, *args, **kwargs):
        if self._state.adding:
            projects = Project.objects.filter(pk=self.project_id)
            if self.number is None:
                projects.update(next_issue_number=F("next_issue_number") + 1)
                self.number = projects.get().next_issue_number - 1
            elif not projects.filter(next_issue_number__lte=self.number).update(
                next_issue_number=self.number + 1
            ):
                raise ValidationError(
                    {"number": _("This issue number has already been allocated.")}
                )
            self.position = next_issue_position(self.project_id, self.status_id)
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.reference}: {self.title}"


def next_issue_position(project_id, status_id):
    position = Issue.objects.filter(project_id=project_id, status_id=status_id).aggregate(
        value=models.Max("position")
    )["value"]
    return 0 if position is None else position + 1


class Comment(models.Model):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    body = models.TextField(max_length=50000)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["created_at", "pk"]


class Submission(models.Model):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="submissions")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    body = models.TextField(blank=True, max_length=50000)
    created_at = models.DateTimeField(auto_now_add=True)
    issue_version = models.PositiveIntegerField()
    decision = models.CharField(
        max_length=12,
        blank=True,
        choices=[("approved", _("Approved")), ("returned", _("Returned"))],
    )
    reviewer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="reviews"
    )
    decided_at = models.DateTimeField(null=True)

    class Meta:
        ordering = ["-created_at", "-pk"]


class Attachment(models.Model):
    submission = models.ForeignKey(Submission, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(upload_to="progress/")
    name = models.CharField(max_length=255)
    size = models.PositiveBigIntegerField()


class AssignmentRequest(models.Model):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="assignment_requests")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    state = models.CharField(
        max_length=12,
        default="pending",
        choices=[
            ("pending", _("Pending")),
            ("approved", _("Approved")),
            ("rejected", _("Rejected")),
        ],
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["issue", "user"],
                condition=models.Q(state="pending"),
                name="unique_pending_assignment",
            )
        ]


class Invitation(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE)
    email = models.EmailField()
    role = models.CharField(
        max_length=12, choices=[("member", _("Member")), ("observer", _("Observer"))]
    )
    token_hash = models.CharField(max_length=64, unique=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True)
    revoked = models.BooleanField(default=False)


class Notification(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="authored_notifications"
    )
    kind = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)
    read = models.BooleanField(default=False)

    class Meta:
        ordering = ["-created_at", "-pk"]


class Outbox(models.Model):
    notification = models.OneToOneField(Notification, on_delete=models.CASCADE, null=True)
    invitation = models.OneToOneField(Invitation, on_delete=models.CASCADE, null=True)
    invitation_token = models.CharField(max_length=100, blank=True)
    state = models.CharField(max_length=12, default="pending")
    attempts = models.PositiveIntegerField(default=0)
    available_at = models.DateTimeField()
    error = models.CharField(max_length=300, blank=True)


# Storage is private, but deleted tasks should not leave unreachable files behind.


@receiver(post_delete, sender=Attachment)
def delete_attachment_file(sender, instance, **kwargs):
    if instance.file.name:
        storage, name = instance.file.storage, instance.file.name
        transaction.on_commit(lambda: storage.delete(name), robust=True)


class Profile(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile"
    )
    bio = models.TextField(blank=True, max_length=1000)
    # Small normalized avatars live with the profile, inside the private database backup.
    avatar = models.BinaryField(blank=True, default=bytes)


class Relation(models.Model):
    class Kind(models.TextChoices):
        RELATED = "related", _("Related task")
        BLOCKS = "blocks", _("Blocks")
        PARENT = "parent", _("Parent of")

    source = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="outgoing_relations")
    target = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="incoming_relations")
    kind = models.CharField(max_length=12, choices=Kind)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(source=models.F("target")), name="relation_not_self"
            ),
            models.UniqueConstraint(fields=["source", "target"], name="unique_relation_pair"),
            models.UniqueConstraint(
                fields=["target"], condition=models.Q(kind="parent"), name="one_issue_parent"
            ),
        ]

    def clean(self):
        if not self.source_id or not self.target_id:
            return
        others = Relation.objects.exclude(pk=self.pk)
        if self.source_id == self.target_id:
            raise ValidationError(_("A task cannot link to itself."))
        if others.filter(
            models.Q(source_id=self.source_id, target_id=self.target_id)
            | models.Q(source_id=self.target_id, target_id=self.source_id)
        ).exists():
            raise ValidationError(_("These tasks are already linked. Edit the existing relation."))
        if self.kind == "parent":
            if others.filter(kind="parent", target_id=self.target_id).exists():
                raise ValidationError(_("This task already has a parent."))
            # ponytail: one graph query; use recursive SQL if the hierarchy outgrows memory.
            children = {}
            for parent, child in others.filter(kind="parent").values_list("source_id", "target_id"):
                children.setdefault(parent, []).append(child)
            pending, seen = [self.target_id], set()
            while pending:
                node = pending.pop()
                if node == self.source_id:
                    raise ValidationError(_("This relation would create a hierarchy cycle."))
                if node not in seen:
                    seen.add(node)
                    pending.extend(children.get(node, []))

    @transaction.atomic
    def save(self, *args, **kwargs):
        # SQLite serializes writes before graph validation, including cross-project cycles.
        Project.objects.filter(
            pk__in=Issue.objects.filter(pk__in=[self.source_id, self.target_id]).values(
                "project_id"
            )
        ).update(version=F("version") + 1)
        self.full_clean()
        return super().save(*args, **kwargs)
