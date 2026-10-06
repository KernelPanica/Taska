from django.db import migrations
from django.db.models import Max


def initialize_counters(apps, schema_editor):
    Project = apps.get_model("projects", "Project")
    Issue = apps.get_model("projects", "Issue")
    for project in Project.objects.using(schema_editor.connection.alias).all():
        highest = (
            Issue.objects.using(schema_editor.connection.alias)
            .filter(project_id=project.pk)
            .aggregate(number=Max("number"))["number"]
            or 0
        )
        Project.objects.using(schema_editor.connection.alias).filter(pk=project.pk).update(
            next_issue_number=highest + 1
        )


class Migration(migrations.Migration):
    dependencies = [("projects", "0002_issue_due_date_issue_estimate_issue_priority_and_more")]
    operations = [migrations.RunPython(initialize_counters, migrations.RunPython.noop)]
