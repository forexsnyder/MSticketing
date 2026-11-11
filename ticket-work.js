const schedules = { daily: 1, weekly: 7, fortnightly: 14, monthly: 30 };
const dayMs = 86_400_000;

export function registerTicketWork(app, db, audit, actorName) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_time (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      technician TEXT NOT NULL, minutes INTEGER NOT NULL, note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ticket_reviews (
      ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      review TEXT NOT NULL, approval TEXT NOT NULL, security_impact TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS maintenance_schedules (
      id INTEGER PRIMARY KEY, subject TEXT NOT NULL, description TEXT NOT NULL,
      assignee TEXT NOT NULL, frequency TEXT NOT NULL, next_run INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);

  const findTicket = db.prepare("SELECT * FROM tickets WHERE id=?");
  const technicianExists = db.prepare("SELECT 1 FROM technicians WHERE name=?");
  const clean = (value, max) => typeof value === "string" && value.trim().length <= max ? value.trim() : null;

  app.get("/api/tickets/:id/work", (req, res) => {
    if (!findTicket.get(req.params.id)) return res.sendStatus(404);
    res.json({
      time: db.prepare("SELECT * FROM ticket_time WHERE ticket_id=? ORDER BY id DESC").all(req.params.id),
      review: db.prepare("SELECT review,approval,security_impact FROM ticket_reviews WHERE ticket_id=?").get(req.params.id) || null,
    });
  });

  app.post("/api/tickets/:id/time", (req, res) => {
    const ticket = findTicket.get(req.params.id);
    if (!ticket) return res.sendStatus(404);
    const { minutes, technician, actor } = req.body || {};
    const note = clean(req.body?.note ?? "", 2000);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 ||
        typeof technician !== "string" || !technicianExists.get(technician) || note === null) {
      return res.status(400).json({ error: "Choose a technician and enter between 1 and 1,440 minutes." });
    }
    db.transaction(() => {
      db.prepare("INSERT INTO ticket_time(ticket_id,technician,minutes,note) VALUES (?,?,?,?)").run(ticket.id, technician, minutes, note);
      audit(ticket, actor, "Time logged", `${technician} · ${minutes} minutes`);
    })();
    res.status(201).json({ ok: true });
  });

  app.put("/api/tickets/:id/review", (req, res) => {
    const ticket = findTicket.get(req.params.id);
    if (!ticket) return res.sendStatus(404);
    const review = clean(req.body?.review, 4000);
    const impact = clean(req.body?.security_impact, 4000);
    const approval = req.body?.approval;
    if (review === null || impact === null || !["Pending", "Approved", "Rejected"].includes(approval)) {
      return res.status(400).json({ error: "Enter valid review details and an approval status." });
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO ticket_reviews VALUES (?,?,?,?)
        ON CONFLICT(ticket_id) DO UPDATE SET review=excluded.review, approval=excluded.approval, security_impact=excluded.security_impact`)
        .run(ticket.id, review, approval, impact);
      audit(ticket, req.body.actor, "Review updated", `Approval: ${approval}`);
    })();
    res.json({ ok: true });
  });

  app.get("/api/maintenance", (_req, res) => {
    res.json(db.prepare("SELECT * FROM maintenance_schedules ORDER BY next_run,id").all());
  });

  app.post("/api/maintenance", (req, res) => {
    const subject = clean(req.body?.subject, 250);
    const description = clean(req.body?.description, 10000);
    const assignee = clean(req.body?.assignee ?? "", 120);
    const frequency = req.body?.frequency;
    const nextRun = typeof req.body?.start === "string" ? Date.parse(req.body.start) : NaN;
    if (!subject || !description || assignee === null || (assignee && !technicianExists.get(assignee)) ||
        !Object.hasOwn(schedules, frequency) || !Number.isFinite(nextRun)) {
      return res.status(400).json({ error: "Enter a title, description, start date and recurrence." });
    }
    const result = db.prepare(`INSERT INTO maintenance_schedules(subject,description,assignee,frequency,next_run)
      VALUES (?,?,?,?,?)`).run(subject, description, assignee, frequency, nextRun);
    tick();
    res.status(201).json({ id: result.lastInsertRowid });
  });

  app.patch("/api/maintenance/:id", (req, res) => {
    if (typeof req.body?.active !== "boolean") return res.sendStatus(400);
    const result = db.prepare("UPDATE maintenance_schedules SET active=? WHERE id=?")
      .run(Number(req.body.active), req.params.id);
    if (!result.changes) return res.sendStatus(404);
    if (req.body.active) tick();
    res.json({ ok: true });
  });

  const generate = db.transaction(now => {
    const due = db.prepare("SELECT * FROM maintenance_schedules WHERE active=1 AND next_run<=?").all(now);
    for (const schedule of due) {
      const result = db.prepare(`INSERT INTO tickets(requester,subject,description,assignee)
        VALUES ('Maintenance',?,?,?)`).run(schedule.subject, schedule.description, schedule.assignee);
      audit(findTicket.get(result.lastInsertRowid), actorName("Maintenance scheduler"), "Ticket created", "Recurring maintenance");
      const period = schedules[schedule.frequency] * dayMs;
      const nextRun = schedule.next_run + (Math.floor((now - schedule.next_run) / period) + 1) * period;
      db.prepare("UPDATE maintenance_schedules SET next_run=? WHERE id=?").run(nextRun, schedule.id);
    }
  });
  const tick = () => {
    try { generate.immediate(Date.now()); }
    catch (error) { console.error("Maintenance ticket generation failed:", error); }
  };
  tick();
  setInterval(tick, 30_000).unref();
}
