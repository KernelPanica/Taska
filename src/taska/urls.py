from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path

from taska.projects import team_views as team
from taska.projects import views as projects
from taska.projects.board_views import board_action
from taska.projects.relation_views import relation_action
from taska.todos import views

urlpatterns = [
    path(
        "projects/<str:key>/issues/<int:number>/relations/", relation_action, name="relation-action"
    ),
    path("projects/<str:key>/board/action/", board_action, name="board-action"),
    path("projects/", projects.project_list, name="projects"),
    path("projects/<str:key>/", projects.project_board, name="project-board"),
    path("projects/<str:key>/issues/<int:number>/", projects.issue_detail, name="issue-detail"),
    path("projects/<str:key>/issues/new/", projects.issue_edit, name="issue-create"),
    path("projects/<str:key>/issues/<int:number>/edit/", projects.issue_edit, name="issue-edit"),
    path(
        "projects/<str:key>/issues/<int:number>/delete/", projects.issue_delete, name="issue-delete"
    ),
    path("projects/<str:key>/types/", projects.issue_types, name="issue-types"),
    path("boards/", projects.board_list, name="boards"),
    path("api/projects/", projects.api_projects, name="api-projects"),
    path("api/projects/<str:key>/", projects.api_projects, name="api-project"),
    path(
        "api/projects/<str:key>/issues/",
        projects.api_projects,
        {"resource": "issues"},
        name="api-issues",
    ),
    path("i18n/", include("django.conf.urls.i18n")),
    path("", team.my_tasks, name="todos"),
    path("profile/", team.profile, name="profile"),
    path("people/<int:pk>/", team.profile, name="person-profile"),
    path("people/<int:pk>/avatar/", team.avatar, name="person-avatar"),
    path("notifications/", team.notifications, name="notifications"),
    path("invitations/<str:token>/", team.invite_accept, name="invite-accept"),
    path("attachments/<int:pk>/", team.attachment_download, name="attachment-download"),
    path("projects/<str:key>/team/", team.team, name="project-team"),
    path("projects/<str:key>/statuses/", team.statuses, name="project-statuses"),
    path("projects/<str:key>/issues/<int:number>/action/", team.issue_action, name="issue-action"),
    path("login/", auth_views.LoginView.as_view(), name="login"),
    path("logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("admin/", admin.site.urls),
    path("health", views.health, name="health"),
]
