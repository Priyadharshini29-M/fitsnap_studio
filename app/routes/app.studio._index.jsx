/**
 * app.studio._index.jsx — AI Studio dashboard: asset library + models library.
 */

import { useState, useRef, useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureMerchant } from "../lib/merchant.server";
import phpApiClient from "../lib/php-api.server";
import { PHP_API_URL } from "../lib/env.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const apiKey = await ensureMerchant(session);
  const api = phpApiClient(apiKey, PHP_API_URL, session.shop);
  const [sessionsRes, modelsRes, setupRes] = await Promise.all([
    api.studioListSessions({ limit: 100, offset: 0 }),
    api.studioGetModels(),
    api.studioSetupCheck(),
  ]);
  return {
    assets: sessionsRes.ok ? (sessionsRes.data?.sessions ?? []) : [],
    models: modelsRes.ok  ? (modelsRes.data?.models ?? {})     : {},
    setup:  setupRes.ok   ? setupRes.data                      : null,
    shop:   session.shop,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const apiKey = await ensureMerchant(session);
  const api = phpApiClient(apiKey, PHP_API_URL, session.shop);
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body._action === "set-model-image") {
    const res = await api.studioSetModelImage(body.model_key, body.image_url);
    return Response.json(res.ok ? res.data : { error: res.error }, { status: res.ok ? 200 : 500 });
  }
  if (body._action === "delete-model-image") {
    const res = await api.studioDeleteModelImage(body.model_key);
    return Response.json(res.ok ? res.data : { error: res.error }, { status: res.ok ? 200 : 500 });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
};

// ── Constants ─────────────────────────────────────────────────────────────────

const FEMALE_KEYS = ["female_child_5_8","female_child_9_12","female_teen_13_17","female_young_adult","female_adult","female_mature_adult","female_plus_size"];
const MALE_KEYS   = ["male_child_5_8","male_child_9_12","male_teen_13_17","male_young_adult","male_adult","male_mature_adult","male_plus_size"];
const FALLBACK_LABELS = {
  female_child_5_8:"Female Child (5–8 yrs)",female_child_9_12:"Female Child (9–12 yrs)",female_teen_13_17:"Female Teen (13–17 yrs)",
  female_young_adult:"Female Young Adult (18–25)",female_adult:"Female Adult (26–35)",female_mature_adult:"Female Mature (36–50)",female_plus_size:"Female Plus Size",
  male_child_5_8:"Male Child (5–8 yrs)",male_child_9_12:"Male Child (9–12 yrs)",male_teen_13_17:"Male Teen (13–17 yrs)",
  male_young_adult:"Male Young Adult (18–25)",male_adult:"Male Adult (26–35)",male_mature_adult:"Male Mature (36–50)",male_plus_size:"Male Plus Size",
};

const WORKFLOW_LABELS = {
  "model-generation": "AI Model",
  "flat-lay":         "Flat Lay",
  "mannequin":        "Mannequin",
  "accessories":      "Accessories",
  "infographic":      "Infographic",
};

const STATUS_COLOR = {
  processing: { dot: "#F59E0B", bg: "#FFFBEB", text: "#92400E" },
  completed:  { dot: "#10B981", bg: "#ECFDF5", text: "#065F46" },
  failed:     { dot: "#EF4444", bg: "#FEF2F2", text: "#991B1B" },
};

const PER_PAGE = 12;

function resolveModel(models, key) {
  const s = models[key];
  const fallback = FALLBACK_LABELS[key] ?? key;
  return {
    key,
    label:        s?.label        ?? fallback,
    gender:       s?.gender       ?? (key.startsWith("male") ? "male" : "female"),
    image_exists: s?.image_exists ?? false,
    image_url:    s?.image_url    ?? null,
  };
}

