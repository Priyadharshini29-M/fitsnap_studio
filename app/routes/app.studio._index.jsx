/**
 * app.studio._index.jsx — AI Studio dashboard: asset library + saved models.
 */

import { useState, useRef, useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureMerchant } from "../lib/merchant.server";
import phpApiClient from "../lib/php-api.server";
import { PHP_API_URL } from "../lib/env.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const apiKey = await ensureMerchant(session);
  const api = phpApiClient(apiKey, PHP_API_URL, session.shop);
  const [assetsRes, modelsRes] = await Promise.all([
    api.studioV2ListAssets(),
    api.studioV2ListModels(),
  ]);
  return {
    assets: assetsRes.ok ? (assetsRes.data?.assets ?? []) : [],
    models: modelsRes.ok ? (modelsRes.data?.models ?? []) : [],
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
  if (body._action === "upload-model") {
    const res = await api.studioV2UploadModel(body.image_url);
    return Response.json(res.ok ? res.data : { error: res.error }, { status: res.ok ? 200 : 500 });
  }
  if (body._action === "delete-model") {
    const res = await api.studioV2DeleteModel(body.saved_model_id);
    return Response.json(res.ok ? res.data : { error: res.error }, { status: res.ok ? 200 : 500 });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
};

// ── Constants ─────────────────────────────────────────────────────────────────

const SOURCE_LABELS = {
  saved_model: "Saved Model",
  generation:  "Generated Model",
  infographic: "Infographic",
};

const PER_PAGE = 12;

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

const ACCEPTED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function validateModelFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Only JPG, PNG, or WEBP images are supported.";
  if (file.size > MAX_FILE_BYTES) return "File exceeds the 10 MB limit.";
  return null;
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="d-card">
      <div className="d-skel-thumb" />
      <div className="d-card-body">
        <div className="d-skel-line" style={{ width: "70%" }} />
        <div className="d-skel-line" style={{ width: "45%" }} />
      </div>
    </div>
  );
}

