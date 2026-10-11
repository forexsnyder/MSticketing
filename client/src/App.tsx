import { useEffect, useMemo, useState } from "react";
import { ClipboardList, LayoutDashboard, Plus, Search, Settings, X } from "lucide-react";
import "./styles.css";

type Role = "Reporter" | "Help desk" | "Manager";
type Comment = { id:number; author:string; body:string; created_at:string };
type AuditEvent = { id:number; ticket_id:number; ticket_key:string; ticket_subject:string; created_at:string; actor:string; action:string; details:string };
type Ticket = { id:number; subject:string; description:string; requester:string; issue_type:string; priority:string; status:string; assignee:string; due_date:string; created_at:string; archived:number; comments?:Comment[]; audit?:AuditEvent[] };
const statuses = ["New", "In Progress", "Waiting", "Resolved", "Closed"];
const asUtcDate = (value:string) => new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(" ","T")}Z`);
const formatLocalDateTime = (value:string) => asUtcDate(value).toLocaleString();
const formatLocalDate = (value:string) => asUtcDate(value).toLocaleDateString();
const localDayStartUtc = (day:string, offsetDays=0) => { const [year,month,date]=day.split("-").map(Number); return new Date(year,month-1,date+offsetDays).toISOString(); };

export default function App(){
  const [role,setRole]=useState<Role>((localStorage.getItem("it-role") as Role)||"Help desk");
  const [screen,setScreen]=useState("dashboard");
  const [tickets,setTickets]=useState<Ticket[]>([]);
  const [auditEvents,setAuditEvents]=useState<AuditEvent[]>([]);
  const [selected,setSelected]=useState<Ticket|null>(null);
  const [dialog,setDialog]=useState(false);
  const [confirmAction,setConfirmAction]=useState<"archive"|"restore"|"delete"|null>(null);
  const [notice,setNotice]=useState("");
  const [query,setQuery]=useState("");
  const [status,setStatus]=useState("all");
  const [dateOrder,setDateOrder]=useState("newest");
  const [from,setFrom]=useState("");
  const [to,setTo]=useState("");
  const [archived,setArchived]=useState(false);
  const canManage=role!=="Reporter";

  const load=async()=>{
    const params=new URLSearchParams({status,sort:dateOrder,from:from?localDayStartUtc(from):"",to:to?localDayStartUtc(to,1):"",q:query,archived:String(archived)});
    const r=await fetch(`/api/tickets?${params}`);
    if(r.ok)setTickets(await r.json());
  };
  const loadAudit=async()=>{const r=await fetch("/api/audit");if(r.ok)setAuditEvents(await r.json());};
  useEffect(()=>{void load()},[status,dateOrder,from,to,archived]);
  useEffect(()=>{if(screen==="audit"&&canManage)void loadAudit()},[screen,canManage]);

  const updateTicket=async(id:number,patch:Record<string,string>)=>{
    const r=await fetch(`/api/tickets/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)});
    if(!r.ok){setNotice("Could not save the ticket update.");return null}
    const fresh=await(await fetch(`/api/tickets/${id}`)).json();
    setSelected(current=>current?.id===id?fresh:current);
    await load();
    if(screen==="audit")await loadAudit();
    setNotice(patch.comment?"Note saved":"Ticket updated");
    window.setTimeout(()=>setNotice(""),2500);
    return fresh;
  };
  const save=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault();const form=e.currentTarget;
    const body={...Object.fromEntries(new FormData(form)),actor:role};
    const r=await fetch("/api/tickets",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!r.ok){setNotice("Could not create the issue. Please try again.");return}
    form.reset();setDialog(false);setNotice("Issue created successfully.");await load();
    window.setTimeout(()=>setNotice(""),4000);
  };
  const open=async(id:number)=>setSelected(await(await fetch(`/api/tickets/${id}`)).json());
  const performAction=async()=>{
    if(!selected||!confirmAction)return;
    const id=selected.id;const action=confirmAction;
    const method=action==="delete"?"DELETE":"POST";
    const endpoint=action==="archive"?"archive":action==="restore"?"restore":"";
    const r=await fetch(`/api/tickets/${id}${endpoint?`/${endpoint}`:""}`,{method,headers:{"Content-Type":"application/json"},...(method==="POST"||method==="DELETE"?{body:JSON.stringify({actor:role})}:{})});
    if(!r.ok){setNotice("Could not complete that ticket action.");setConfirmAction(null);return}
    setSelected(null);setConfirmAction(null);await load();await loadAudit();
    setNotice(action==="delete"?"Ticket permanently deleted.":action==="archive"?"Ticket archived.":"Ticket restored from archive.");
    window.setTimeout(()=>setNotice(""),3000);
  };
  const metrics=useMemo(()=>({open:tickets.filter(t=>!['Resolved','Closed'].includes(t.status)).length,progress:tickets.filter(t=>t.status==='In Progress').length,critical:tickets.filter(t=>t.priority==='Critical').length,resolved:tickets.filter(t=>t.status==='Resolved').length}),[tickets]);

  return <>
    <Header role={role} setRole={r=>{setRole(r);localStorage.setItem("it-role",r);if(r==="Reporter"&&screen==="audit")setScreen("dashboard")}} screen={screen} setScreen={setScreen} create={()=>{setNotice("");setDialog(true)}} canManage={canManage}/>
    <main>
      <div className="crumb">Department <b>/</b> <strong>IT Department</strong></div>
      <div className="title-row"><div><p className="eyebrow">{role.toUpperCase()} WORKSPACE</p><h1>{screen==="audit"?"Audit trail":screen[0].toUpperCase()+screen.slice(1)}</h1><span className="sub">{screen==="audit"?"A timestamped history of ticket activity.":role==='Reporter'?"Submit requests and follow their progress.":role==='Manager'?"See workload and service performance.":"Triage, assign, and resolve IT requests."}</span></div></div>
      {canManage&&screen!=="audit"&&<div className="metrics"><Metric label="Open issues" value={metrics.open}/><Metric label="In progress" value={metrics.progress}/><Metric label="Critical" value={metrics.critical}/><Metric label="Resolved" value={metrics.resolved}/></div>}
      {screen==='audit'?<AuditTable events={auditEvents}/>:screen==='reports'?<section className="screen-card"><h2>IT service reports</h2><p>Workload and response reporting for the IT department.</p></section>:screen==='settings'?<section className="screen-card"><h2>IT department settings</h2><p>There is one shared workflow for the IT department.</p></section>:<>
        <div className="toolbar"><div className="filters"><label className="search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&load()} placeholder="Search IT issues"/></label><select className="status-filter" aria-label="Filter by status" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{statuses.map(s=><option key={s}>{s}</option>)}</select><label className="date-sort">Date order<select aria-label="Date order" value={dateOrder} onChange={e=>setDateOrder(e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><label className="date-filter">From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="date-filter">To<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>{canManage&&<button className="secondary archive-toggle" onClick={()=>setArchived(v=>!v)}>{archived?"← Active tickets":"Archived tickets"}</button>}</div></div>
        {screen==='dashboard'&&canManage&&!archived?<><p className="board-help">Drag a ticket to another column to change its status. Open a ticket to assign a technician, set a due date, or add a note.</p><Board tickets={tickets} open={open} move={(id,s)=>void updateTicket(id,{status:s,author:role})}/></>:<Backlog tickets={tickets} open={open}/>}
      </>}
    </main>
    {notice&&<div className="toast" role="status">{notice}<button onClick={()=>setNotice("")}><X size={14}/></button></div>}
    {selected&&<Detail ticket={selected} role={role} close={()=>setSelected(null)} update={updateTicket} action={setConfirmAction}/>}
    <CreateDialog open={dialog} close={()=>setDialog(false)} save={save}/>
    {confirmAction&&selected&&<ConfirmDialog action={confirmAction} subject={selected.subject} cancel={()=>setConfirmAction(null)} confirm={()=>void performAction()}/>}
  </>;
}