async function uploadToTemp(file) {
  const fd = new FormData();
  fd.append("photo", file);
  let res;
  try {
    res = await fetch("/api/upload", { method: "POST", body: fd });
  } catch {
    throw new Error("Network error — check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
  if (!data.tempUrl) throw new Error("Upload succeeded but no URL was returned.");
  return data.tempUrl;
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

function StatusPill({ status }) {
  const s = STATUS_COLOR[status] ?? STATUS_COLOR.processing;
  return (
    <span style={{ display:"inline-flex",alignItems:"center",gap:"5px",background:s.bg,color:s.text,fontSize:"11px",fontWeight:600,padding:"3px 8px",borderRadius:"20px" }}>
      <span style={{ width:"6px",height:"6px",borderRadius:"50%",background:s.dot,flexShrink:0 }} />
      {status ? status.charAt(0).toUpperCase()+status.slice(1) : "Processing"}
    </span>
  );
}

function WorkflowTag({ type }) {
  return (
    <span style={{ fontSize:"11px",fontWeight:600,color:"#6B7280",background:"#F3F4F6",padding:"2px 8px",borderRadius:"4px" }}>
      {WORKFLOW_LABELS[type] ?? type}
    </span>
  );
}

function Spinner({ size = 18, color = "#4F46E5" }) {
  return (
    <span style={{ width:size,height:size,border:`2px solid ${color}22`,borderTop:`2px solid ${color}`,borderRadius:"50%",display:"inline-block",animation:"si-spin 0.75s linear infinite",flexShrink:0 }} />
  );
}

function ModelSilhouette({ gender }) {
  const fill = "#E5E7EB";
  return (
    <svg width="40" height="60" viewBox="0 0 48 72" fill="none">
      <circle cx="24" cy="11" r="9" fill={fill} />
      {gender === "male"
        ? <path d="M14 23 Q10 34 12 50 L18 50 L18 66 L22 66 L22 50 L26 50 L26 66 L30 66 L30 50 L36 50 Q38 34 34 23 Z" fill={fill} />
        : <path d="M14 22 Q10 30 12 44 L16 44 L16 66 L20 66 L20 44 L28 44 L28 66 L32 66 L32 44 L36 44 Q38 30 34 22 Q30 36 24 34 Q18 36 14 22Z" fill={fill} />
      }
    </svg>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function DashboardView({ assets, onCreate }) {
  const fetcher = useFetcher();
  const [view,         setView]         = useState("grid");
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter,   setTypeFilter]   = useState("all");
  const [sort,         setSort]         = useState("newest");
  const [page,         setPage]         = useState(1);
  const [confirmDel,   setConfirmDel]   = useState(null);

  const filtered = assets
    .filter((a) => {
      if (statusFilter !== "all" && (a.status ?? "processing") !== statusFilter) return false;
      if (typeFilter   !== "all" && (a.workflow_type ?? "") !== typeFilter) return false;
      if (search) {
        const name = (a.name ?? `${a.session_id ?? a.id}`).toLowerCase();
        if (!name.includes(search.toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ta = new Date(a.created_at ?? 0).getTime();
      const tb = new Date(b.created_at ?? 0).getTime();
      return sort === "newest" ? tb - ta : ta - tb;
    });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const stats = [
    { label: "Total",      n: assets.length,                                              },
    { label: "Completed",  n: assets.filter((a) => a.status === "completed").length,      },
    { label: "Processing", n: assets.filter((a) => (a.status ?? "processing") === "processing").length },
    { label: "Failed",     n: assets.filter((a) => a.status === "failed").length,         },
  ];

  const fmt = (d) => d ? new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—";

  return (
    <div>
      {/* Stats */}
      <div className="d-stats">
        {stats.map((s) => (
          <div key={s.label} className="d-stat">
            <div className="d-stat-n">{s.n}</div>
            <div className="d-stat-l">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="d-toolbar">
        <div className="d-search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{position:"absolute",left:"11px",top:"50%",transform:"translateY(-50%)",color:"#9CA3AF",pointerEvents:"none"}}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          <input className="d-search" placeholder="Search assets…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
          <select className="d-select" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="all">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
          </select>
          <select className="d-select" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
            <option value="all">All Types</option>
            {Object.entries(WORKFLOW_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="d-select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </div>
        <div className="d-view-toggle">
          <button className={`d-vbtn ${view==="grid"?"active":""}`} onClick={() => setView("grid")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="9" height="9" rx="1" fill="currentColor"/><rect x="13" y="2" width="9" height="9" rx="1" fill="currentColor"/><rect x="2" y="13" width="9" height="9" rx="1" fill="currentColor"/><rect x="13" y="13" width="9" height="9" rx="1" fill="currentColor"/></svg>
          </button>
          <button className={`d-vbtn ${view==="list"?"active":""}`} onClick={() => setView("list")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 10h18M3 14h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      {/* Empty */}
      {assets.length === 0 && (
        <div className="d-empty">
          <div className="d-empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="#4F46E5" strokeWidth="1.5" strokeLinejoin="round"/></svg>
          </div>
          <p className="d-empty-title">No assets yet</p>
          <p className="d-empty-sub">Create your first AI-generated product visual or marketing asset to get started.</p>
          <button className="d-btn-primary" onClick={onCreate}>Create New Asset</button>
        </div>
      )}

      {/* No results */}
      {assets.length > 0 && filtered.length === 0 && (
        <div className="d-empty" style={{paddingTop:"48px",paddingBottom:"48px"}}>
          <p className="d-empty-title" style={{fontSize:"15px"}}>No results</p>
          <p className="d-empty-sub">No assets match your current filters.</p>
          <button className="d-btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); setTypeFilter("all"); }}>Clear Filters</button>
        </div>
      )}

      {/* Grid view */}
      {paged.length > 0 && view === "grid" && (
        <div className="d-grid">
          {paged.map((a, i) => {
            const key = a.session_id ?? a.id ?? i;
            return (
              <div key={key} className="d-card">
                <div className="d-card-thumb">
                  {a.result_image
                    ? <img src={a.result_image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                    : <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#D1D5DB"}}>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
                      </div>
                  }
                  {(a.status === "processing" || !a.status) && (
                    <div style={{position:"absolute",top:"10px",right:"10px"}}><Spinner size={18} /></div>
                  )}
                </div>
                <div className="d-card-body">
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"6px"}}>
                    <WorkflowTag type={a.workflow_type} />
                    <StatusPill status={a.status} />
                  </div>
                  <p className="d-card-name">{a.name ?? `Asset #${key}`}</p>
                  <p className="d-card-date">{fmt(a.created_at)}</p>
                </div>
                <div className="d-card-footer">
                  {a.result_image && (
                    <>
                      <a href={a.result_image} target="_blank" rel="noreferrer" className="d-act d-act-view">View</a>
                      <a href={a.result_image} download className="d-act d-act-dl">Download</a>
                    </>
                  )}
                  <button className="d-act d-act-del" style={{marginLeft:"auto"}} onClick={() => setConfirmDel(a)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* List view */}
      {paged.length > 0 && view === "list" && (
        <div className="d-table-wrap">
          <table className="d-table">
            <thead>
              <tr>{["Preview","Name","Type","Status","Actions"].map((h) => <th key={h} className="d-th">{h}</th>)}</tr>
            </thead>
            <tbody>
              {paged.map((a, i) => {
                const key = a.session_id ?? a.id ?? i;
                return (
                  <tr key={key} className="d-tr">
                    <td className="d-td" style={{width:"60px"}}>
                      <div className="d-row-thumb">
                        {a.result_image
                          ? <img src={a.result_image} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                          : <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#D1D5DB"}}><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg></div>
                        }
                      </div>
                    </td>
                    <td className="d-td">
                      <p style={{fontWeight:600,fontSize:"13px",color:"#111827",margin:"0 0 2px"}}>{a.name ?? `Asset #${key}`}</p>
                      <p style={{fontSize:"11px",color:"#9CA3AF",margin:0}}>{fmt(a.created_at)}</p>
                    </td>
                    <td className="d-td"><WorkflowTag type={a.workflow_type} /></td>
                    <td className="d-td"><StatusPill status={a.status} /></td>
                    <td className="d-td">
                      <div style={{display:"flex",gap:"6px"}}>
                        {a.result_image && <><a href={a.result_image} target="_blank" rel="noreferrer" className="d-act d-act-view">View</a><a href={a.result_image} download className="d-act d-act-dl">Download</a></>}
                        <button className="d-act d-act-del" onClick={() => setConfirmDel(a)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="d-pager">
          <button className="d-page-btn" disabled={page===1} onClick={() => setPage(p=>p-1)}>Previous</button>
          {Array.from({length:Math.min(7,totalPages)},(_,i)=>{
            const p = Math.max(1,Math.min(totalPages-6,page-3))+i;
            return <button key={p} className={`d-page-btn ${p===page?"active":""}`} onClick={() => setPage(p)}>{p}</button>;
          })}
          <button className="d-page-btn" disabled={page===totalPages} onClick={() => setPage(p=>p+1)}>Next</button>
          <span style={{fontSize:"12px",color:"#9CA3AF"}}>{filtered.length} assets</span>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDel && (
        <div className="d-overlay" onClick={() => setConfirmDel(null)}>
          <div className="d-modal" onClick={(e) => e.stopPropagation()}>
            <p style={{fontWeight:700,fontSize:"15px",margin:"0 0 8px"}}>Delete Asset?</p>
            <p style={{fontSize:"13px",color:"#6B7280",margin:"0 0 20px",lineHeight:1.6}}>
              This will permanently remove <strong>"{confirmDel.name ?? `Asset #${confirmDel.session_id}`}"</strong>. This cannot be undone.
            </p>
            <div style={{display:"flex",gap:"8px",justifyContent:"flex-end"}}>
              <button className="d-btn-ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="d-btn-danger" onClick={() => { setConfirmDel(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Models Library ────────────────────────────────────────────────────────────

function ModelsView({ models: rawModels, setup }) {
  const allKeys = [...FEMALE_KEYS, ...MALE_KEYS];
  const [modelMap, setModelMap] = useState(() => {
    const m = {};
    allKeys.forEach((k) => { m[k] = resolveModel(rawModels, k); });
    return m;
  });
  const [gender, setGender] = useState("all");
  const [search, setSearch] = useState("");
  const delFetcher = useFetcher();
  const [delKey, setDelKey] = useState(null);

  useEffect(() => {
    if (delFetcher.state === "idle" && delFetcher.data !== undefined && delKey) {
      if (delFetcher.data?.ok) setModelMap((p) => ({ ...p, [delKey]: { ...p[delKey], image_exists: false, image_url: null } }));
      setDelKey(null);
    }
  }, [delFetcher.state, delFetcher.data, delKey]);

  const handleDelete = (key) => {
    if (!window.confirm(`Remove photo for "${modelMap[key]?.label}"?`)) return;
    setDelKey(key);
    delFetcher.submit({ _action: "delete-model-image", model_key: key }, { method: "POST", encType: "application/json" });
  };

  const handleUpdate = (key, upd) => setModelMap((p) => ({ ...p, [key]: upd }));

  const uploaded = allKeys.filter((k) => modelMap[k]?.image_exists).length;
  const visible  = allKeys.filter((k) => {
    const m = modelMap[k];
    if (gender !== "all" && m.gender !== gender) return false;
    if (search && !m.label.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div>
      {setup && !setup.ok && (
        <div className="d-banner d-banner-warn" style={{marginBottom:"16px"}}>
          <strong>Setup required before uploading photos.</strong> {(setup.issues ?? []).join(" • ")}
        </div>
      )}

      {/* Header */}
      <div className="d-models-top">
        <div>
          <p style={{fontWeight:700,fontSize:"15px",margin:"0 0 3px",color:"#111827"}}>Studio Models Library</p>
          <p style={{fontSize:"13px",color:"#6B7280",margin:0}}>
            Upload reference photos for each model type. They're reused across all generation workflows.
          </p>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:"26px",fontWeight:800,color:"#111827",lineHeight:1}}>{uploaded}<span style={{fontSize:"13px",color:"#9CA3AF",fontWeight:500}}>/{allKeys.length}</span></div>
          <div style={{fontSize:"11px",color:"#9CA3AF",marginTop:"2px"}}>photos uploaded</div>
          <div style={{height:"4px",width:"100px",background:"#F3F4F6",borderRadius:"99px",overflow:"hidden",marginTop:"8px"}}>
            <div style={{height:"100%",width:`${Math.round(uploaded/allKeys.length*100)}%`,background:uploaded===allKeys.length?"#10B981":"#4F46E5",borderRadius:"99px",transition:"width 0.4s"}} />
          </div>
        </div>
      </div>

      <div className="d-banner d-banner-info" style={{marginBottom:"16px"}}>
        <strong>Photo tips:</strong> Front-facing full-body, clean background, minimum 768×1024 px. JPEG / PNG / WEBP. Max 5 MB.
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:"8px",marginBottom:"20px",flexWrap:"wrap",alignItems:"center"}}>
        <div className="d-seg">
          {[["all","All"],["female","Female"],["male","Male"]].map(([v,l]) => (
            <button key={v} className={`d-seg-btn ${gender===v?"active":""}`} onClick={() => setGender(v)}>{l}</button>
          ))}
        </div>
        <div className="d-search-wrap" style={{flex:1,minWidth:"160px"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{position:"absolute",left:"11px",top:"50%",transform:"translateY(-50%)",color:"#9CA3AF",pointerEvents:"none"}}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          <input className="d-search" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {/* Grid */}
      <div className="d-models-grid">
        {visible.map((key) => (
          <ModelCard key={key} modelKey={key} info={modelMap[key]} onUpdate={handleUpdate} onDelete={handleDelete} />
        ))}
        {visible.length === 0 && (
          <div style={{gridColumn:"1/-1",textAlign:"center",padding:"40px",color:"#9CA3AF",fontSize:"13px"}}>No models match your filter.</div>
        )}
      </div>
    </div>
  );
}

function ModelCard({ modelKey, info, onUpdate, onDelete }) {
  const inputRef = useRef(null);
  const fetcher  = useFetcher();
  const [uploading, setUploading]   = useState(false);
  const [err,       setErr]         = useState(null);
  const busy = uploading || fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data !== undefined) {
      setUploading(false);
      if (fetcher.data?.image_url) {
        setErr(null);
        onUpdate(modelKey, { ...info, image_exists: true, image_url: fetcher.data.image_url + "?t=" + Date.now() });
      } else {
        setErr(fetcher.data?.error ?? "Save failed.");
      }
    }
  }, [fetcher.state, fetcher.data]);

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setErr("Images only (JPEG, PNG, WEBP)."); return; }
    if (file.size > 5 * 1024 * 1024) { setErr("File exceeds 5 MB limit."); return; }
    setUploading(true); setErr(null);
    try {
      const url = await uploadToTemp(file);
      fetcher.submit({ _action: "set-model-image", model_key: modelKey, image_url: url }, { method: "POST", encType: "application/json" });
    } catch (e) { setUploading(false); setErr(e.message ?? "Upload failed."); }
  };

  return (
    <div className="d-model-card">
      <div className="d-model-img">
        {info.image_exists && info.image_url
          ? <img src={info.image_url} alt={info.label} style={{width:"100%",height:"100%",objectFit:"cover"}} />
          : <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:"4px"}}><ModelSilhouette gender={info.gender} /><span style={{fontSize:"10px",color:"#9CA3AF"}}>No photo</span></div>
        }
        {busy && (
          <div style={{position:"absolute",inset:0,background:"rgba(255,255,255,0.85)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:"8px"}}>
            <Spinner size={20} />
            <span style={{fontSize:"11px",color:"#6B7280"}}>{uploading?"Uploading…":"Saving…"}</span>
          </div>
        )}
      </div>
      <div style={{padding:"10px 12px"}}>
        <p style={{fontSize:"12px",fontWeight:700,color:"#111827",margin:"0 0 2px",lineHeight:1.3}}>{info.label}</p>
        <p style={{fontSize:"11px",margin:"0 0 8px",fontWeight:500,color:info.image_exists?"#059669":"#9CA3AF"}}>
          {info.image_exists ? "✓ Uploaded" : "No photo"}
        </p>
        {err && <div className="d-inline-err">{err}</div>}
        <div style={{display:"flex",gap:"6px"}}>
          <button className="d-btn-primary" style={{flex:1,fontSize:"11px",padding:"6px 10px"}} disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Working…" : info.image_exists ? "Replace" : "Upload"}
          </button>
          {info.image_exists && (
            <button className="d-btn-ghost" style={{fontSize:"11px",padding:"6px 10px",color:"#EF4444"}} disabled={busy} onClick={() => onDelete(modelKey)}>✕</button>
          )}
        </div>
      </div>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" style={{display:"none"}}
        onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value=""; }} />
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function StudioPage() {
  const { assets, models, setup } = useLoaderData();
  const navigate = useNavigate();
  const [tab, setTab] = useState("assets");

  const uploaded = [...FEMALE_KEYS,...MALE_KEYS].filter((k) => models[k]?.image_exists).length;
  const total    = FEMALE_KEYS.length + MALE_KEYS.length;

  return (
    <>
      <style>{CSS}</style>
      <div className="d-page">

        {/* Header */}
        <div className="d-header">
          <div>
            <h1 className="d-title">AI Studio</h1>
            <p className="d-subtitle">Generate AI-powered product visuals and marketing assets.</p>
          </div>
          <button className="d-btn-primary d-cta" onClick={() => navigate("/app/studio/create")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{marginRight:"7px"}}><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>
            Create New Asset
          </button>
        </div>

        {/* Tabs */}
        <div className="d-tabs">
          <button className={`d-tab ${tab==="assets"?"active":""}`} onClick={() => setTab("assets")}>
            Asset Library
            <span className="d-tab-badge">{assets.length}</span>
          </button>
          <button className={`d-tab ${tab==="models"?"active":""}`} onClick={() => setTab("models")}>
            Studio Models
            <span className="d-tab-badge">{uploaded}/{total}</span>
          </button>
        </div>

        {tab === "assets"
          ? <DashboardView assets={assets} onCreate={() => navigate("/app/studio/create")} />
          : <ModelsView models={models} setup={setup} />
        }
      </div>
    </>
  );
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
@keyframes si-spin { to { transform: rotate(360deg); } }

.d-page { max-width: 1200px; margin: 0 auto; padding: 28px 24px 80px; font-family: Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #111827; }

/* Header */
.d-header { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:24px; gap:16px; flex-wrap:wrap; }
.d-title { font-size:22px; font-weight:700; color:#111827; margin:0 0 4px; letter-spacing:-0.3px; }
.d-subtitle { font-size:13px; color:#6B7280; margin:0; }

/* Tabs */
.d-tabs { display:flex; gap:2px; border-bottom:1px solid #E5E7EB; margin-bottom:24px; }
.d-tab { display:inline-flex; align-items:center; gap:6px; padding:10px 16px; font-family:inherit; font-size:13px; font-weight:500; color:#6B7280; background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; cursor:pointer; transition:all 0.15s; }
.d-tab.active { color:#111827; border-bottom-color:#111827; font-weight:600; }
.d-tab:hover:not(.active) { color:#374151; }
.d-tab-badge { font-size:11px; font-weight:600; padding:2px 7px; border-radius:10px; background:#F3F4F6; color:#6B7280; }
.d-tab.active .d-tab-badge { background:#111827; color:#fff; }

/* Stats */
.d-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:20px; }
@media(max-width:600px){ .d-stats { grid-template-columns:repeat(2,1fr); } }
.d-stat { background:#fff; border:1px solid #E5E7EB; border-radius:10px; padding:16px 18px; }
.d-stat-n { font-size:26px; font-weight:700; color:#111827; line-height:1; margin-bottom:4px; }
.d-stat-l { font-size:12px; color:#9CA3AF; }

/* Toolbar */
.d-toolbar { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; align-items:center; }
.d-search-wrap { position:relative; flex:1; min-width:180px; }
.d-search { width:100%; padding:8px 12px 8px 34px; border:1px solid #E5E7EB; border-radius:8px; font-size:13px; font-family:inherit; color:#111827; background:#fff; outline:none; box-sizing:border-box; transition:border-color 0.15s; }
.d-search:focus { border-color:#4F46E5; }
.d-select { padding:8px 10px; border:1px solid #E5E7EB; border-radius:8px; font-size:13px; font-family:inherit; color:#374151; background:#fff; outline:none; cursor:pointer; }
.d-select:focus { border-color:#4F46E5; }
.d-view-toggle { display:flex; border:1px solid #E5E7EB; border-radius:8px; overflow:hidden; flex-shrink:0; }
.d-vbtn { padding:8px 11px; background:#fff; border:none; cursor:pointer; color:#9CA3AF; display:flex; align-items:center; transition:all 0.15s; }
.d-vbtn.active { background:#111827; color:#fff; }
.d-vbtn:hover:not(.active) { background:#F9FAFB; color:#374151; }

/* Asset grid */
.d-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; margin-bottom:24px; }
.d-card { background:#fff; border:1px solid #E5E7EB; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; transition:box-shadow 0.15s; }
.d-card:hover { box-shadow:0 4px 16px rgba(0,0,0,0.08); }
.d-card-thumb { height:180px; background:#F9FAFB; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; }
.d-card-body { padding:12px 14px 8px; flex:1; }
.d-card-name { font-size:13px; font-weight:600; color:#111827; margin:6px 0 3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.d-card-date { font-size:11px; color:#9CA3AF; margin:0; }
.d-card-footer { display:flex; gap:6px; padding:8px 14px 12px; border-top:1px solid #F3F4F6; flex-wrap:wrap; }

/* Actions */
.d-act { font-size:11px; font-weight:600; padding:4px 10px; border-radius:6px; border:none; cursor:pointer; text-decoration:none; font-family:inherit; display:inline-flex; align-items:center; transition:all 0.15s; }
.d-act-view { background:#EEF2FF; color:#4F46E5; }
.d-act-view:hover { background:#E0E7FF; }
.d-act-dl { background:#F0FDF4; color:#059669; }
.d-act-dl:hover { background:#DCFCE7; }
.d-act-del { background:#FEF2F2; color:#EF4444; }
.d-act-del:hover { background:#FEE2E2; }

/* Table */
.d-table-wrap { background:#fff; border:1px solid #E5E7EB; border-radius:12px; overflow:hidden; margin-bottom:24px; }
.d-table { width:100%; border-collapse:collapse; }
.d-th { padding:10px 14px; text-align:left; font-size:11px; font-weight:600; color:#9CA3AF; text-transform:uppercase; letter-spacing:0.05em; background:#F9FAFB; border-bottom:1px solid #E5E7EB; }
.d-td { padding:12px 14px; border-bottom:1px solid #F3F4F6; vertical-align:middle; }
.d-tr:last-child .d-td { border-bottom:none; }
.d-tr:hover .d-td { background:#FAFBFF; }
.d-row-thumb { width:44px; height:44px; border-radius:6px; overflow:hidden; background:#F9FAFB; border:1px solid #E5E7EB; }

/* Pagination */
.d-pager { display:flex; align-items:center; gap:4px; justify-content:center; margin-top:20px; flex-wrap:wrap; }
.d-page-btn { padding:6px 12px; border:1px solid #E5E7EB; border-radius:7px; background:#fff; font-size:12px; font-weight:500; color:#374151; cursor:pointer; font-family:inherit; transition:all 0.15s; }
.d-page-btn.active { background:#111827; color:#fff; border-color:#111827; }
.d-page-btn:hover:not(.active):not(:disabled) { background:#F3F4F6; }
.d-page-btn:disabled { opacity:0.4; cursor:not-allowed; }

/* Empty */
.d-empty { text-align:center; padding:72px 24px; }
.d-empty-icon { width:64px; height:64px; border-radius:16px; background:#EEF2FF; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; }
.d-empty-title { font-size:16px; font-weight:600; color:#111827; margin:0 0 6px; }
.d-empty-sub { font-size:13px; color:#6B7280; margin:0 0 20px; line-height:1.6; max-width:360px; margin-left:auto; margin-right:auto; }

/* Models */
.d-models-top { background:#fff; border:1px solid #E5E7EB; border-radius:12px; padding:20px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.d-models-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:24px; }
@media(max-width:900px){ .d-models-grid { grid-template-columns:repeat(3,1fr); } }
@media(max-width:600px){ .d-models-grid { grid-template-columns:repeat(2,1fr); } }
.d-model-card { background:#fff; border:1px solid #E5E7EB; border-radius:10px; overflow:hidden; transition:box-shadow 0.15s; }
.d-model-card:hover { box-shadow:0 4px 12px rgba(0,0,0,0.07); }
.d-model-img { height:160px; background:#F9FAFB; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; }

/* Seg control */
.d-seg { display:flex; border:1px solid #E5E7EB; border-radius:8px; overflow:hidden; flex-shrink:0; }
.d-seg-btn { padding:7px 14px; background:#fff; border:none; font-size:13px; font-weight:500; color:#6B7280; cursor:pointer; font-family:inherit; transition:all 0.15s; }
.d-seg-btn.active { background:#111827; color:#fff; }
.d-seg-btn:hover:not(.active) { background:#F3F4F6; }

/* Buttons */
.d-btn-primary { display:inline-flex; align-items:center; justify-content:center; background:#111827; color:#fff; font-size:13px; font-weight:600; padding:9px 18px; border-radius:8px; border:none; cursor:pointer; font-family:inherit; transition:all 0.15s; white-space:nowrap; }
.d-btn-primary:hover:not(:disabled) { background:#1F2937; }
.d-btn-primary:disabled { opacity:0.4; cursor:not-allowed; }
.d-btn-ghost { display:inline-flex; align-items:center; justify-content:center; background:#F3F4F6; color:#374151; font-size:13px; font-weight:500; padding:9px 18px; border-radius:8px; border:none; cursor:pointer; font-family:inherit; transition:all 0.15s; }
.d-btn-ghost:hover { background:#E5E7EB; }
.d-btn-danger { display:inline-flex; align-items:center; background:#EF4444; color:#fff; font-size:13px; font-weight:600; padding:9px 18px; border-radius:8px; border:none; cursor:pointer; font-family:inherit; transition:all 0.15s; }
.d-btn-danger:hover { background:#DC2626; }
.d-cta { font-size:14px; padding:10px 20px; }

/* Banners */
.d-banner { padding:10px 14px; border-radius:8px; font-size:12px; line-height:1.6; }
.d-banner-warn { background:#FFFBEB; border:1px solid #FDE68A; color:#92400E; }
.d-banner-info { background:#EFF6FF; border:1px solid #BFDBFE; color:#1E40AF; }

/* Inline error */
.d-inline-err { font-size:11px; color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; border-radius:6px; padding:4px 8px; margin-bottom:8px; line-height:1.4; }

/* Modal */
.d-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; z-index:9999; }
.d-modal { background:#fff; border-radius:14px; padding:24px; max-width:380px; width:90%; box-shadow:0 12px 40px rgba(0,0,0,0.18); }

@media(max-width:640px){ .d-page { padding:16px 14px 60px; } }
`;
