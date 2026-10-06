from django import forms
from django.db import transaction
from django.db.models import F
from django.utils.translation import gettext_lazy as _

from .models import Issue, IssueType, Tag, next_issue_position


class ConflictError(Exception):
    pass


class IssueForm(forms.ModelForm):
    tag_names = forms.CharField(
        label=_("Tags"),
        required=False,
        max_length=820,
        help_text=_("Separate tags with commas. Up to 20 tags, 40 characters each."),
    )
    expected_version = forms.IntegerField(widget=forms.HiddenInput, min_value=1, required=False)

    class Meta:
        model = Issue
        fields = [
            "title",
            "description",
            "issue_type",
            "status",
            "priority",
            "estimate",
            "start_date",
            "due_date",
            "tag_names",
            "expected_version",
        ]
        labels = {"issue_type": _("Issue type"), "status": _("Status")}
        widgets = {
            "description": forms.Textarea(attrs={"rows": 10, "maxlength": 50000}),
            "start_date": forms.DateInput(attrs={"type": "date"}, format="%Y-%m-%d"),
            "due_date": forms.DateInput(attrs={"type": "date"}, format="%Y-%m-%d"),
        }

    def __init__(self, *args, project, user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.instance.project = project
        self.user = user
        self.fields["description"].max_length = 50000
        self.fields["status"].queryset = project.statuses.filter(
            category__in=["queue", "active"], is_review=False
        )
        if not self.instance.pk:
            self.fields["status"].queryset = project.statuses.filter(category="queue")
        self.fields["issue_type"].queryset = project.issue_types.all()
        for name in ("status", "issue_type", "priority"):
            self.fields[name].required = False
        self.fields["expected_version"].required = bool(self.instance.pk)
        if self.instance.pk:
            self.fields["title"].widget.attrs["form"] = "issue-edit-form"
            self.initial["expected_version"] = self.instance.version
            self.initial["tag_names"] = ", ".join(self.instance.tags.values_list("name", flat=True))

    def clean_description(self):
        value = self.cleaned_data["description"]
        if len(value) > 50000:
            raise forms.ValidationError(_("Keep the description under 50,000 characters."))
        return value

    def clean_status(self):
        status = (
            self.cleaned_data["status"]
            or self.fields["status"].queryset.filter(category="queue").first()
        )
        if not status:
            raise forms.ValidationError(
                _("Ask an administrator to configure a queue status first.")
            )
        return status

    def clean_issue_type(self):
        kind = self.cleaned_data["issue_type"] or self.fields["issue_type"].queryset.first()
        if not kind:
            raise forms.ValidationError(_("Create an issue type first."))
        return kind

    def clean_priority(self):
        return self.cleaned_data["priority"] or Issue.Priority.NORMAL

    def clean_tag_names(self):
        names = list(
            dict.fromkeys(
                name.strip() for name in self.cleaned_data["tag_names"].split(",") if name.strip()
            )
        )
        if len(names) > 20 or any(len(name) > 40 for name in names):
            raise forms.ValidationError(_("Use at most 20 tags, with at most 40 characters each."))
        return names

    @transaction.atomic
    def save(self):
        from django.core.exceptions import ObjectDoesNotExist, PermissionDenied, ValidationError

        from .workflow import (
            can_edit_issue,
            lock_project,
            notify,
            require_manager,
            validate_edit_status,
        )

        lock_project(self.instance.project)
        issue = super().save(commit=False)
        # Choices were validated before taking the write lock; configuration may have changed.
        try:
            issue.status = issue.project.statuses.get(pk=issue.status_id)
            issue.issue_type = issue.project.issue_types.get(pk=issue.issue_type_id)
        except ObjectDoesNotExist:
            raise ValidationError(_("Choose a value from this project.")) from None
        if self.user:
            if issue.pk:
                current = (
                    Issue.objects.select_related("status", "project").filter(pk=issue.pk).first()
                )
                if current is None:
                    raise ConflictError
                if not can_edit_issue(self.user, current):
                    raise PermissionDenied
                validate_edit_status(self.user, current, issue.status)
            else:
                require_manager(self.user, issue.project)
                validate_edit_status(self.user, issue, issue.status, creating=True)
        if issue.pk:
            values = {
                field: getattr(issue, field)
                for field in self.Meta.fields
                if field not in ("tag_names", "expected_version")
            }
            current_status = (
                Issue.objects.filter(pk=issue.pk).values_list("status_id", flat=True).first()
            )
            if current_status != issue.status_id:
                values["position"] = next_issue_position(issue.project_id, issue.status_id)
            values["version"] = F("version") + 1
            if not Issue.objects.filter(
                pk=issue.pk, version=self.cleaned_data["expected_version"]
            ).update(**values):
                raise ConflictError
        else:
            issue.save()
        issue.tags.set(
            [
                Tag.objects.get_or_create(project=issue.project, name=name)[0]
                for name in self.cleaned_data["tag_names"]
            ]
        )
        if self.user:
            notify(issue, self.user, "updated")
        return issue


class IssueTypeForm(forms.ModelForm):
    class Meta:
        model = IssueType
        fields = ["name", "color", "icon"]
        labels = {"color": _("Color"), "icon": _("Icon")}
        widgets = {"color": forms.TextInput(attrs={"type": "color"})}
