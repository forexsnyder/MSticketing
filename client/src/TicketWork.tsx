import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type Technician = { id: number; name: string };
type Review = { review: string; approval: string; security_impact: string };
type TimeEntry = { id: number; technician: string; minutes: number; note: string };
type Work = { time: TimeEntry[]; review: Review | null };
const emptyReview: Review = { review: "", approval: "Pending", security_impact: "" };

async function request<T>(url: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error("Request failed");
  return response.json();
}

function TechnicianOptions({ technicians, placeholder }: { technicians: Technician[]; placeholder: string }) {
  return <><option value="">{placeholder}</option>{technicians.map(tech =>
    <option key={tech.id} value={tech.name}>{tech.name}</option>)}</>;
}

export function TicketWork({ id, assignee, technicians, actor }: {
  id: number; assignee: string; technicians: Technician[]; actor: string;
}) {
  const url = `/api/tickets/${id}`;
  const [work, setWork] = useState<Work | null>(null);
  const [review, setReview] = useState(emptyReview);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    request<Work>(url + "/work").then(data => {
      if (!active) return;
      setWork(data);
      setReview(data.review || emptyReview);
    }).catch(() => { if (active) setMessage("Could not load ticket work details."); });
    return () => { active = false; };
  }, [url]);

  async function logTime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await request(url + "/time", "POST", { ...Object.fromEntries(data), minutes: Number(data.get("minutes")), actor });
      form.reset();
      setWork(await request<Work>(url + "/work"));
      setMessage("Time entry saved.");
    } catch {
      setMessage("Could not complete the time entry request. Check the time log before retrying.");
    } finally { setBusy(false); }
  }

  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await request(url + "/review", "PUT", { ...review, actor });
      setMessage("Review saved.");
    } catch { setMessage("Could not save the review."); }
    finally { setBusy(false); }
  }

  return <div className="ticket-work">
    {message && <p role="status">{message}</p>}
    {work && <>
      <h3>Time tracking</h3>
      <p>{work.time.reduce((total, entry) => total + entry.minutes, 0)} minutes logged</p>
      <form className="work-form" onSubmit={logTime}>
        <label>Technician<select name="technician" required defaultValue={assignee}>
          <TechnicianOptions technicians={technicians} placeholder="Choose technician"/>
        </select></label>
        <label>Minutes spent<input name="minutes" type="number" required min={1} max={1440}/></label>
        <label className="wide">Work note<textarea name="note" maxLength={2000} rows={2}/></label>
        <button className="primary" disabled={busy}>Log time</button>
      </form>
      {work.time.length > 0 && <ul>{work.time.map(entry => <li key={entry.id}>
        {entry.technician} · {entry.minutes} minutes{entry.note && ` · ${entry.note}`}
      </li>)}</ul>}
      <h3>Review and approval</h3>
      <form className="work-form" onSubmit={saveReview}>
        <label className="wide">Review notes<textarea rows={3} maxLength={4000} value={review.review}
          onChange={event => setReview({ ...review, review: event.target.value })}/></label>
        <label>Approval status<select value={review.approval}
          onChange={event => setReview({ ...review, approval: event.target.value })}>
          <option>Pending</option><option>Approved</option><option>Rejected</option>
        </select></label>
        <label className="wide">Security impact<textarea rows={3} maxLength={4000} value={review.security_impact}
          onChange={event => setReview({ ...review, security_impact: event.target.value })}/></label>
        <button className="primary" disabled={busy}>Save review</button>
      </form>
    </>}
  </div>;
}

const frequencies = { daily: "Every day", weekly: "Every week", fortnightly: "Every two weeks", monthly: "Every 30 days" };
type Schedule = { id: number; subject: string; assignee: string; frequency: keyof typeof frequencies; next_run: number; active: number };

export function Maintenance({ technicians }: { technicians: Technician[] }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const url = "/api/maintenance";
  const refresh = async () => setSchedules(await request<Schedule[]>(url));
  useEffect(() => { void refresh().catch(() => setMessage("Could not load maintenance schedules.")); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    setBusy(true);
    try {
      await request(url, "POST", { ...data, start: new Date(String(data.start)).toISOString() });
      form.reset();
      await refresh();
      setMessage("Maintenance schedule saved.");
    } catch { setMessage("Could not complete the schedule request. Check the list before retrying."); }
    finally { setBusy(false); }
  }

  async function toggle(schedule: Schedule) {
    setBusy(true);
    try {
      await request(`${url}/${schedule.id}`, "PATCH", { active: !schedule.active });
      await refresh();
      setMessage(schedule.active ? "Schedule paused." : "Schedule resumed.");
    } catch { setMessage("Could not update the schedule."); }
    finally { setBusy(false); }
  }

  return <section className="screen-card">
    <h2>Recurring maintenance tickets</h2>
    <form className="work-form" onSubmit={create}>
      <label className="wide">Ticket title<input name="subject" required maxLength={250}/></label>
      <label className="wide">Description<textarea name="description" required rows={3} maxLength={10000}/></label>
      <label>Assigned technician<select name="assignee"><TechnicianOptions technicians={technicians} placeholder="Unassigned"/></select></label>
      <label>First run<input name="start" type="datetime-local" required/></label>
      <label>Repeat<select name="frequency">{Object.entries(frequencies).map(([value, label]) =>
        <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="wide"><button className="primary" disabled={busy}>Create schedule</button></div>
    </form>
    {message && <p role="status">{message}</p>}
    {schedules.map(schedule => <article className="maintenance-row" key={schedule.id}>
      <div><strong>{schedule.subject}</strong>
        <p>{schedule.assignee || "Unassigned"} · {frequencies[schedule.frequency]} · {schedule.active
          ? `Next run ${new Date(schedule.next_run).toLocaleString()}` : "Paused"}</p>
      </div>
      <button className="secondary" disabled={busy} onClick={() => void toggle(schedule)}>
        {schedule.active ? "Pause" : "Resume"}
      </button>
    </article>)}
  </section>;
}
