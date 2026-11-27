"""HORIZON Flask application: personal and team project coordination."""
import csv
import hashlib
import io
import logging
import os
import secrets
import smtplib
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit
from flask import Flask, abort, flash, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from flask_socketio import join_room
from werkzeug.utils import secure_filename

from config import Config
from extensions import db, socketio
from models import (Attachment, AutomationTemplate, CalendarEvent, EmailToken, Membership, Message,
                    Notification, Project, Task, TaskDependency, TaskList, User, Workspace, now)
from services import dependency_cycle, delay_impact, member_workspace, project_access, task_access

STATUSES = {"todo", "in_progress", "done"}
PRIORITIES = {"low", "medium", "high", "urgent"}


def create_app(config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(Config)
    if config: app.config.update(config)
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    Path(app.config["UPLOAD_FOLDER"]).mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if app.config["SECRET_KEY"] == "dev-only-change-me": app.logger.warning("Using the development SECRET_KEY; configure a random secret before deployment.")
    db.init_app(app)
    socketio.init_app(app, async_mode="threading")

    @app.before_request
    def same_origin_guard():
        write_methods = {"POST", "PUT", "PATCH", "DELETE"}
        origin = request.headers.get("Origin")

        if request.method in write_methods and origin:
            origin_host = urlsplit(origin).netloc.lower()
            if origin_host != request.host.lower():
                abort(403)

        if request.method in write_methods and current_user():
            expected = session.get("csrf_token", "")
            supplied = request.headers.get("X-CSRF-Token", "")
            if not expected or not secrets.compare_digest(expected, supplied):
                abort(400, "Missing or invalid CSRF token.")

    def current_user():
        uid = session.get("user_id")
        return db.session.get(User, uid) if uid else None

    def login_required(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not current_user():
                if request.path.startswith("/api/"): return jsonify(error="authentication_required"), 401
                return redirect(url_for("index", login="1"))
            return fn(*args, **kwargs)
        return wrapped

    def json_error(message, code=400): return jsonify(error=message), code

    def user_workspaces(user):
        rows = Membership.query.filter_by(user_id=user.id).all()
        return [db.session.get(Workspace, row.workspace_id) for row in rows]

    def send_verification_email(user, raw_token):
        if not app.config["MAIL_SERVER"]: raise RuntimeError("Email verification is enabled but MAIL_SERVER is not configured.")
        message=EmailMessage(); message["Subject"]="Verify your HORIZON email"; message["From"]=app.config["MAIL_DEFAULT_SENDER"]; message["To"]=user.email
        link=url_for("verify_email",token=raw_token,_external=True)
        message.set_content(f"Hello {user.name},\n\nVerify your HORIZON email address using this link (expires in 24 hours):\n{link}\n")
        with smtplib.SMTP(app.config["MAIL_SERVER"],app.config["MAIL_PORT"],timeout=15) as smtp:
            smtp.starttls();
            if app.config["MAIL_USERNAME"]: smtp.login(app.config["MAIL_USERNAME"],app.config["MAIL_PASSWORD"])
            smtp.send_message(message)

    def serialize_task(task):
        return {"id":task.id,"project_id":task.project_id,"list_id":task.list_id,"parent_id":task.parent_id,
                "title":task.title,"description":task.description,"status":task.status,"priority":task.priority,
                "due_date":task.due_date.isoformat() if task.due_date else None,"assignee_id":task.assignee_id,
                "delay_impact":delay_impact(task.id)}

    @app.get("/")
    def index(): return render_template("index.html", user=current_user(), login=request.args.get("login"))

    @app.post("/api/register")
    def register():
        data = request.get_json(silent=True) or request.form
        name, email, password = (str(data.get(k, "")).strip() for k in ("name", "email", "password"))
        email = email.lower()
        if not name or len(name) > 100 or "@" not in email or len(email) > 255 or len(password) < 10:
            return json_error("Provide a name, valid email, and password of at least 10 characters.")
        if User.query.filter_by(email=email).first(): return json_error("An account with that email already exists.", 409)
        user = User(name=name, email=email); user.set_password(password)
        db.session.add(user); db.session.flush()
        workspace = Workspace(name=f"{name}'s space", kind="personal", owner_id=user.id)
        db.session.add(workspace); db.session.flush()
        db.session.add(Membership(workspace_id=workspace.id, user_id=user.id, role="owner"))
        for label, trigger, action in [("Welcome new members", "member_joined", "notify_owner"), ("Due date reminder", "task_due", "notify_assignee"), ("Completed task", "task_completed", "notify_workspace")]:
            db.session.add(AutomationTemplate(workspace_id=workspace.id, name=label, trigger=trigger, action=action))
        raw=None
        if app.config["VERIFY_EMAIL"]:
            raw = secrets.token_urlsafe(32)
            db.session.add(EmailToken(user_id=user.id, token_hash=hashlib.sha256(raw.encode()).hexdigest(), expires_at=now()+timedelta(hours=24)))
        else: user.verified_at = now()
        try:
            if raw: send_verification_email(user,raw)
            db.session.commit()
        except Exception:
            db.session.rollback(); app.logger.exception("Unable to deliver email verification for %s",email)
            return json_error("Account setup could not send the verification email. Check SMTP settings and try again.",503)
        session.clear()
        if not app.config["VERIFY_EMAIL"]: session["user_id"] = user.id; session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(ok=True, user={"id":user.id,"name":user.name}, verification_required=app.config["VERIFY_EMAIL"]), 201

    @app.post("/api/login")
    def login():
        data = request.get_json(silent=True) or request.form
        user = User.query.filter_by(email=str(data.get("email", "")).strip().lower()).first()
        if not user or not user.check_password(str(data.get("password", ""))): return json_error("Email or password is incorrect.", 401)
        if app.config["VERIFY_EMAIL"] and not user.verified_at: return json_error("Verify your email before signing in.", 403)
        session.clear(); session["user_id"] = user.id; session["csrf_token"] = secrets.token_urlsafe(32)
        return jsonify(ok=True, user={"id":user.id,"name":user.name})

    @app.post("/api/logout")
    def logout(): session.clear(); return jsonify(ok=True)

    @app.get("/verify/<token>")
    def verify_email(token):
        digest = hashlib.sha256(token.encode()).hexdigest()
        record = EmailToken.query.filter_by(token_hash=digest).first()
        expiry=record.expires_at if record else None
        if expiry and expiry.tzinfo is None: expiry=expiry.replace(tzinfo=timezone.utc)
        if not record or expiry < now(): return "Verification link is invalid or expired.", 400
        user = db.session.get(User, record.user_id); user.verified_at = now(); db.session.delete(record); db.session.commit()
        return redirect(url_for("index", verified="1"))

    @app.get("/api/me")
    @login_required
    def me():
        user = current_user()
        return jsonify(id=user.id,name=user.name,email=user.email,theme=user.theme,csrf_token=session.get("csrf_token"),workspaces=[{"id":w.id,"name":w.name,"kind":w.kind} for w in user_workspaces(user)])

    @app.patch("/api/settings")
    @login_required
    def settings():
        data=request.get_json(silent=True) or {}
        if data.get("theme") not in {"light","dark","scheduled"}: return json_error("theme must be light, dark, or scheduled")
        user=current_user(); user.theme=data["theme"]
        if "name" in data and str(data["name"]).strip(): user.name=str(data["name"]).strip()[:100]
        db.session.commit(); return jsonify(ok=True)

    @app.get("/api/dashboard")
    @login_required
    def dashboard():
        user=current_user(); workspaces=user_workspaces(user); ws_ids=[w.id for w in workspaces]
        requested=request.args.get("workspace_id",type=int)
        if requested:
            if requested not in ws_ids: return json_error("Workspace not found.",404)
            ws_ids=[requested]
        projects=Project.query.filter(Project.workspace_id.in_(ws_ids),Project.deleted_at.is_(None)).order_by(Project.created_at.desc()).all() if ws_ids else []
        project_ids=[p.id for p in projects]
        tasks=Task.query.filter(Task.project_id.in_(project_ids),Task.deleted_at.is_(None)).all() if project_ids else []
        upcoming=sorted([t for t in tasks if t.due_date and t.status!="done"],key=lambda t:t.due_date)[:6]
        return jsonify(workspaces=[{"id":w.id,"name":w.name,"kind":w.kind} for w in workspaces],
                       projects=[{"id":p.id,"name":p.name,"description":p.description,"color":p.color,"due_date":p.due_date.isoformat() if p.due_date else None} for p in projects],
                       tasks=[serialize_task(t) for t in tasks], upcoming=[serialize_task(t) for t in upcoming],
                       stats={"projects":len(projects),"open":sum(t.status!="done" for t in tasks),"done":sum(t.status=="done" for t in tasks),"overdue":sum(t.status!="done" and t.due_date and t.due_date < now().date() for t in tasks)},
                       notifications=Notification.query.filter_by(user_id=user.id,read_at=None).count())

    @app.post("/api/workspaces")
    @login_required
    def create_workspace():
        data=request.get_json(silent=True) or {}; name=str(data.get("name", "")).strip()
        if not name or len(name)>120: return json_error("Workspace name is required (up to 120 characters).")
        user=current_user(); ws=Workspace(name=name,kind="team",owner_id=user.id); db.session.add(ws); db.session.flush()
        db.session.add(Membership(workspace_id=ws.id,user_id=user.id,role="owner")); db.session.commit()
        return jsonify(id=ws.id,name=ws.name,kind=ws.kind),201

    @app.post("/api/workspaces/<int:workspace_id>/members")
    @login_required
    def invite_member(workspace_id):
        actor=current_user(); membership=member_workspace(actor.id,workspace_id)
        if not membership or membership.role not in {"owner","admin"}: return json_error("Only workspace admins can manage members.",403)
        data=request.get_json(silent=True) or {}; email=str(data.get("email", "")).strip().lower(); role=data.get("role","member")
        invited=User.query.filter_by(email=email).first()
        if not invited: return json_error("Create the member account before adding them.",404)
        if role not in {"admin","member","viewer"}: return json_error("Invalid role.")
        if member_workspace(invited.id,workspace_id): return json_error("This person is already a member.",409)
        db.session.add(Membership(workspace_id=workspace_id,user_id=invited.id,role=role)); db.session.commit()
        return jsonify(ok=True),201

    @app.post("/api/workspaces/<int:workspace_id>/projects")
    @login_required
    def create_project(workspace_id):
        user = current_user()
        membership = member_workspace(user.id, workspace_id)

        if not membership:
            return json_error("Workspace not found.", 404)

        if membership.role == "viewer":
            return json_error("Viewers cannot create projects.", 403)

        data = request.get_json(silent=True) or {}
        name = str(data.get("name", "")).strip()

        if not name or len(name) > 160:
            return json_error("Project name is required (up to 160 characters).")

        project = Project(
            workspace_id=workspace_id,
            name=name,
            description=str(data.get("description", ""))[:5000]
        )

        db.session.add(project)
        db.session.flush()

        db.session.add(TaskList(project_id=project.id, name="To do"))
        db.session.add(TaskList(
            project_id=project.id,
            name="In progress",
            position=1
        ))
        db.session.add(TaskList(
            project_id=project.id,
            name="Done",
            position=2
        ))

        db.session.commit()
        return jsonify(id=project.id, name=project.name), 201
    @app.post("/api/projects/<int:project_id>/tasks")
    @login_required
    def create_task(project_id):
        user = current_user()
        project = project_access(user.id, project_id)

        if not project:
            return json_error("Project not found.", 404)

        membership = member_workspace(user.id, project.workspace_id)
        if membership.role == "viewer":
            return json_error("Viewers cannot create tasks.", 403)

        data = request.get_json(silent=True) or {}
        title = str(data.get("title", "")).strip()
        status = data.get("status", "todo")
        priority = data.get("priority", "medium")

        if not title or len(title) > 240:
            return json_error("Task title is required (up to 240 characters).")

        if status not in STATUSES or priority not in PRIORITIES:
            return json_error("Invalid status or priority.")

        parent_id = data.get("parent_id")
        if parent_id:
            try:
                parent_id = int(parent_id)
            except (TypeError, ValueError):
                return json_error("Invalid subtask parent.")
            parent = task_access(user.id, parent_id)
            if not parent or parent.project_id != project_id:
                return json_error("Subtask parent must be in this project.")

        list_id = data.get("list_id")
        if list_id:
            try:
                list_id = int(list_id)
            except (TypeError, ValueError):
                return json_error("Invalid task list.")
            if not TaskList.query.filter_by(id=list_id, project_id=project_id).first():
                return json_error("Task list must belong to this project.")

        task = Task(
            project_id=project_id,
            title=title,
            description=str(data.get("description", ""))[:10000],
            status=status,
            priority=priority,
            parent_id=parent_id,
            list_id=list_id,
            created_by=user.id
        )

        if data.get("due_date"):
            try:
                task.due_date = datetime.fromisoformat(data["due_date"]).date()
            except (TypeError, ValueError):
                return json_error("due_date must be YYYY-MM-DD.")

        db.session.add(task)
        db.session.flush()

        if status == "done":
            task.completed_at = now()

        db.session.add(Notification(user_id=user.id, body=f"Task created: {title}"))
        db.session.commit()

        return jsonify(serialize_task(task)), 201
    @app.patch("/api/tasks/<int:task_id>")
    @login_required
    def update_task(task_id):
        task=task_access(current_user().id,task_id)
        if not task: return json_error("Task not found.",404)
        membership=member_workspace(current_user().id,project_access(current_user().id,task.project_id).workspace_id)
        if membership.role=="viewer": return json_error("Viewers cannot update tasks.",403)
        data=request.get_json(silent=True) or {}
        if "title" in data:
            title=str(data["title"]).strip()
            if not title or len(title)>240: return json_error("Task title is required (up to 240 characters).")
            task.title=title
        if "status" in data:
            if data["status"] not in STATUSES: return json_error("Invalid task status.")
            task.status=data["status"]; task.completed_at=now() if task.status=="done" else None
        if "priority" in data:
            if data["priority"] not in PRIORITIES: return json_error("Invalid priority.")
            task.priority=data["priority"]
        if "description" in data: task.description=str(data["description"])[:10000]
        if "due_date" in data:
            try: task.due_date=datetime.fromisoformat(data["due_date"]).date() if data["due_date"] else None
            except (TypeError,ValueError): return json_error("due_date must be YYYY-MM-DD")
        db.session.commit(); return jsonify(serialize_task(task))

    @app.post("/api/tasks/<int:task_id>/dependencies")
    @login_required
    def add_dependency(task_id):
        user=current_user(); task=task_access(user.id,task_id); data=request.get_json(silent=True) or {}
        if not task: return json_error("Task not found.",404)
        membership=member_workspace(user.id,project_access(user.id,task.project_id).workspace_id)
        if membership.role=="viewer": return json_error("Viewers cannot change dependencies.",403)
        dependency=task_access(user.id,int(data.get("depends_on_id",0)))
        if not dependency or dependency.project_id!=task.project_id: return json_error("Dependency must be another task in this project.")
        if dependency_cycle(task.id,dependency.id): return json_error("This dependency would create a cycle.",409)
        if not TaskDependency.query.filter_by(task_id=task.id,depends_on_id=dependency.id).first():
            db.session.add(TaskDependency(task_id=task.id,depends_on_id=dependency.id)); db.session.commit()
        return jsonify(ok=True,downstream_impact=delay_impact(task.id)),201

    @app.delete("/api/tasks/<int:task_id>")
    @login_required
    def trash_task(task_id):
        task=task_access(current_user().id,task_id)
        if not task: return json_error("Task not found.",404)
        task.deleted_at=now(); db.session.commit(); return jsonify(ok=True)

    @app.get("/api/trash")
    @login_required
    def trash():
        user=current_user(); workspaces=user_workspaces(user); ids=[p.id for p in Project.query.filter(Project.workspace_id.in_([w.id for w in workspaces])).all()] if workspaces else []
        rows=Task.query.filter(Task.project_id.in_(ids),Task.deleted_at.is_not(None)).all() if ids else []
        return jsonify(tasks=[{"id":t.id,"title":t.title,"deleted_at":t.deleted_at.isoformat()} for t in rows])
    @app.get("/api/notifications")
    @login_required
    def notifications():
        rows=Notification.query.filter_by(user_id=current_user().id).order_by(Notification.created_at.desc()).limit(50).all()
        return jsonify(notifications=[{"id":n.id,"body":n.body,"read":bool(n.read_at),"created_at":n.created_at.isoformat()} for n in rows])

    @app.post("/api/notifications/<int:notification_id>/read")
    @login_required
    def read_notification(notification_id):
        item=Notification.query.filter_by(id=notification_id,user_id=current_user().id).first()
        if not item: return json_error("Notification not found.",404)
        item.read_at=now(); db.session.commit(); return jsonify(ok=True)

    @app.post("/api/tasks/<int:task_id>/restore")
    @login_required
    def restore_task(task_id):
        user=current_user(); task=Task.query.filter_by(id=task_id).first()
        if not task or not project_access(user.id,task.project_id): return json_error("Task not found.",404)
        task.deleted_at=None; db.session.commit(); return jsonify(ok=True)

    @app.post("/api/tasks/import")
    @login_required
    def import_tasks():
        project=project_access(current_user().id,int(request.form.get("project_id",0)))
        upload=request.files.get("file")
        if not project or not upload or not upload.filename.lower().endswith(".csv"): return json_error("Choose a project and a CSV file.")
        try:
            reader=csv.DictReader(io.StringIO(upload.stream.read().decode("utf-8-sig")))
            if not {"title"}.issubset(reader.fieldnames or []): return json_error("CSV must include a title column.")
            added=0
            for row in reader:
                title=(row.get("title") or "").strip()
                if not title: continue
                status=row.get("status","todo"); priority=row.get("priority","medium")
                if status not in STATUSES or priority not in PRIORITIES: continue
                task=Task(project_id=project.id,title=title[:240],description=(row.get("description") or "")[:10000],status=status,priority=priority,created_by=current_user().id)
                if row.get("due_date"):
                    try: task.due_date=datetime.fromisoformat(row["due_date"]).date()
                    except ValueError: continue
                db.session.add(task); added+=1
            db.session.commit(); return jsonify(imported=added)
        except (UnicodeDecodeError,csv.Error): return json_error("Unable to read CSV file.")

    @app.get("/api/projects/<int:project_id>/export.csv")
    @login_required
    def export_tasks(project_id):
        if not project_access(current_user().id,project_id): return json_error("Project not found.",404)
        output=io.StringIO(); writer=csv.writer(output); writer.writerow(["title","description","status","priority","due_date"])
        for task in Task.query.filter_by(project_id=project_id,deleted_at=None).all(): writer.writerow([task.title,task.description,task.status,task.priority,task.due_date.isoformat() if task.due_date else ""])
        from flask import Response
        return Response(output.getvalue(),mimetype="text/csv",headers={"Content-Disposition":f"attachment; filename=project-{project_id}-tasks.csv"})

    @app.post("/api/tasks/<int:task_id>/attachments")
    @login_required
    def upload_attachment(task_id):
        task=task_access(current_user().id,task_id); file=request.files.get("file")
        if not task: return json_error("Task not found.",404)
        if not file or not file.filename: return json_error("Choose a file.")
        original=secure_filename(file.filename)[:255]
        if not original: return json_error("Invalid filename.")
        stored=secrets.token_hex(16)+"_"+original; file.save(Path(app.config["UPLOAD_FOLDER"])/stored)
        item=Attachment(task_id=task_id,filename=original,stored_name=stored,uploaded_by=current_user().id); db.session.add(item); db.session.commit()
        return jsonify(id=item.id,filename=item.filename),201

    @app.get("/files/<int:attachment_id>")
    @login_required
    def get_attachment(attachment_id):
        item=db.session.get(Attachment,attachment_id)
        if not item or not task_access(current_user().id,item.task_id): abort(404)
        return send_from_directory(app.config["UPLOAD_FOLDER"],item.stored_name,as_attachment=True,download_name=item.filename)

    @app.get("/api/calendar")
    @login_required
    def calendar():
        ids=[w.id for w in user_workspaces(current_user())]
        rows=CalendarEvent.query.filter(CalendarEvent.workspace_id.in_(ids)).order_by(CalendarEvent.starts_at).all() if ids else []
        return jsonify(events=[{"id":e.id,"title":e.title,"starts_at":e.starts_at.isoformat(),"ends_at":e.ends_at.isoformat() if e.ends_at else None} for e in rows],google_configured=bool(app.config["GOOGLE_CLIENT_ID"] and app.config["GOOGLE_CLIENT_SECRET"]),google_connected=False)

    @app.post("/api/workspaces/<int:workspace_id>/events")
    @login_required
    def add_event(workspace_id):
        if not member_workspace(current_user().id,workspace_id): return json_error("Workspace not found.",404)
        data=request.get_json(silent=True) or {}
        try:
            starts=datetime.fromisoformat(data.get("starts_at", "").replace("Z","+00:00")); ends=datetime.fromisoformat(data["ends_at"].replace("Z","+00:00")) if data.get("ends_at") else None
        except (TypeError,ValueError): return json_error("starts_at and ends_at must be ISO datetimes.")
        title=str(data.get("title", "")).strip()
        if not title: return json_error("Event title is required.")
        item=CalendarEvent(workspace_id=workspace_id,title=title[:200],starts_at=starts,ends_at=ends); db.session.add(item); db.session.commit()
        return jsonify(id=item.id),201

    @app.get("/api/automations")
    @login_required
    def automations():
        ids=[w.id for w in user_workspaces(current_user())]
        rows=AutomationTemplate.query.filter(AutomationTemplate.workspace_id.in_(ids)).all() if ids else []
        return jsonify(templates=[{"id":r.id,"workspace_id":r.workspace_id,"name":r.name,"trigger":r.trigger,"action":r.action,"enabled":r.enabled} for r in rows])

    @app.patch("/api/automations/<int:automation_id>")
    @login_required
    def update_automation(automation_id):
        item=db.session.get(AutomationTemplate,automation_id)
        if not item or not member_workspace(current_user().id,item.workspace_id): return json_error("Automation not found.",404)
        if member_workspace(current_user().id,item.workspace_id).role=="viewer": return json_error("Viewers cannot configure automations.",403)
        item.enabled=bool((request.get_json(silent=True) or {}).get("enabled",item.enabled)); db.session.commit(); return jsonify(ok=True)

    @app.get("/api/messages/<int:workspace_id>")
    @login_required
    def messages(workspace_id):
        if not member_workspace(current_user().id,workspace_id): return json_error("Workspace not found.",404)
        rows=Message.query.filter_by(workspace_id=workspace_id).order_by(Message.created_at.desc()).limit(50).all()[::-1]
        return jsonify(messages=[{"id":m.id,"name":db.session.get(User,m.user_id).name,"body":m.body,"created_at":m.created_at.isoformat()} for m in rows])

    @app.post("/api/messages/<int:workspace_id>")
    @login_required
    def send_message(workspace_id):
        if not member_workspace(current_user().id,workspace_id): return json_error("Workspace not found.",404)
        body=str((request.get_json(silent=True) or {}).get("body", "")).strip()
        if not body or len(body)>4000: return json_error("Message must be 1 to 4000 characters.")
        item=Message(workspace_id=workspace_id,user_id=current_user().id,body=body); db.session.add(item); db.session.commit()
        payload={"id":item.id,"name":current_user().name,"body":body,"created_at":item.created_at.isoformat()}; socketio.emit("message",payload,to=f"workspace-{workspace_id}")
        return jsonify(payload),201

    @socketio.on("join_workspace")
    def join_workspace(data):
        user=current_user()
        if user and member_workspace(user.id,int(data.get("workspace_id",0))):
            room=f"workspace-{int(data['workspace_id'])}"; join_room(room)
            socketio.emit("presence",{"user_id":user.id,"name":user.name,"state":"online"},to=room,include_self=False)

    @app.errorhandler(413)
    def too_large(_): return jsonify(error="File exceeds the configured upload limit."),413

    @app.get("/health")
    def health(): return jsonify(status="ok")

    with app.app_context(): db.create_all()
    return app


app = create_app()

if __name__ == "__main__":
    socketio.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG", "false").lower()=="true")