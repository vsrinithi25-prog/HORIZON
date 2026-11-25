"""Helper functions for workspace access and task dependencies."""

from extensions import db
from models import Membership, Project, Task, TaskDependency


def member_workspace(user_id, workspace_id):
    return Membership.query.filter_by(
        user_id=user_id,
        workspace_id=workspace_id
    ).first()


def project_access(user_id, project_id):
    project = Project.query.filter_by(
        id=project_id,
        deleted_at=None
    ).first()

    if not project:
        return None

    if not member_workspace(user_id, project.workspace_id):
        return None

    return project


def task_access(user_id, task_id):
    task = Task.query.filter_by(
        id=task_id,
        deleted_at=None
    ).first()

    if not task:
        return None

    if not project_access(user_id, task.project_id):
        return None

    return task


def dependency_cycle(task_id, dependency_id):
    if task_id == dependency_id:
        return True

    seen = set()
    stack = [dependency_id]

    while stack:
        current = stack.pop()

        if current == task_id:
            return True

        if current in seen:
            continue

        seen.add(current)

        dependencies = TaskDependency.query.filter_by(task_id=current).all()
        stack.extend(item.depends_on_id for item in dependencies)

    return False


def delay_impact(task_id):
    """Count open tasks that depend directly or indirectly on this task."""
    impacted = set()
    frontier = [task_id]

    while frontier:
        current = frontier.pop()
        children = TaskDependency.query.filter_by(depends_on_id=current).all()

        for edge in children:
            task = Task.query.filter_by(
                id=edge.task_id,
                deleted_at=None
            ).first()

            if task and task.status != "done" and task.id not in impacted:
                impacted.add(task.id)
                frontier.append(task.id)

    return len(impacted)