function Header({role,setRole,screen,setScreen,create,canManage}:{role:Role;setRole:(r:Role)=>void;screen:string;setScreen:(s:string)=>void;create:()=>void;canManage:boolean}){const items:[[string,string],...[string,string][]]=[["dashboard","Dashboard"],["tickets","Tickets"],["reports","Reports"],["settings","Settings"],...(canManage?[["audit","Audit trail"] as [string,string]]:[])];return <header><div className="brand"><span className="mark">IT</span><div><strong>MSI IT Service Desk</strong><small>One department · One support queue</small></div></div><nav className="top-nav">{items.map(([k,l])=><button className={screen===k?"active":""} onClick={()=>setScreen(k)} key={k}>{l}</button>)}</nav><div className="head-actions"><label className="role-switcher">Role<select value={role} onChange={e=>setRole(e.target.value as Role)}><option>Reporter</option><option>Help desk</option><option>Manager</option></select></label>{role!=="Manager"&&<button className="primary" onClick={create}><Plus size={16}/> Create issue</button>}</div></header>}
function Metric({label,value}:{label:string;value:number}){return <div className="metric"><span>{label}</span><strong>{value}</strong></div>}
function Board({tickets,open,move}:{tickets:Ticket[];open:(id:number)=>void;move:(id:number,status:string)=>void}){const[dragging,setDragging]=useState<number|null>(null);return <div className="board">{statuses.map(s=><section className="column" key={s} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(dragging!==null){move(dragging,s);setDragging(null)}}}><div className="column-head"><span>{s}</span><b>{tickets.filter(t=>t.status===s).length}</b></div>{tickets.filter(t=>t.status===s).map(t=><IssueCard key={t.id} ticket={t} open={open} dragStart={()=>setDragging(t.id)} dragEnd={()=>setDragging(null)}/>)}</section>)}</div>}
function IssueCard({ticket,open,dragStart,dragEnd}:{ticket:Ticket;open:(id:number)=>void;dragStart:()=>void;dragEnd:()=>void}){return <button className="issue" draggable onDragStart={dragStart} onDragEnd={dragEnd} onClick={()=>open(ticket.id)} title="Open ticket · Drag to change status"><span className="key">IT-{String(ticket.id).padStart(4,"0")}</span><strong>{ticket.subject}</strong><small>{ticket.issue_type} · {ticket.requester}</small><div className="issue-foot"><span className={`tag ${ticket.priority.toLowerCase()}`}>{ticket.priority}</span><span className="state">{ticket.assignee||"Unassigned"}</span></div>{ticket.due_date&&<small className="due-chip">Due {new Date(`${ticket.due_date}T00:00:00`).toLocaleDateString()}</small>}</button>}
function Backlog({tickets,open}:{tickets:Ticket[];open:(id:number)=>void}){return <div className="backlog">{tickets.map(t=><button className="table-row" onClick={()=>open(t.id)} key={t.id}><span><b>IT-{String(t.id).padStart(4,"0")}</b> {t.subject}<small>{t.requester} · {formatLocalDate(t.created_at)}</small></span><span>{t.issue_type}</span><span className={`tag ${t.priority.toLowerCase()}`}>{t.priority}</span><span>{t.status}</span><span>{t.assignee||"Unassigned"}</span><span>{t.due_date?new Date(`${t.due_date}T00:00:00`).toLocaleDateString():"No due date"}</span></button>)}</div>}
function Detail({ticket,role,close,update,action}:{ticket:Ticket;role:Role;close:()=>void;update:(id:number,p:Record<string,string>)=>Promise<Ticket|null>;action:(a:"archive"|"restore"|"delete")=>void}){
  const readOnly=role==="Reporter";const[note,setNote]=useState("");const[tech,setTech]=useState(ticket.assignee);const[due,setDue]=useState(ticket.due_date||"");
  useEffect(()=>{setTech(ticket.assignee);setDue(ticket.due_date||"")},[ticket.id,ticket.assignee,ticket.due_date]);
  return <div className="overlay"><section className="drawer"><button className="drawer-close" onClick={close}><X/></button><p className="eyebrow">IT DEPARTMENT / IT-{String(ticket.id).padStart(4,"0")}{ticket.archived?" · ARCHIVED":""}</p><h2>{ticket.subject}</h2><span className="meta">Reported by {ticket.requester}</span><p className="description">{ticket.description}</p><label>Status<select disabled={readOnly} value={ticket.status} onChange={e=>void update(ticket.id,{status:e.target.value,author:role})}>{statuses.map(s=><option key={s}>{s}</option>)}</select></label><label>Due date<input type="date" disabled={readOnly} value={due} onChange={e=>setDue(e.target.value)} onBlur={()=>{if(due!==(ticket.due_date||""))void update(ticket.id,{due_date:due,author:role})}}/></label>{!readOnly&&<><label>Assigned technician<input value={tech} onChange={e=>setTech(e.target.value)} onBlur={()=>{if(tech!==ticket.assignee)void update(ticket.id,{assignee:tech,author:role})}} placeholder="Enter technician name"/></label><label>Priority<select value={ticket.priority} onChange={e=>void update(ticket.id,{priority:e.target.value,author:role})}><option>Low</option><option>Normal</option><option>High</option><option>Critical</option></select></label><div className="ticket-actions">{ticket.archived?<button className="secondary" onClick={()=>action("restore")}>Restore ticket</button>:<button className="secondary" onClick={()=>action("archive")}>Archive ticket</button>}<button className="danger" onClick={()=>action("delete")}>Delete permanently</button></div></>}
    <h3>Activity and notes</h3>{ticket.comments?.map(c=><div className="comment" key={`c${c.id}`}><b>{c.author}</b><small>{formatLocalDateTime(c.created_at)}</small><p>{c.body}</p></div>)}{!readOnly&&ticket.audit?.map(a=><div className="audit-item" key={`a${a.id}`}><div><b>{a.action}</b><small>{formatLocalDateTime(a.created_at)} · {a.actor}</small></div>{a.details&&<p>{a.details}</p>}</div>)}{!readOnly&&<form className="note-form" onSubmit={async e=>{e.preventDefault();const saved=await update(ticket.id,{comment:note,author:role});if(saved)setNote("")}}><label htmlFor="ticket-note">Add an internal note</label><textarea id="ticket-note" value={note} onChange={e=>setNote(e.target.value)} rows={3} placeholder="Write an update for the support team" required/><button className="primary" disabled={!note.trim()}>Save note</button></form>}
  </section></div>;
}
function AuditTable({events}:{events:AuditEvent[]}){return events.length?<div className="audit-table">{events.map(e=><article className="audit-row" key={e.id}><div className="audit-date">{formatLocalDateTime(e.created_at)}</div><div><strong>{e.action}</strong><small><b>{e.ticket_key}</b> · {e.ticket_subject}</small>{e.details&&<p>{e.details}</p>}</div><span className="audit-actor">{e.actor}</span></article>)}</div>:<section className="screen-card"><h2>No audit events yet</h2><p>Ticket creation and changes will be recorded here.</p></section>}
function ConfirmDialog({action,subject,cancel,confirm}:{action:"archive"|"restore"|"delete";subject:string;cancel:()=>void;confirm:()=>void}){const deleting=action==="delete";const title=deleting?"Permanently delete this ticket?":action==="archive"?"Archive this ticket?":"Restore this ticket?";const message=deleting?"This permanently removes the ticket and its notes. The audit history will remain, but this cannot be undone.":action==="archive"?"The ticket will leave the active queue. You can restore it from Archived tickets.":"The ticket will return to the active queue.";return <div className="confirm-overlay"><section className="confirm-dialog" role="alertdialog" aria-modal="true"><h2>{title}</h2><p><strong>{subject}</strong></p><p>{message}</p><div className="modal-actions"><button className="secondary" onClick={cancel}>Cancel</button><button className={deleting?"danger":"primary"} onClick={confirm}>{deleting?"Delete permanently":action==="archive"?"Archive ticket":"Restore ticket"}</button></div></section></div>}
function Field({label,name,required,area,wide,select,options,type="text"}:{label:string;name:string;required?:boolean;area?:boolean;wide?:boolean;select?:boolean;options?:string[];type?:string}){return <label className={wide?"wide":""}>{label}{select?<select name={name}>{options?.map(o=><option key={o}>{o}</option>)}</select>:area?<textarea name={name} required={required} rows={5}/>:<input name={name} type={type} required={required}/>}</label>}
function CreateDialog({open,close,save}:{open:boolean;close:()=>void;save:(e:React.FormEvent<HTMLFormElement>)=>void}){return <dialog open={open}><form onSubmit={save}><button type="button" className="close" onClick={close}><X/></button><p className="eyebrow">CREATE IT ISSUE</p><h2>What needs attention?</h2><div className="form-grid"><Field label="Summary" name="subject" required/><Field label="Reporter" name="requester" required/><Field label="Description" name="description" area required wide/><Field label="Due date" name="due_date" type="date"/><Field label="Issue type" name="issue_type" select options={["Task","Incident","Service request","Bug"]}/><Field label="Priority" name="priority" select options={["Normal","Low","High","Critical"]}/><Field label="Category" name="category" select options={["Hardware","Software","Access","Network","General"]}/></div><div className="modal-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary">Create issue</button></div></form></dialog>}
