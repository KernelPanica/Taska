from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import DatabaseError
from django.test import TestCase

from .models import Todo


class RetiredTodoTests(TestCase):
    def test_old_records_remain_private_but_routes_are_retired(self):
        user = get_user_model().objects.create_user("old-owner")
        item = Todo.objects.create(owner=user, title="Private old task")
        self.assertRedirects(self.client.get("/"), "/login/?next=/")
        self.assertNotContains(self.client.get("/login/"), "Private old task")
        self.client.force_login(user)
        self.assertNotContains(self.client.get("/"), "Private old task")
        for path in ["/roadmap/", f"/todos/{item.pk}/edit/", f"/todos/{item.pk}/delete/"]:
            self.assertEqual(self.client.get(path).status_code, 404)
        self.assertTrue(Todo.objects.filter(pk=item.pk).exists())
        self.client.logout()
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})

    def test_health_failure_does_not_expose_database_details(self):
        with patch(
            "taska.todos.views.connection.cursor", side_effect=DatabaseError("private detail")
        ):
            response = self.client.get("/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable"})
