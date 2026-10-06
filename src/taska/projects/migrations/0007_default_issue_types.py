from django.db import migrations


def add_missing_types(apps, schema_editor):
    Project = apps.get_model("projects", "Project")
    IssueType = apps.get_model("projects", "IssueType")
    for project in Project.objects.using(schema_editor.connection.alias).all():
        for name in ("Task", "Bug", "Request", "Story", "Epic"):
            IssueType.objects.using(schema_editor.connection.alias).get_or_create(
                project=project,
                name=name,
                defaults={"icon": "bug" if name == "Bug" else "issue"},
            )


class Migration(migrations.Migration):
    dependencies = [("projects", "0006_review_status")]
    operations = [migrations.RunPython(add_missing_types, migrations.RunPython.noop)]