/** Thumbnail with graceful broken-image handling + retry (cache-busts the src). */
function AssetImage({ src, alt, className, style }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { setFailed(false); }, [src]);

  if (!src) {
    return (
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#D1D5DB"}}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
      </div>
    );
  }

  if (failed) {
    return (
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:"6px",color:"var(--ink-300)"}}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86l-8.18 14.18A1 1 0 003 19.5h18a1 1 0 00.87-1.5L13.71 3.86a1 1 0 00-1.72 0z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
        <span style={{fontSize:"10px"}}>Failed to load</span>
        <button
          type="button"
          className="d-act d-act-view"
          onClick={(e) => { e.stopPropagation(); setFailed(false); setAttempt((n) => n + 1); }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <img
      key={attempt}
      src={attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}` : src}
      alt={alt ?? ""}
      loading="lazy"
      className={className}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}

// ── Asset Library ─────────────────────────────────────────────────────────────

function DashboardView({ assets, loading, onCreate }) {
  const [search, setSearch]     = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort]         = useState("newest");
  const [page, setPage]         = useState(1);

  const filtered = assets
    .filter((a) => {
      if (typeFilter !== "all" && a.source_type !== typeFilter) return false;
      if (search) {
        const name = `${SOURCE_LABELS[a.source_type] ?? a.source_type} ${a.id}`.toLowerCase();
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

  const fmt = (d) => d ? new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—";

  if (loading) {
    return (
      <div className="d-grid">
        {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="d-toolbar">
        <div className="d-search-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{position:"absolute",left:"11px",top:"50%",transform:"translateY(-50%)",color:"var(--ink-300)",pointerEvents:"none"}}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          <input className="d-search" placeholder="Search assets…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <div style={{display:"flex",gap:"8px",flexWrap:"wrap"}}>
          <select className="d-select" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
            <option value="all">All Types</option>
            {Object.entries(SOURCE_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="d-select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </div>
      </div>

      {/* Empty */}
      {assets.length === 0 && (
        <div className="d-empty">
          <div className="d-empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="var(--accent-500)" strokeWidth="1.5" strokeLinejoin="round"/></svg>
          </div>
          <p className="d-empty-title">No assets yet</p>
          <p className="d-empty-sub">Create your first AI-generated product visual to get started.</p>
          <button className="d-btn-primary" onClick={onCreate}>Create New Asset</button>
        </div>
      )}

      {/* No results */}
      {assets.length > 0 && filtered.length === 0 && (
        <div className="d-empty" style={{paddingTop:"48px",paddingBottom:"48px"}}>
          <p className="d-empty-title" style={{fontSize:"13px"}}>No results</p>
          <p className="d-empty-sub">No assets match your current filters.</p>
          <button className="d-btn-ghost" onClick={() => { setSearch(""); setTypeFilter("all"); }}>Clear Filters</button>
        </div>
      )}

      {/* Grid */}
      {paged.length > 0 && (
        <div className="d-grid">
          {paged.map((a) => (
            <div key={a.id} className="d-card">
              <div className="d-card-thumb">
                <AssetImage src={a.thumbnail_url || a.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
              </div>
              <div className="d-card-body">
                <span style={{ fontSize:"10px",fontWeight:600,color:"var(--ink-500)",background:"var(--surface-2)",padding:"2px 8px",borderRadius:"4px" }}>
                  {SOURCE_LABELS[a.source_type] ?? a.source_type}
                </span>
                <p className="d-card-date">{fmt(a.created_at)}</p>
              </div>
              <div className="d-card-footer">
                <a href={a.url} target="_blank" rel="noreferrer" className="d-act d-act-view">View</a>
                <a href={a.url} download className="d-act d-act-dl">Download</a>
              </div>
            </div>
          ))}
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
          <span style={{fontSize:"11px",color:"var(--ink-300)"}}>{filtered.length} assets</span>
        </div>
      )}
    </div>
  );
}

// ── Saved Models (flat, no categorization) ────────────────────────────────────

function ModelsView({ models, loading }) {
  const [items, setItems] = useState(models);
  const [search, setSearch] = useState("");
  const inputRef = useRef(null);
  const uploadFetcher = useFetcher();
  const delFetcher = useFetcher();
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { setItems(models); }, [models]);

  useEffect(() => {
    if (uploadFetcher.state === "idle" && uploadFetcher.data !== undefined) {
      setUploading(false);
      if (uploadFetcher.data?.ok) {
        setItems((p) => [{ id: uploadFetcher.data.id, image_url: uploadFetcher.data.image_url, created_at: uploadFetcher.data.created_at }, ...p]);
        setErr(null);
      } else {
        setErr(uploadFetcher.data?.error ?? "Upload failed.");
      }
    }
  }, [uploadFetcher.state, uploadFetcher.data]);

  useEffect(() => {
    if (delFetcher.state === "idle" && delFetcher.data?.ok && confirmDel) {
      setItems((p) => p.filter((m) => m.id !== confirmDel.id));
      setConfirmDel(null);
    }
  }, [delFetcher.state, delFetcher.data]);

  const handleFile = async (file) => {
    if (!file) return;
    const validationError = validateModelFile(file);
    if (validationError) { setErr(validationError); return; }
    setUploading(true); setErr(null);
    try {
      const url = await uploadToTemp(file);
      uploadFetcher.submit({ _action: "upload-model", image_url: url }, { method: "POST", encType: "application/json" });
    } catch (e) { setUploading(false); setErr(e.message ?? "Upload failed."); }
  };

  const handleDelete = (model) => {
    setConfirmDel(model);
  };

  const confirmDelete = () => {
    delFetcher.submit({ _action: "delete-model", saved_model_id: confirmDel.id }, { method: "POST", encType: "application/json" });
  };

  const visible = items.filter((m) => !search || m.id.toLowerCase().includes(search.toLowerCase()));
  const fmt = (d) => d ? new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—";

  if (loading) {
    return (
      <div className="d-models-grid">
        {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    );
  }

  return (
    <div>
      <div className="d-models-top">
        <div>
          <p style={{fontWeight:700,fontSize:"13px",margin:"0 0 3px",color:"var(--ink-900)"}}>Saved Models</p>
          <p style={{fontSize:"12px",color:"var(--ink-500)",margin:0}}>
            Upload model photos to reuse across every product generation.
          </p>
        </div>
        <button className="d-btn-primary" disabled={uploading} onClick={() => inputRef.current?.click()}>
          {uploading ? "Uploading…" : "Upload New Model"}
        </button>
        <input ref={inputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" style={{display:"none"}}
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value=""; }} />
      </div>

      <div className="d-banner d-banner-info" style={{marginBottom:"16px"}}>
        <strong>Photo tips:</strong> Front-facing full-body, clean background. JPG / JPEG / PNG / WEBP, max 10 MB.
      </div>
      {err && <div className="d-inline-err" style={{marginBottom:"16px"}}>{err}</div>}

      <div className="d-search-wrap" style={{marginBottom:"20px",maxWidth:"320px"}}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{position:"absolute",left:"11px",top:"50%",transform:"translateY(-50%)",color:"var(--ink-300)",pointerEvents:"none"}}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        <input className="d-search" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {visible.length === 0 && (
        <div className="d-empty">
          <div className="d-empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="var(--accent-500)" strokeWidth="1.5"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="var(--accent-500)" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </div>
          <p className="d-empty-title">No saved models yet</p>
          <p className="d-empty-sub">Upload a model photo to start generating product visuals.</p>
          <button className="d-btn-primary" onClick={() => inputRef.current?.click()}>Upload New Model</button>
        </div>
      )}

      {visible.length > 0 && (
        <div className="d-models-grid">
          {visible.map((m) => (
            <div key={m.id} className="d-model-card">
              <div className="d-model-img">
                <AssetImage src={m.image_url} alt="Saved model" style={{width:"100%",height:"100%",objectFit:"cover"}} />
              </div>
              <div style={{padding:"10px 12px"}}>
                <p style={{fontSize:"10px",color:"var(--ink-300)",margin:"0 0 8px"}}>{fmt(m.created_at)}</p>
                <div style={{display:"flex",gap:"6px",flexWrap:"wrap"}}>
                  <button className="d-btn-primary" style={{flex:1,fontSize:"10px",padding:"6px 10px"}}
                    onClick={() => navigate(`/app/studio/create?saved_model_id=${encodeURIComponent(m.id)}`)}>
                    Use
                  </button>
                  <a className="d-act d-act-dl" href={m.image_url} download>Download</a>
                  <button className="d-act d-act-del" onClick={() => handleDelete(m)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmDel && (
        <div className="d-overlay" onClick={() => setConfirmDel(null)}>
          <div className="d-modal" onClick={(e) => e.stopPropagation()}>
            <p style={{fontWeight:700,fontSize:"13px",margin:"0 0 8px"}}>Delete this model?</p>
            <p style={{fontSize:"12px",color:"var(--ink-500)",margin:"0 0 20px",lineHeight:1.6}}>
              This will permanently remove this saved model. This cannot be undone.
            </p>
            <div style={{display:"flex",gap:"8px",justifyContent:"flex-end"}}>
              <button className="d-btn-ghost" onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="d-btn-danger" disabled={delFetcher.state !== "idle"} onClick={confirmDelete}>
                {delFetcher.state !== "idle" ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function StudioPage() {
  const { assets, models } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [tab, setTab] = useState("assets");
  const loading = navigation.state === "loading";

  return (
    <>
      <div className="d-page">

        {/* Header */}
        <div className="d-header">
          <div>
            <h1 className="d-title">AI Studio</h1>
            <p className="d-subtitle">Generate AI-powered product visuals and marketing creatives.</p>
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
            Saved Models
            <span className="d-tab-badge">{models.length}</span>
          </button>
        </div>

        {tab === "assets"
          ? <DashboardView assets={assets} loading={loading} onCreate={() => navigate("/app/studio/create")} />
          : <ModelsView models={models} loading={loading} />
        }
      </div>
    </>
  );
}

