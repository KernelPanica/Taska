from django.db import migrations


def add_review_status(apps, schema_editor):
    Project = apps.get_model("projects", "Project")
    Status = apps.get_model("projects", "Status")
    for project in Project.objects.all():
        if Status.objects.filter(project=project, is_review=True).exists():
            continue
        Status.objects.filter(project=project, name="Done", category="done", position=2).update(
            position=3
        )
        name = "In review"
        while Status.objects.filter(project=project, name=name).exists():
            name += " ·"
        Status.objects.create(
            project=project, name=name, category="active", position=2, is_review=True
        )


class Migration(migrations.Migration):
    dependencies = [("projects", "0005_status_one_review_status_status_review_is_active")]
    operations = [migrations.RunPython(add_review_status, migrations.RunPython.noop)]
