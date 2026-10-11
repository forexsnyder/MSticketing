import express from "express";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "it-ticketing.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    requester TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    issue_type TEXT NOT NULL DEFAULT 'Task',
    project TEXT NOT NULL DEFAULT 'IT Department',
    sprint TEXT NOT NULL DEFAULT 'Current sprint',
    priority TEXT NOT NULL DEFAULT 'Normal',
    status TEXT NOT NULL DEFAULT 'New',
    assignee TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    due_date TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    author TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    ticket_key TEXT NOT NULL,
    ticket_subject TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
  );
`);
for (const column of [
  ["issue_type", "TEXT NOT NULL DEFAULT 'Task'"],
  ["project", "TEXT NOT NULL DEFAULT 'IT Department'"],
  ["sprint", "TEXT NOT NULL DEFAULT 'Current sprint'"],
  ["archived", "INTEGER NOT NULL DEFAULT 0"],
  ["due_date", "TEXT NOT NULL DEFAULT ''"],
]) {
  try { db.exec(`ALTER TABLE tickets ADD COLUMN ${column[0]} ${column[1]}`); } catch {}
}
db.exec("UPDATE tickets SET project='IT Department' WHERE project IN ('IT Help Desk','Operations')");
db.exec(`INSERT INTO audit_log (ticket_id,ticket_key,ticket_subject,actor,action,details)
  SELECT t.id,'IT-'||printf('%04d',t.id),t.subject,'System','Audit tracking enabled',
    'Earlier changes were not recorded before audit tracking was enabled.'
  FROM tickets t WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.ticket_id=t.id)`);

const app = express();
app.use(express.json());
const clientDist = path.join(root, "client", "dist");
app.use(express.static(clientDist));

function actorName(value) {
  const actor = String(value || "Help desk").trim().slice(0, 120);
  return actor || "Help desk";
}
function audit(ticket, actor, action, details = "") {
  db.prepare(`INSERT INTO audit_log (ticket_id,ticket_key,ticket_subject,actor,action,details)
    VALUES (?,?,?,?,?,?)`).run(ticket.id, `IT-${String(ticket.id).padStart(4, "0")}`, ticket.subject, actorName(actor), action, details);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "it-ticketing" }));
app.get("/api/tickets", (req, res) => {
  const status = String(req.query.status || "all");
  const dateOrder = req.query.sort === "oldest" ? "ASC" : "DESC";
  const archived = req.query.archived === "true" ? 1 : 0;
  const q = String(req.query.q || "").trim();
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const where = ["t.archived=?"];
  const params = [archived];
  if (status !== "all") { where.push("t.status=?"); params.push(status); }
  if (from) { where.push("datetime(t.created_at) >= datetime(?)"); params.push(from); }
  if (to) { where.push("datetime(t.created_at) < datetime(?)"); params.push(to); }
  if (q) {
    where.push("(t.subject LIKE ? OR t.description LIKE ? OR t.requester LIKE ? OR t.assignee LIKE ?)");
    const term = `%${q}%`;
    params.push(term, term, term, term);
  }
  res.json(db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.ticket_id=t.id) comment_count
    FROM tickets t WHERE ${where.join(" AND ")}
    ORDER BY created_at ${dateOrder}, id ${dateOrder}`).all(...params));
});

app.get("/api/audit", (_req, res) => {
  res.json(db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 500").all());
});
app.get("/api/tickets/:id", (req, res) => {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "not found" });
  ticket.comments = db.prepare("SELECT * FROM comments WHERE ticket_id=? ORDER BY id").all(ticket.id);
  ticket.audit = db.prepare("SELECT * FROM audit_log WHERE ticket_id=? ORDER BY id DESC").all(ticket.id);
  return res.json(ticket);
});

