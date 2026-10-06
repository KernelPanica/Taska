from django import forms
from django.contrib.auth import get_user_model
from django.contrib.auth.forms import UserCreationForm
from django.core.exceptions import ValidationError
from django.db.models import Q
from django.utils.translation import gettext_lazy as _

from .models import Status


class VersionForm(forms.Form):
    version = forms.IntegerField(min_value=1, widget=forms.HiddenInput)


class PersonField(forms.ModelMultipleChoiceField):
    def label_from_instance(self, person):
        return f"{person.get_full_name() or person.username} ({person.username}) · {person.email}"


class ParticipantsForm(VersionForm):
    assignees = PersonField(queryset=None, required=False, label=_("Assignees"))
    customers = PersonField(queryset=None, required=False, label=_("Customers"))
    watchers = PersonField(queryset=None, required=False, label=_("Watchers"))

    def __init__(self, *args, issue, **kwargs):
        super().__init__(*args, **kwargs)
        users = (
            get_user_model()
            .objects.filter(membership__project=issue.project, is_active=True)
            .distinct()
            .order_by("username")
        )
        for name in ("assignees", "customers", "watchers"):
            self.fields[name].queryset = (
                users.filter(
                    membership__project=issue.project, membership__role__in=["member", "manager"]
                )
                if name == "assignees"
                else users
            )
            if name == "watchers":
                # Global admins can subscribe without joining the project. Keep that selection.
                self.fields[name].queryset = (
                    get_user_model()
                    .objects.filter(
                        Q(membership__project=issue.project)
                        | Q(pk__in=issue.watchers.values("pk"), is_superuser=True),
                        is_active=True,
                    )
                    .distinct()
                    .order_by("username")
                )
            self.initial[name] = getattr(issue, name).all()
        self.initial["version"] = issue.version


class ProgressForm(VersionForm):
    body = forms.CharField(
        label=_("Progress, links and reports"),
        required=False,
        max_length=50000,
        widget=forms.Textarea(attrs={"rows": 5}),
    )


class CommentForm(forms.Form):
    body = forms.CharField(
        label=_("Comment"), max_length=50000, widget=forms.Textarea(attrs={"rows": 4})
    )
    version = forms.IntegerField(required=False, min_value=1, widget=forms.HiddenInput)


class StatusForm(forms.ModelForm):
    version = forms.IntegerField(min_value=1, widget=forms.HiddenInput)

    class Meta:
        model = Status
        fields = ["name", "category", "is_review"]
        labels = {"is_review": _("Review status")}
        help_texts = {
            "is_review": _(
                "Reports submitted by assignees arrive in this column. A PM accepts the result or returns it to work. Only one active column can have this role."
            )
        }

    def clean(self):
        data = super().clean()
        if data.get("is_review") and data.get("category") != "active":
            raise ValidationError(_("The review status must be active."))
        return data


class InviteForm(forms.Form):
    email = forms.EmailField(label=_("Email"))
    role = forms.ChoiceField(
        label=_("Role"), choices=[("member", _("Member")), ("observer", _("Observer"))]
    )
    version = forms.IntegerField(min_value=1, widget=forms.HiddenInput)


class AcceptInvitationForm(UserCreationForm):
    class Meta(UserCreationForm.Meta):
        fields = ["username", "first_name", "last_name"]


class ProfileForm(forms.ModelForm):
    bio = forms.CharField(
        label=_("About me"),
        max_length=1000,
        required=False,
        widget=forms.Textarea(attrs={"rows": 3}),
    )
    avatar = forms.FileField(
        label=_("Avatar"),
        required=False,
        help_text=_("PNG, JPEG or WebP, up to 4 MiB."),
        widget=forms.FileInput(attrs={"accept": "image/png,image/jpeg,image/webp"}),
    )
    remove_avatar = forms.BooleanField(label=_("Remove avatar"), required=False)

    def clean_avatar(self):
        import io

        from PIL import Image, ImageOps, UnidentifiedImageError

        upload = self.cleaned_data["avatar"]
        if not upload:
            return None
        if upload.size > 4 * 1024 * 1024:
            raise ValidationError(_("Choose an image up to 4 MiB and 16 megapixels."))
        try:
            with Image.open(upload) as source:
                if (
                    source.format not in {"PNG", "JPEG", "WEBP"}
                    or source.width * source.height > 16000000
                ):
                    raise ValueError
                picture = ImageOps.exif_transpose(source)
                picture.thumbnail((256, 256))
                picture = picture.convert("RGBA")
                picture.info.clear()
                buffer = io.BytesIO()
                picture.save(buffer, format="PNG")
                return buffer.getvalue()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise ValidationError(_("Choose an image up to 4 MiB and 16 megapixels.")) from None

    class Meta:
        model = get_user_model()
        fields = ["first_name", "last_name", "email"]

    def clean_email(self):
        email = self.cleaned_data["email"].strip().lower()
        if (
            email
            and get_user_model()
            .objects.filter(email__iexact=email)
            .exclude(pk=self.instance.pk)
            .exists()
        ):
            raise ValidationError(_("This email is already in use."))
        return email
