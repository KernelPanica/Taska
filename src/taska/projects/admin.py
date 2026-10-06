from django.contrib import admin

from .models import DEFAULT_ISSUE_TYPES, Board, IssueType, Membership, Outbox, Project


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ["key", "name"]
    inlines = [MembershipInline]

    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser

    def get_readonly_fields(self, request, obj=None):
        # The project key is part of every permanent issue reference and URL.
        return ["key"] if obj else []

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        if not change:
            from .models import Status

            for position, (name, category, review) in enumerate(
                [
                    ("To do", "queue", False),
                    ("In progress", "active", False),
                    ("In review", "active", True),
                    ("Done", "done", False),
                ]
            ):
                Status.objects.create(
                    project=obj, name=name, category=category, is_review=review, position=position
                )
            for name in DEFAULT_ISSUE_TYPES:
                IssueType.objects.create(
                    project=obj, name=name, icon="bug" if name == "Bug" else "issue"
                )
            Board.objects.create(project=obj, name="Team board")


@admin.register(Outbox)
class OutboxAdmin(admin.ModelAdmin):
    list_display = ["id", "state", "attempts", "available_at", "error"]
    list_filter = ["state"]
    fields = ["state", "attempts", "available_at", "error"]
    readonly_fields = fields

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


admin.site.register([Board, IssueType])