app.post("/api/tickets", (req, res) => {
  const body = req.body || {};
  if (!body.requester || !body.subject || !body.description) return res.status(400).json({ error: "requester, subject, and description are required" });
  const insert = db.transaction(() => {
    const result = db.prepare(`INSERT INTO tickets (requester,subject,description,category,issue_type,project,sprint,priority,due_date)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(String(body.requester).trim(), String(body.subject).trim(), String(body.description).trim(), body.category || "General", body.issue_type || "Task", "IT Department", body.sprint || "Current sprint", body.priority || "Normal", body.due_date || "");
    const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(result.lastInsertRowid);
    audit(ticket, body.actor, "Ticket created", `Created with ${ticket.priority} priority${ticket.due_date ? ` · Due ${ticket.due_date}` : ""}`);
    return ticket.id;
  });
  return res.status(201).json({ id: insert() });
});

app.patch("/api/tickets/:id", (req, res) => {
  const body = req.body || {};
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "invalid ticket id" });
  const current = db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
  if (!current) return res.status(404).json({ error: "not found" });
  const allowedStatuses = ["New", "In Progress", "Waiting", "Resolved", "Closed"];
  const allowedPriorities = ["Low", "Normal", "High", "Critical"];
  if (body.status !== undefined && !allowedStatuses.includes(body.status)) return res.status(400).json({ error: "invalid status" });
  if (body.priority !== undefined && !allowedPriorities.includes(body.priority)) return res.status(400).json({ error: "invalid priority" });
  if (body.assignee !== undefined && String(body.assignee).trim().length > 120) return res.status(400).json({ error: "assignee is too long" });
  if (body.due_date !== undefined && body.due_date !== "") {
    const parsedDueDate = new Date(`${body.due_date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.due_date) || Number.isNaN(parsedDueDate.valueOf()) || parsedDueDate.toISOString().slice(0, 10) !== body.due_date) return res.status(400).json({ error: "invalid due date" });
  }
  const comment = String(body.comment || "").trim();
  if (comment.length > 5000) return res.status(400).json({ error: "note is too long" });
  const transaction = db.transaction(() => {
    const updates = [
      ["status", body.status],
      ["priority", body.priority],
      ["assignee", body.assignee === undefined ? undefined : String(body.assignee).trim()],
      ["due_date", body.due_date],
    ];
    for (const [field, value] of updates) {
      if (value !== undefined && value !== current[field]) {
        const emptyLabel = field === "assignee" ? "Unassigned" : "None";
        const fieldLabel = field === "due_date" ? "Due date" : field === "assignee" ? "Assigned technician" : `${field[0].toUpperCase()}${field.slice(1)}`;
        audit(current, body.author, `${fieldLabel} changed`, `${current[field] || emptyLabel} → ${value || emptyLabel}`);
      }
    }
    db.prepare(`UPDATE tickets SET status=COALESCE(?,status),priority=COALESCE(?,priority),assignee=COALESCE(?,assignee),due_date=COALESCE(?,due_date),updated_at=datetime('now') WHERE id=?`)
      .run(body.status, body.priority, body.assignee === undefined ? null : String(body.assignee).trim(), body.due_date, id);
    if (comment) {
      const author = actorName(body.author);
      db.prepare("INSERT INTO comments(ticket_id,author,body) VALUES(?,?,?)").run(id, author, comment);
      audit(current, author, "Internal note added", comment.slice(0, 240));
    }
  });
  transaction();
  return res.json({ ok: true });
});

app.post("/api/tickets/:id/archive", (req, res) => {
  const id = Number(req.params.id);
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
  if (!ticket) return res.status(404).json({ error: "not found" });
  if (ticket.archived) return res.status(409).json({ error: "ticket is already archived" });
  db.transaction(() => {
    db.prepare("UPDATE tickets SET archived=1,updated_at=datetime('now') WHERE id=?").run(id);
    audit(ticket, req.body?.actor, "Ticket archived");
  })();
  return res.json({ ok: true });
});
app.post("/api/tickets/:id/restore", (req, res) => {
  const id = Number(req.params.id);
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
  if (!ticket) return res.status(404).json({ error: "not found" });
  if (!ticket.archived) return res.status(409).json({ error: "ticket is not archived" });
  db.transaction(() => {
    db.prepare("UPDATE tickets SET archived=0,updated_at=datetime('now') WHERE id=?").run(id);
    audit(ticket, req.body?.actor, "Ticket restored from archive");
  })();
  return res.json({ ok: true });
});
app.delete("/api/tickets/:id", (req, res) => {
  const id = Number(req.params.id);
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(id);
  if (!ticket) return res.status(404).json({ error: "not found" });
  db.transaction(() => {
    audit(ticket, req.body?.actor, "Ticket permanently deleted", "Ticket and its notes were permanently deleted; audit history retained");
    db.prepare("DELETE FROM tickets WHERE id=?").run(id);
  })();
  return res.json({ ok: true });
});

app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
const port = Number(process.env.PORT || 3010);
app.listen(port, "0.0.0.0", () => console.log(`IT Ticketing listening on ${port}`));
