"""SQLAlchemy data models for HORIZON."""
from datetime import datetime, timezone

from werkzeug.security import generate_password_hash, check_password_hash

from extensions import db


def now():
    return datetime.now(timezone.utc)


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    verified_at = db.Column(db.DateTime(timezone=True))
    theme = db.Column(db.String(20), default="light", nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Workspace(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    kind = db.Column(db.String(20), default="personal", nullable=False)
    owner_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)


class Membership(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    workspace_id = db.Column(db.Integer, db.ForeignKey("workspace.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    role = db.Column(db.String(20), default="member", nullable=False)
    __table_args__ = (db.UniqueConstraint("workspace_id", "user_id"),)


class Project(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    workspace_id = db.Column(
        db.Integer, db.ForeignKey("workspace.id"), nullable=False, index=True
    )
    name = db.Column(db.String(160), nullable=False)
    description = db.Column(db.Text, default="")
    color = db.Column(db.String(20), default="#a77855")
    due_date = db.Column(db.Date)
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)
    deleted_at = db.Column(db.DateTime(timezone=True), index=True)


class TaskList(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, db.ForeignKey("project.id"), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    position = db.Column(db.Integer, default=0)


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(
        db.Integer, db.ForeignKey("project.id"), nullable=False, index=True
    )
    list_id = db.Column(db.Integer, db.ForeignKey("task_list.id"))
    parent_id = db.Column(db.Integer, db.ForeignKey("task.id"))
    title = db.Column(db.String(240), nullable=False)
    description = db.Column(db.Text, default="")
    status = db.Column(db.String(20), default="todo", nullable=False)
    priority = db.Column(db.String(20), default="medium", nullable=False)
    due_date = db.Column(db.Date)
    assignee_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    created_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)
    completed_at = db.Column(db.DateTime(timezone=True))
    deleted_at = db.Column(db.DateTime(timezone=True), index=True)


class TaskDependency(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    depends_on_id = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    __table_args__ = (db.UniqueConstraint("task_id", "depends_on_id"),)


class AutomationTemplate(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    workspace_id = db.Column(db.Integer, db.ForeignKey("workspace.id"), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    trigger = db.Column(db.String(40), nullable=False)
    action = db.Column(db.String(40), nullable=False)
    enabled = db.Column(db.Boolean, default=True, nullable=False)


class CalendarEvent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    workspace_id = db.Column(db.Integer, db.ForeignKey("workspace.id"), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    starts_at = db.Column(db.DateTime(timezone=True), nullable=False)
    ends_at = db.Column(db.DateTime(timezone=True))
    google_event_id = db.Column(db.String(255))


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    workspace_id = db.Column(
        db.Integer, db.ForeignKey("workspace.id"), nullable=False, index=True
    )
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    body = db.Column(db.String(4000), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)


class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    body = db.Column(db.String(500), nullable=False)
    read_at = db.Column(db.DateTime(timezone=True))
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)


class Attachment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    stored_name = db.Column(db.String(255), nullable=False, unique=True)
    uploaded_by = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)


class EmailToken(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    token_hash = db.Column(db.String(64), unique=True, nullable=False)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)