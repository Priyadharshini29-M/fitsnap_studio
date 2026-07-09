/**
 * app.studio.create.jsx — AI Studio: workflow selector + 5 multi-step wizards.
 * Route: /app/studio/create
 */

import { useState, useRef, useCallback, useEffect } from "react";
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
  const [modelsRes, sessionsRes] = await Promise.all([
    api.studioGetModels(),
    api.studioListSessions({ limit: 50 }),
  ]);
  const sessions = sessionsRes.ok ? (sessionsRes.data?.sessions ?? []) : [];
  // Only offer results the merchant explicitly saved to the gallery — a fresh
  // Fashn AI generation the merchant hasn't kept yet shouldn't show up here.
  const savedGenerations = sessions.filter(
    (s) =>
      Number(s.saved_to_gallery) === 1 &&
      s.status === "completed" &&
      s.result_image_url,
  );
  return {
    models: modelsRes.ok ? (modelsRes.data?.models ?? {}) : {},
    savedGenerations,
  };
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const apiKey = await ensureMerchant(session);
  const api = phpApiClient(apiKey, PHP_API_URL, session.shop);
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body._action === "generate") {
    // Map workflow_type → garment_type so PHP's /studio/generate controller
    // can route to the correct AI model. PHP requires this field.
    const garmentTypeByWorkflow = {
      "model-generation": "full",
      "flat-lay": "top",
      mannequin: "top",
      accessories: "top",
      infographic: "full",
    };

    let modelKey = body.model_key || null;

    // "Upload New Model" in the wizard has no model_key yet — just an ad-hoc
    // photo URL. Claim the first unused registry slot for its gender and save
    // the photo there, so it also becomes reusable from "Select Saved Model".
    // Adult brackets are preferred — an arbitrary uploaded photo is virtually
    // always an adult, and mislabeling it into a child/teen slot can trip the
    // AI provider's content-safety checks (and mislabels the model regardless).
    if (!modelKey && body.model_image_url) {
      const gender = body.model_gender === "male" ? "male" : "female";
      const modelsRes = await api.studioGetModels();
      const models = modelsRes.ok ? (modelsRes.data?.models ?? {}) : {};
      const slotPriority = [
        "young_adult",
        "adult",
        "mature_adult",
        "plus_size",
        "teen_13_17",
        "child_9_12",
        "child_5_8",
      ].map((suffix) => `${gender}_${suffix}`);
      const emptySlot = slotPriority
        .map((key) => models[key])
        .find((m) => m && !m.image_exists);
      if (!emptySlot) {
        return Response.json(
          {
            error: `No empty ${gender} model slots available. Delete an existing model in Studio Models to add a new one.`,
          },
          { status: 400 },
        );
      }
      const saveRes = await api.studioSetModelImage(
        emptySlot.key,
        body.model_image_url,
      );
      if (!saveRes.ok) {
        return Response.json(
          { error: saveRes.error ?? "Failed to save model photo" },
          { status: 500 },
        );
      }
      modelKey = emptySlot.key;
    }

    const phpBody = {
      front_image_url: body.front_image_url || null,
      back_image_url: body.back_image_url || null,
      detail_image_1_url: body.detail_image_1_url || null,
      detail_image_2_url: body.detail_image_2_url || null,
      detail_image_3_url: body.detail_image_3_url || null,
      model_key: modelKey,
      garment_type:
        body.garment_type ??
        garmentTypeByWorkflow[body.workflow_type] ??
        "full",
      clothing_prompt: body.clothing_prompt || null,
      workflow_type: body.workflow_type || null,
      fashn_model: body.fashn_model || null,
    };
    if (!phpBody.front_image_url) {
      return Response.json(
        { error: "Product image is required." },
        { status: 400 },
      );
    }
    const res = await api.studioGenerate(phpBody);
    if (res.ok) return Response.json(res.data, { status: 200 });
    return Response.json(
      {
        error: res.error,
        session_id: res.data?.session_id,
        raw_error: res.data?.raw_error,
      },
      { status: 500 },
    );
  }
  if (body._action === "generate-status") {
    const res = await api.studioGenerateStatus(body.session_id);
    return Response.json(res.ok ? res.data : { error: res.error }, {
      status: res.ok ? 200 : 500,
    });
  }
  if (body._action === "set-model-image") {
    const res = await api.studioSetModelImage(body.model_key, body.image_url);
    return Response.json(res.ok ? res.data : { error: res.error }, {
      status: res.ok ? 200 : 500,
    });
  }
  if (body._action === "save-gallery") {
    await api.studioSaveGallery(body.session_id);
    return Response.json({ ok: true });
  }
  if (body._action === "infographic-create") {
    const res = await api.infographicCreate({
      product_image_url: body.product_image_url,
      description: body.description,
      style: body.style ?? "modern",
      custom_style_prompt: body.custom_style_prompt || null,
      product_category: body.product_category || "clothing",
    });
    return Response.json(
      res.ok
        ? res.data
        : { error: res.error ?? "Infographic generation failed" },
      { status: res.ok ? 200 : 500 },
    );
  }
  if (body._action === "infographic-edit") {
    const res = await api.infographicEdit({
      image_url: body.image_url,
      edit_prompt: body.edit_prompt,
      background_image_url: body.background_image_url || null,
    });
    return Response.json(
      res.ok ? res.data : { error: res.error ?? "Infographic edit failed" },
      { status: res.ok ? 200 : 500 },
    );
  }
  if (body._action === "infographic-generate") {
    const res = await api.infographicGenerate({
      product_image_url: body.product_image_url,
      key_points: body.key_points,
      style: body.style ?? "modern",
      custom_style_prompt: body.custom_style_prompt || null,
      product_category: body.product_category || "clothing",
      variation: body.variation ?? 1,
    });
    return Response.json(
      res.ok
        ? res.data
        : { error: res.error ?? "Infographic generation failed" },
      { status: res.ok ? 200 : 500 },
    );
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
};

// ── Constants ─────────────────────────────────────────────────────────────────

const FEMALE_KEYS = [
  "female_child_5_8",
  "female_child_9_12",
  "female_teen_13_17",
  "female_young_adult",
  "female_adult",
  "female_mature_adult",
  "female_plus_size",
];
const MALE_KEYS = [
  "male_child_5_8",
  "male_child_9_12",
  "male_teen_13_17",
  "male_young_adult",
  "male_adult",
  "male_mature_adult",
  "male_plus_size",
];
const FALLBACK_LABELS = {
  female_child_5_8: "Female Child (5–8 yrs)",
  female_child_9_12: "Female Child (9–12 yrs)",
  female_teen_13_17: "Female Teen (13–17 yrs)",
  female_young_adult: "Female Young Adult (18–25)",
  female_adult: "Female Adult (26–35)",
  female_mature_adult: "Female Mature (36–50)",
  female_plus_size: "Female Plus Size",
  male_child_5_8: "Male Child (5–8 yrs)",
  male_child_9_12: "Male Child (9–12 yrs)",
  male_teen_13_17: "Male Teen (13–17 yrs)",
  male_young_adult: "Male Young Adult (18–25)",
  male_adult: "Male Adult (26–35)",
  male_mature_adult: "Male Mature (36–50)",
  male_plus_size: "Male Plus Size",
};

const WORKFLOWS = [
  {
    id: "model-generation",
    title: "AI Model Generation",
    desc: "Generate realistic product-on-model images from your product photo.",
    steps: [
      "Product Type",
      "Product Image",
      "Model",
      "Settings",
      "Review",
      "Output",
    ],
  },
  {
    id: "flat-lay",
    title: "Flat Lay to Model",
    desc: "Convert flat lay garment photos into realistic worn-on-model photography.",
    steps: [
      "Product Type",
      "Flat Lay Image",
      "Model",
      "Product Details",
      "Settings",
      "Review",
      "Output",
    ],
  },
  {
    id: "mannequin",
    title: "Ghost Mannequin to Model",
    desc: "Transform invisible mannequin photography into realistic model photography.",
    steps: [
      "Product Type",
      "Mannequin Image",
      "Model",
      "Settings",
      "Review",
      "Output",
    ],
  },
  {
    id: "accessories",
    title: "Accessories Try-On",
    desc: "Place watches, jewellery, and bags on realistic model visuals.",
    steps: [
      "Choose Type",
      "Accessory Image",
      "Model",
      "Placement",
      "Settings",
      "Review",
      "Output",
    ],
  },
  {
    id: "infographic",
    title: "Marketing Infographic",
    desc: "Turn a saved Fashn AI model photo — or a fresh upload — into a promotional infographic with OpenAI-extracted highlights.",
    steps: ["Source Image", "Description", "Style", "Review", "Output"],
  },
];

const ACCESSORY_PLACEMENTS = {
  watch: ["Wrist (Left)", "Wrist (Right)"],
  necklace: ["Center Neck", "Layered", "Collarbone"],
  earring: ["Both Ears", "Left Ear", "Right Ear"],
  handbag: ["Shoulder (Left)", "Shoulder (Right)", "Held in Hand", "Crossbody"],
  sunglasses: ["On Face", "Held in Hand"],
  bracelet: ["Wrist (Left)", "Wrist (Right)", "Stacked"],
  ring: ["Ring Finger (Left)", "Ring Finger (Right)", "Index Finger"],
};

const TEMPLATES = [
  { id: "fashion", label: "Fashion", desc: "Editorial, trend-forward layout." },
  { id: "luxury", label: "Luxury", desc: "Minimalist, premium feel." },
  { id: "modern", label: "Modern", desc: "Clean grid, strong contrast." },
  { id: "minimal", label: "Minimal", desc: "White-space forward design." },
  {
    id: "ecommerce",
    label: "Ecommerce",
    desc: "Conversion-focused with callouts.",
  },
  {
    id: "catalog",
    label: "Catalog",
    desc: "Numbered spec markers, technical spec-sheet look.",
  },
  {
    id: "collage",
    label: "Collage",
    desc: "2x2 multi-panel grid, social-carousel style.",
  },
];

// ── Product type data ─────────────────────────────────────────────────────────

const PRODUCT_CATS = [
  // Ethnic / Full-Body Wear
  {
    id: "saree",
    label: "Saree",
    group: "ethnic",
    garmentType: "full",
    desc: "Silk, cotton or synthetic saree",
  },
  {
    id: "lehenga",
    label: "Lehenga / Ghagra",
    group: "ethnic",
    garmentType: "full",
    desc: "Bridal or festive lehenga",
  },
  {
    id: "dress",
    label: "Dress / Gown",
    group: "ethnic",
    garmentType: "full",
    desc: "Western or fusion dress",
  },
  {
    id: "coord-set",
    label: "Co-ord Set",
    group: "ethnic",
    garmentType: "full",
    desc: "Matching top & bottom set",
  },
  // Top Wear
  {
    id: "kurta",
    label: "Kurta / Kurti",
    group: "top-wear",
    garmentType: "top",
    desc: "Traditional Indian top wear",
  },
  {
    id: "tshirt",
    label: "T-Shirt / Top",
    group: "top-wear",
    garmentType: "top",
    desc: "Casual or graphic tee",
  },
  {
    id: "shirt",
    label: "Shirt / Blouse",
    group: "top-wear",
    garmentType: "top",
    desc: "Formal or casual shirt",
  },
  {
    id: "jacket",
    label: "Jacket / Blazer",
    group: "top-wear",
    garmentType: "top",
    desc: "Outerwear or formal jacket",
  },
  // Bottom Wear
  {
    id: "pants",
    label: "Pants / Jeans",
    group: "bottom-wear",
    garmentType: "bottom",
    desc: "Trousers, joggers or denim",
  },
  {
    id: "skirt",
    label: "Skirt / Palazzo",
    group: "bottom-wear",
    garmentType: "bottom",
    desc: "Skirt or wide-leg palazzo",
  },
  {
    id: "shorts",
    label: "Shorts / Leggings",
    group: "bottom-wear",
    garmentType: "bottom",
    desc: "Shorts or active leggings",
  },
  // Accessories
  {
    id: "jewellery",
    label: "Jewellery",
    group: "accessories",
    garmentType: "top",
    desc: "Necklace, earring, ring…",
    accCategory: "necklace",
  },
  {
    id: "watch",
    label: "Watch",
    group: "accessories",
    garmentType: "top",
    desc: "Wrist watch or smartwatch",
    accCategory: "watch",
  },
  {
    id: "handbag",
    label: "Bag / Handbag",
    group: "accessories",
    garmentType: "top",
    desc: "Clutch, tote or shoulder bag",
    accCategory: "handbag",
  },
  {
    id: "sunglasses",
    label: "Sunglasses",
    group: "accessories",
    garmentType: "top",
    desc: "Fashion or sport eyewear",
    accCategory: "sunglasses",
  },
  {
    id: "footwear",
    label: "Footwear",
    group: "accessories",
    garmentType: "bottom",
    desc: "Shoes, sandals or heels",
    accCategory: null,
  },
  // Other
  {
    id: "electronics",
    label: "Electronics / Mobile",
    group: "other",
    garmentType: "full",
    desc: "Gadgets, mobile or device",
  },
  {
    id: "other",
    label: "Other Product",
    group: "other",
    garmentType: "full",
    desc: "Product not listed above",
  },
];

const CLOTHING_GROUPS = ["ethnic", "top-wear", "bottom-wear"];

const WEAR_TYPES = [
  { id: "full", label: "Full Body", desc: "Complete head-to-toe look" },
  { id: "top", label: "Top Wear Focus", desc: "Waist-up / bust shot" },
  { id: "bottom", label: "Bottom Wear Focus", desc: "Hip-down / leg shot" },
];

function buildProductPrompt(productType, wearType) {
  const cat = PRODUCT_CATS.find((c) => c.id === productType);
  if (!cat) return null;
  const wearSuffix =
    wearType === "top"
      ? ", waist-up model shot"
      : wearType === "bottom"
        ? ", hip-down model shot"
        : ", full-body model shot";
  return `${cat.label}${wearSuffix}`;
}

// ── Upload helper (with proper error handling) ────────────────────────────────

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
  if (!data.tempUrl)
    throw new Error("Upload succeeded but no URL was returned.");
  return data.tempUrl;
}

/**
 * Triggers a real file download for a (usually cross-origin) generated-image
 * URL. A plain <a download> is silently ignored by browsers when the URL is
 * cross-origin, so this routes through /api/download, which proxies the file
 * server-side and forces it with a Content-Disposition header.
 */
function downloadUrl(url, filename) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = `/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
  a.click();
}

// ── Resolve model info ────────────────────────────────────────────────────────

function resolveModel(models, key) {
  const s = models[key];
  return {
    key,
    label: s?.label ?? FALLBACK_LABELS[key] ?? key,
    gender: s?.gender ?? (key.startsWith("male") ? "male" : "female"),
    image_exists: s?.image_exists ?? false,
    image_url: s?.image_url ?? null,
    image_hash: s?.image_hash ?? null,
  };
}

// ── Shared atoms ──────────────────────────────────────────────────────────────

function Spin({ size = 20, color = "#4F46E5" }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}22`,
        borderTop: `2px solid ${color}`,
        borderRadius: "50%",
        display: "inline-block",
        animation: "cr-spin 0.75s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

function FieldLabel({ children, required, hint }) {
  return (
    <div
      style={{
        marginBottom: "6px",
        display: "flex",
        alignItems: "baseline",
        gap: "4px",
      }}
    >
      <span style={{ fontSize: "13px", fontWeight: 600, color: "#111827" }}>
        {children}
      </span>
      {required && (
        <span style={{ color: "#EF4444", fontSize: "12px" }}>*</span>
      )}
      {hint && (
        <span style={{ fontSize: "11px", color: "#9CA3AF", fontWeight: 400 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

function CrSelect({ label, required, value, onChange, options, hint }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      {label && (
        <FieldLabel required={required} hint={hint}>
          {label}
        </FieldLabel>
      )}
      <select
        className="cr-input"
        style={{ cursor: "pointer" }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value ?? o} value={o.value ?? o}>
            {o.label ?? o}
          </option>
        ))}
      </select>
    </div>
  );
}

function CrTextarea({
  label,
  required,
  value,
  onChange,
  placeholder,
  rows = 3,
  hint,
}) {
  return (
    <div style={{ marginBottom: "14px" }}>
      {label && (
        <FieldLabel required={required} hint={hint}>
          {label}
        </FieldLabel>
      )}
      <textarea
        className="cr-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ resize: "vertical", lineHeight: 1.5 }}
      />
    </div>
  );
}

function CrInput({ label, value, onChange, placeholder, hint }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      {label && <FieldLabel hint={hint}>{label}</FieldLabel>}
      <input
        className="cr-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

// ── Upload Zone ───────────────────────────────────────────────────────────────

function UploadZone({
  label,
  required,
  value,
  onChange,
  hint,
  compact = false,
  note,
}) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("Invalid file type. Please use JPEG, PNG, or WEBP.");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setError("File is too large. Maximum size is 5 MB.");
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const url = await uploadToTemp(file);
        onChange(url);
      } catch (e) {
        setError(e.message ?? "Upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [onChange],
  );

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDrag(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const height = compact ? "90px" : "140px";

  return (
    <div style={{ marginBottom: "16px" }}>
      {label && (
        <FieldLabel required={required} hint={hint}>
          {label}
        </FieldLabel>
      )}
      {note && (
        <p
          style={{
            fontSize: "12px",
            color: "#6B7280",
            margin: "0 0 8px",
            lineHeight: 1.5,
            background: "#F9FAFB",
            padding: "8px 10px",
            borderRadius: "6px",
            borderLeft: "3px solid #D1D5DB",
          }}
        >
          {note}
        </p>
      )}

      <div
        className={`cr-zone ${drag ? "drag" : ""} ${value ? "filled" : ""} ${error ? "errored" : ""}`}
        style={{ height }}
        role="button"
        tabIndex={0}
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !uploading) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        {uploading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <Spin size={22} />
            <span style={{ fontSize: "12px", color: "#6B7280" }}>
              Uploading…
            </span>
          </div>
        ) : value ? (
          <>
            <img
              src={value}
              alt="Uploaded"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                padding: "6px",
                boxSizing: "border-box",
              }}
            />
            <div className="cr-zone-bar">✓ Uploaded — click to replace</div>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "12px" }}>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              style={{
                color: "#9CA3AF",
                display: "block",
                margin: "0 auto 8px",
              }}
            >
              <path
                d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <polyline
                points="17,8 12,3 7,8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <line
                x1="12"
                y1="3"
                x2="12"
                y2="15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <p
              style={{
                fontSize: "12px",
                color: "#6B7280",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              Drop image here or{" "}
              <span style={{ color: "#4F46E5", fontWeight: 600 }}>
                click to browse
              </span>
            </p>
            <p
              style={{ fontSize: "10px", color: "#9CA3AF", margin: "4px 0 0" }}
            >
              JPEG · PNG · WEBP · Max 5 MB
            </p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="cr-field-error">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            style={{ flexShrink: 0 }}
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M12 8v4M12 16h.01"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {error}
          <button
            onClick={() => setError(null)}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              fontSize: "14px",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ── Workflow colour map ───────────────────────────────────────────────────────

const WF_COLORS = {
  "model-generation": {
    accent: "#6366F1",
    light: "#EEF2FF",
    dark: "#4338CA",
    time: "~45 sec",
  },
  "flat-lay": {
    accent: "#0EA5E9",
    light: "#E0F2FE",
    dark: "#0284C7",
    time: "~60 sec",
  },
  mannequin: {
    accent: "#7C3AED",
    light: "#F5F3FF",
    dark: "#6D28D9",
    time: "~50 sec",
  },
  accessories: {
    accent: "#F59E0B",
    light: "#FEF3C7",
    dark: "#D97706",
    time: "~40 sec",
  },
  infographic: {
    accent: "#10B981",
    light: "#D1FAE5",
    dark: "#059669",
    time: "~90 sec",
  },
};

// ── Progress Stepper ──────────────────────────────────────────────────────────

function Stepper({ steps, current, wfId }) {
  const col = WF_COLORS[wfId] ?? { accent: "#4F46E5", light: "#EEF2FF" };
  // pct = how far along the rail (0 at first dot, 100 at last dot)
  const pct = steps.length > 1 ? (current / (steps.length - 1)) * 100 : 0;

  return (
    <div className="cr-stepper">
      {/* Context row */}
      <div className="cr-step-ctx">
        <span
          className="cr-step-pill"
          style={{ background: col.light, color: col.accent }}
        >
          Step {current + 1} / {steps.length}
        </span>
        <span className="cr-step-curname">{steps[current]}</span>
      </div>

      {/* Connected track */}
      <div className="cr-track">
        {/* Gray rail that spans dot-center to dot-center */}
        <div className="cr-rail-bg" />
        {/* Coloured fill — width is pct% of the rail span (100% - 28px) */}
        <div
          className="cr-rail-fill"
          style={{
            width: `calc(${pct / 100} * (100% - 28px))`,
            background: col.accent,
          }}
        />

        {/* Dots */}
        <div className="cr-dots">
          {steps.map((label, i) => {
            const done = i < current;
            const active = i === current;
            return (
              <div key={i} className="cr-dot-item">
                <div
                  className={`cr-dot-circle ${done ? "done" : active ? "active" : "idle"}`}
                  style={
                    active
                      ? {
                          background: col.accent,
                          boxShadow: `0 0 0 4px ${col.light}, 0 0 0 7px ${col.accent}38`,
                        }
                      : {}
                  }
                >
                  {done ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M5 12l5 5L20 7"
                        stroke="#fff"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <span
                      className="cr-dot-n"
                      style={active ? { color: "#fff" } : {}}
                    >
                      {i + 1}
                    </span>
                  )}
                </div>
                <span
                  className={`cr-dot-lbl ${active ? "active" : done ? "done" : ""}`}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Step navigation ───────────────────────────────────────────────────────────

function StepNav({
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled = false,
  isGenerate = false,
}) {
  return (
    <div className="cr-nav">
      {onBack ? (
        <button className="cr-btn cr-btn-ghost" onClick={onBack}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            style={{ marginRight: "5px" }}
          >
            <path
              d="M19 12H5M5 12l6 6M5 12l6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back
        </button>
      ) : (
        <div />
      )}
      {isGenerate ? (
        <div className="cr-gen-wrap">
          <button
            className="cr-btn-generate"
            onClick={onNext}
            disabled={nextDisabled}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              style={{ marginRight: "8px" }}
            >
              <path
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                fill="currentColor"
              />
            </svg>
            {nextLabel}
          </button>
          <p className="cr-credit-note">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              style={{
                display: "inline",
                marginRight: "3px",
                verticalAlign: "middle",
              }}
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M12 8v4M12 16h.01"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            Uses 1 generation credit · Est. 30–90 seconds
          </p>
        </div>
      ) : (
        <button
          className="cr-btn cr-btn-primary"
          onClick={onNext}
          disabled={nextDisabled}
        >
          {nextLabel}
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            style={{ marginLeft: "6px" }}
          >
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

// ── Step card wrapper ─────────────────────────────────────────────────────────

function Card({ children, style }) {
  return (
    <div className="cr-card" style={style}>
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="cr-card-title">{children}</h2>;
}

function SectionDesc({ children }) {
  return <p className="cr-card-desc">{children}</p>;
}

// ── Infographic Addon ─────────────────────────────────────────────────────────

function InfographicAddon({
  checked,
  onChange,
  description,
  onDescriptionChange,
  style,
  onStyleChange,
  customStyle,
  onCustomStyleChange,
}) {
  return (
    <div className="cr-addon-row">
      <div
        className="cr-addon-inner"
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        style={{ cursor: "pointer" }}
      >
        <div className="cr-addon-icon-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M7 17V13M10 17V9M13 17v-5M16 17V7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="cr-addon-text">
          <p className="cr-addon-title">Also generate Marketing Infographic</p>
          <p className="cr-addon-sub">
            AI reads your product description, pulls out key highlights, and
            composes an infographic with your image.
          </p>
        </div>
        <div className="cr-addon-right">
          <span className="cr-addon-credit">+1 credit</span>
          <div className={`cr-toggle ${checked ? "on" : ""}`}>
            <div className="cr-toggle-thumb" />
          </div>
        </div>
      </div>

      {checked && (
        <div
          style={{ padding: "12px 14px 14px", borderTop: "1px solid #F3F4F6" }}
        >
          <div style={{ marginBottom: "10px" }}>
            <FieldLabel
              required
              hint="AI extracts 3–4 short highlights — no sentences"
            >
              Product Description
            </FieldLabel>
            <textarea
              className="cr-input"
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="e.g. This Banarasi silk saree is crafted from 100% pure Katan silk with intricate gold zari weaving across the pallu and double-layered border. Machine wash safe. Free size."
              rows={3}
              style={{ resize: "vertical", lineHeight: 1.5, margin: 0 }}
            />
          </div>
          <div style={{ marginBottom: "10px" }}>
            <FieldLabel hint="optional">Infographic Style</FieldLabel>
            <select
              className="cr-input"
              style={{ cursor: "pointer", margin: 0 }}
              value={style}
              onChange={(e) => onStyleChange(e.target.value)}
            >
              <option value="modern">Modern</option>
              <option value="fashion">Fashion</option>
              <option value="luxury">Luxury</option>
              <option value="minimal">Minimal</option>
              <option value="ecommerce">Ecommerce</option>
              <option value="catalog">Catalog</option>
              <option value="collage">Collage</option>
            </select>
          </div>
          <div style={{ marginBottom: 0 }}>
            <FieldLabel hint="optional — describe how you want the background/theme to look">
              Custom Background / Theme
            </FieldLabel>
            <textarea
              className="cr-input"
              value={customStyle}
              onChange={(e) => onCustomStyleChange(e.target.value)}
              placeholder="e.g. soft pastel pink background with floating stars, or a festive Diwali theme with diyas and marigold accents"
              rows={2}
              style={{ resize: "vertical", lineHeight: 1.5, margin: 0 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Product Type Selector ─────────────────────────────────────────────────────

const PT_GROUPS = [
  { label: "Ethnic / Full-Body Wear", key: "ethnic" },
  { label: "Top Wear", key: "top-wear" },
  { label: "Bottom Wear", key: "bottom-wear" },
  { label: "Accessories & Jewellery", key: "accessories" },
  { label: "Other", key: "other" },
];

function ProductTypeStep({
  productType,
  wearType,
  onTypeChange,
  onWearChange,
}) {
  const selected = PRODUCT_CATS.find((c) => c.id === productType);
  const isClothing = selected && CLOTHING_GROUPS.includes(selected.group);

  return (
    <div>
      {PT_GROUPS.map((g) => (
        <div key={g.key} style={{ marginBottom: "18px" }}>
          <p className="cr-pt-group">{g.label}</p>
          <div className="cr-pt-grid">
            {PRODUCT_CATS.filter((c) => c.group === g.key).map((cat) => (
              <button
                key={cat.id}
                className={`cr-pt-btn ${productType === cat.id ? "active" : ""}`}
                title={cat.desc}
                onClick={() => {
                  onTypeChange(cat.id);
                  onWearChange(cat.garmentType);
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      {isClothing && (
        <div className="cr-weartype-box">
          <FieldLabel hint="how should the model display this garment?">
            Model Shot Type
          </FieldLabel>
          <div className="cr-weartype-grid">
            {WEAR_TYPES.map((w) => (
              <button
                key={w.id}
                className={`cr-weartype-btn ${wearType === w.id ? "active" : ""}`}
                onClick={() => onWearChange(w.id)}
              >
                <span className="cr-weartype-label">{w.label}</span>
                <span className="cr-weartype-desc">{w.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Model Selector ────────────────────────────────────────────────────────────

function ModelSelector({ models, selectedKey, onSelect }) {
  const [tab, setTab] = useState("saved");
  const [newUrl, setNewUrl] = useState(null);

  // Merge both gender brackets into one flat list, keep only slots that
  // actually have a photo, and drop duplicate photos. Slots always have
  // distinct URLs (one file per slot), so the same photo saved into more
  // than one bracket is detected by content hash instead.
  const seenHashes = new Set();
  const savedModels = [...FEMALE_KEYS, ...MALE_KEYS]
    .map((key) => resolveModel(models, key))
    .filter((m) => {
      if (!m.image_exists || !m.image_url) return false;
      const dedupeKey = m.image_hash ?? m.image_url;
      if (seenHashes.has(dedupeKey)) return false;
      seenHashes.add(dedupeKey);
      return true;
    })
    .map((m, i) => ({ ...m, label: `Model ${i + 1}` }));

  return (
    <div>
      <div className="cr-model-tabs">
        <button
          className={`cr-model-tab ${tab === "saved" ? "active" : ""}`}
          onClick={() => setTab("saved")}
        >
          Select Saved Model
        </button>
        <button
          className={`cr-model-tab ${tab === "upload" ? "active" : ""}`}
          onClick={() => setTab("upload")}
        >
          Upload New Model
        </button>
      </div>

      {tab === "upload" ? (
        <div>
          <p
            style={{
              fontSize: "12px",
              color: "#6B7280",
              margin: "0 0 12px",
              lineHeight: 1.6,
              background: "#F9FAFB",
              padding: "8px 10px",
              borderRadius: "6px",
              borderLeft: "3px solid #D1D5DB",
            }}
          >
            Upload a full-body, front-facing model photo on a clean background.
            Min 768×1024 px. Max 5 MB.
          </p>
          <UploadZone
            label="Model Photo"
            required
            value={newUrl}
            onChange={(url) => {
              setNewUrl(url);
              onSelect("__custom__", url, "female");
            }}
          />
          {newUrl && (
            <div className="cr-ok-banner">
              ✓ Model photo ready. Continue to the next step.
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="cr-model-grid">
            {savedModels.map((m) => {
              const sel = selectedKey === m.key;
              return (
                <div
                  key={m.key}
                  className={`cr-model-card ${sel ? "selected" : ""}`}
                  title={m.label}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(m.key, m.image_url, m.gender)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(m.key, m.image_url, m.gender);
                    }
                  }}
                >
                  <div className="cr-model-thumb">
                    <img
                      src={m.image_url}
                      alt={m.label}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                    {sel && <div className="cr-model-tick">✓</div>}
                  </div>
                  <div className="cr-model-name">{m.label}</div>
                </div>
              );
            })}
            {savedModels.length === 0 && (
              <p
                style={{
                  fontSize: "12px",
                  color: "#9CA3AF",
                  gridColumn: "1 / -1",
                }}
              >
                No saved model photos yet — go to Studio Models to add one, or
                upload a new model above.
              </p>
            )}
          </div>
          {selectedKey && selectedKey !== "__custom__" && (
            <div className="cr-ok-banner">
              ✓ Selected:{" "}
              <strong>
                {savedModels.find((m) => m.key === selectedKey)?.label ??
                  "Model"}
              </strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Review summary helpers ────────────────────────────────────────────────────

function ReviewThumb({ label, src }) {
  if (!src) return null;
  return (
    <div style={{ textAlign: "center" }}>
      <img
        src={src}
        alt={label}
        style={{
          width: 72,
          height: 90,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid #E5E7EB",
          display: "block",
        }}
      />
      <span
        style={{
          fontSize: "10px",
          color: "#9CA3AF",
          marginTop: "4px",
          display: "block",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function ReviewTable({ rows }) {
  return (
    <div
      style={{
        border: "1px solid #E5E7EB",
        borderRadius: "8px",
        overflow: "hidden",
        marginTop: "16px",
      }}
    >
      {rows
        .filter(([, v]) => v)
        .map(([k, v], i) => (
          <div
            key={i}
            style={{
              display: "flex",
              padding: "9px 14px",
              borderBottom: i < rows.length - 1 ? "1px solid #F3F4F6" : "none",
            }}
          >
            <span
              style={{
                width: "130px",
                flexShrink: 0,
                fontSize: "12px",
                color: "#9CA3AF",
                fontWeight: 500,
              }}
            >
              {k}
            </span>
            <span
              style={{ fontSize: "12px", color: "#111827", fontWeight: 500 }}
            >
              {v}
            </span>
          </div>
        ))}
    </div>
  );
}

// ── Generating Screen ─────────────────────────────────────────────────────────

function GeneratingScreen({ wfId }) {
  const col = WF_COLORS[wfId] ?? { accent: "#4F46E5", light: "#EEF2FF" };
  const stages =
    wfId === "infographic"
      ? [
          "Loading your product image",
          "Composing infographic canvas",
          "Placing product on layout",
          "Rendering key-point badges",
          "Applying final design polish",
          "Saving your infographic",
        ]
      : [
          "Analysing uploaded image references",
          "Detecting garment shape and texture",
          "Selecting best model pose and drape",
          "Applying fabric physics and lighting",
          "Rendering at high resolution",
          "Final commercial quality pass",
        ];
  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const stage = setInterval(
      () => setIdx((i) => Math.min(i + 1, stages.length - 1)),
      12000,
    );
    const clock = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      clearInterval(stage);
      clearInterval(clock);
    };
  }, [stages.length]);

  const pct = Math.min(
    95,
    Math.round((idx / (stages.length - 1)) * 90) + Math.round(elapsed * 0.3),
  );

  return (
    <div className="cr-generating">
      {/* Animated ring */}
      <div className="cr-gen-orbit" style={{ "--accent": col.accent }}>
        <div className="cr-gen-orbit-ring" />
        <div className="cr-gen-orbit-inner" />
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          style={{ position: "absolute", zIndex: 2 }}
        >
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            fill={col.accent}
          />
        </svg>
      </div>

      <h3 className="cr-gen-title">Creating your image…</h3>
      <p className="cr-gen-sub">
        Do not close this tab — generation is in progress.
      </p>

      {/* Progress bar */}
      <div className="cr-gen-bar-track">
        <div
          className="cr-gen-bar-fill"
          style={{ width: `${pct}%`, background: col.accent }}
        />
      </div>
      <div className="cr-gen-pct" style={{ color: col.accent }}>
        {pct}%
      </div>

      {/* Stage list */}
      <div className="cr-gen-stages">
        {stages.map((s, i) => (
          <div
            key={i}
            className={`cr-gen-stage ${i < idx ? "done" : i === idx ? "active" : ""}`}
          >
            <div
              className="cr-gen-stage-icon"
              style={i === idx ? { background: col.accent } : {}}
            >
              {i < idx ? (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12l5 5L20 7"
                    stroke="#fff"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              ) : i === idx ? (
                <span className="cr-gen-pulse" />
              ) : (
                <span
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: "#D1D5DB",
                  }}
                />
              )}
            </div>
            {s}
          </div>
        ))}
      </div>

      <p className="cr-gen-timer">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          style={{
            display: "inline",
            marginRight: "4px",
            verticalAlign: "middle",
          }}
        >
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 7v5l3 3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {elapsed}s elapsed · Typical range: 30–90 seconds
      </p>
    </div>
  );
}

// ── Output Screen ─────────────────────────────────────────────────────────────

function OutputScreen({
  result,
  sessionId,
  onRegenerate,
  wfId,
  infographicResult,
  infographicLoading,
  infographicError,
  onInfographicUpdate,
  infographicRegenInput,
  onInfographicAppend,
}) {
  const col = WF_COLORS[wfId] ?? { accent: "#4F46E5", light: "#EEF2FF" };
  const fetcher = useFetcher();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setSaved(true);
  }, [fetcher.state, fetcher.data]);

  const save = () =>
    fetcher.submit(
      { _action: "save-gallery", session_id: sessionId },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
  const download = () => downloadUrl(result, `studio_${Date.now()}.jpg`);

  // ── Infographic "regenerate" (up to 5 visually distinct variations) ────────
  const regenFetcher = useFetcher();
  const [regenError, setRegenError] = useState(null);
  const isRegenerating = regenFetcher.state !== "idle";
  const regenCount = infographicResult?.length ?? 0;
  const canRegenerate =
    !!infographicRegenInput?.imageUrl &&
    infographicRegenInput?.keyPoints?.length > 0;

  useEffect(() => {
    if (regenFetcher.state === "idle" && regenFetcher.data) {
      if (regenFetcher.data.results?.length) {
        setRegenError(null);
        onInfographicAppend?.(regenFetcher.data.results[0]);
      } else if (regenFetcher.data.error) {
        setRegenError(regenFetcher.data.error);
      }
    }
  }, [regenFetcher.state, regenFetcher.data]);

  const regenerate = () => {
    if (!infographicRegenInput) return;
    setRegenError(null);
    regenFetcher.submit(
      {
        _action: "infographic-generate",
        product_image_url: infographicRegenInput.imageUrl,
        key_points: infographicRegenInput.keyPoints,
        style: infographicRegenInput.style ?? "modern",
        custom_style_prompt: infographicRegenInput.customStylePrompt || null,
        product_category: infographicRegenInput.category || "clothing",
        variation: regenCount + 1,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
  };

  return (
    <div>
      {/* Celebration header */}
      <div
        className="cr-complete-header"
        style={{ "--accent": col.accent, "--light": col.light }}
      >
        <div className="cr-complete-check" style={{ background: col.accent }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12l5 5L20 7"
              stroke="#fff"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <p className="cr-complete-title">Generation complete!</p>
          <p className="cr-complete-sub">
            Your asset is ready to download or save to your library.
          </p>
        </div>
        {/* Decorative dots */}
        <div className="cr-confetti">
          {[...Array(8)].map((_, i) => (
            <span
              key={i}
              className="cr-confetti-dot"
              style={{
                background: [
                  col.accent,
                  "#F59E0B",
                  "#10B981",
                  "#EC4899",
                  "#06B6D4",
                  "#F97316",
                ][i % 6],
                animationDelay: `${i * 0.12}s`,
                left: `${8 + i * 11}%`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Result image */}
      {result && (
        <>
          <a
            href={result}
            target="_blank"
            rel="noreferrer"
            className="cr-result-img-wrap"
            style={{ cursor: "zoom-in" }}
          >
            <img
              src={result}
              alt="Generated result"
              className="cr-result-img"
            />
          </a>

          {/* Actions */}
          <div className="cr-result-actions">
            <button className="cr-btn cr-btn-ghost" onClick={onRegenerate}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                style={{ marginRight: "5px" }}
              >
                <path
                  d="M3 12a9 9 0 119 9"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M3 7v5h5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Try Again
            </button>
            <button className="cr-btn cr-btn-outline" onClick={download}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                style={{ marginRight: "5px" }}
              >
                <path
                  d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <polyline
                  points="7,10 12,15 17,10"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <line
                  x1="12"
                  y1="3"
                  x2="12"
                  y2="15"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
              Download HD
            </button>
            <button
              className="cr-btn-save"
              style={{ background: col.accent }}
              onClick={save}
              disabled={saved || fetcher.state !== "idle"}
            >
              {saved
                ? "✓ Saved"
                : fetcher.state !== "idle"
                  ? "Saving…"
                  : "Save to Library →"}
            </button>
          </div>
        </>
      )}

      {/* Infographic result — OpenAI-generated creative variants */}
      {(infographicLoading ||
        infographicResult?.length > 0 ||
        infographicError) && (
        <div className="cr-info-result">
          <div className="cr-info-result-hdr">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              style={{ color: "#059669", flexShrink: 0 }}
            >
              <rect
                x="3"
                y="3"
                width="18"
                height="18"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M7 17V13M10 17V9M13 17v-5M16 17V7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            <p className="cr-info-result-title">Marketing Infographic</p>
            {infographicLoading && <Spin size={13} color="#059669" />}
          </div>
          {infographicLoading && (
            <div className="cr-info-loading">
              <Spin size={16} color="#059669" />
              <span className="cr-info-loading-text">
                Generating creatives in background…
              </span>
            </div>
          )}
          {infographicError &&
            !infographicLoading &&
            !infographicResult?.length && (
              <p
                style={{
                  fontSize: "12px",
                  color: "#DC2626",
                  margin: "4px 0 0",
                }}
              >
                Infographic generation failed: {infographicError}
              </p>
            )}
          {infographicResult?.length > 0 && (
            <InfographicGallery
              results={infographicResult}
              onUpdate={onInfographicUpdate}
            />
          )}
          {canRegenerate && (
            <div style={{ marginTop: "12px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                {regenCount < 5 ? (
                  <button
                    type="button"
                    className="cr-btn cr-btn-outline"
                    onClick={regenerate}
                    disabled={isRegenerating}
                  >
                    {isRegenerating ? (
                      <>
                        <Spin size={13} color="#059669" /> Generating…
                      </>
                    ) : (
                      `Regenerate — Try a Different Idea (${regenCount}/5)`
                    )}
                  </button>
                ) : (
                  <span style={{ fontSize: "12px", color: "#9CA3AF" }}>
                    Max 5 variations reached.
                  </span>
                )}
              </div>
              {regenError && (
                <p
                  style={{
                    fontSize: "12px",
                    color: "#DC2626",
                    margin: "8px 0 0",
                  }}
                >
                  Regeneration failed: {regenError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Grid of OpenAI-generated infographic creative variants, one per layout template. */
function InfographicGallery({ results, onUpdate }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(results.length, 3)}, minmax(0,1fr))`,
        gap: "12px",
        marginTop: "10px",
      }}
    >
      {results.map((r, i) => (
        <InfographicCard
          key={r.key}
          result={r}
          onUpdate={(newImage) => onUpdate?.(i, newImage)}
        />
      ))}
    </div>
  );
}

/** Single infographic result with download + a "describe your change" edit prompt (OpenAI images/edits). */
const TEXT_COLORS = [
  "#111827",
  "#1E3A8A",
  "#B91C1C",
  "#059669",
  "#B45309",
  "#7C3AED",
  "#FFFFFF",
];
const BG_COLORS = [
  "#FFFFFF",
  "#F9FAFB",
  "#FEF3C7",
  "#DBEAFE",
  "#FCE7F3",
  "#D1FAE5",
  "#111827",
];
const BG_GRADIENTS = [
  {
    id: "sunset",
    label: "Sunset",
    css: "linear-gradient(135deg,#FDE68A,#FCA5A5)",
    desc: "warm sunset gradient from soft yellow (#FDE68A) to soft coral (#FCA5A5)",
  },
  {
    id: "ocean",
    label: "Ocean",
    css: "linear-gradient(135deg,#BAE6FD,#818CF8)",
    desc: "cool ocean gradient from sky blue (#BAE6FD) to indigo (#818CF8)",
  },
  {
    id: "blush",
    label: "Blush",
    css: "linear-gradient(135deg,#FBCFE8,#E9D5FF)",
    desc: "soft blush gradient from pink (#FBCFE8) to lavender (#E9D5FF)",
  },
  {
    id: "mint",
    label: "Mint",
    css: "linear-gradient(135deg,#D1FAE5,#A7F3D0)",
    desc: "fresh mint gradient from light green (#D1FAE5) to mint (#A7F3D0)",
  },
  {
    id: "dusk",
    label: "Dusk",
    css: "linear-gradient(135deg,#1F2937,#4B5563)",
    desc: "moody dusk gradient from charcoal (#1F2937) to slate grey (#4B5563)",
  },
];

function InfographicCard({ result, onUpdate }) {
  const editFetcher = useFetcher();
  const [panel, setPanel] = useState(null); // null | "prompt" | "style"
  const [editPrompt, setEditPrompt] = useState("");
  const [textColor, setTextColor] = useState(null);
  const [textSize, setTextSize] = useState(null);
  const [textWeight, setTextWeight] = useState(null);
  const [bgColor, setBgColor] = useState(null);
  const [bgGradient, setBgGradient] = useState(null);
  const [bgImageUrl, setBgImageUrl] = useState(null);
  const [bgUploading, setBgUploading] = useState(false);
  const [editError, setEditError] = useState(null);
  const isEditing = editFetcher.state !== "idle";

  useEffect(() => {
    if (editFetcher.state === "idle" && editFetcher.data) {
      if (editFetcher.data.results?.length) {
        onUpdate(editFetcher.data.results[0].image);
        setPanel(null);
        setEditPrompt("");
        setTextColor(null);
        setTextSize(null);
        setTextWeight(null);
        setBgColor(null);
        setBgGradient(null);
        setBgImageUrl(null);
        setEditError(null);
      } else if (editFetcher.data.error) {
        setEditError(editFetcher.data.error);
      }
    }
  }, [editFetcher.state, editFetcher.data]);

  const submitEdit = (prompt, backgroundImageUrl = null) => {
    setEditError(null);
    editFetcher.submit(
      {
        _action: "infographic-edit",
        image_url: result.image,
        edit_prompt: prompt,
        background_image_url: backgroundImageUrl,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
  };

  const applyEdit = () => {
    if (editPrompt.trim()) submitEdit(editPrompt);
  };

  const pickSolidColor = (c) => {
    setBgColor((v) => (v === c ? null : c));
    setBgGradient(null);
    setBgImageUrl(null);
  };
  const pickGradient = (g) => {
    setBgGradient((v) => (v?.id === g.id ? null : g));
    setBgColor(null);
    setBgImageUrl(null);
  };

  const uploadBgImage = async (file) => {
    if (!file) return;
    setBgUploading(true);
    setEditError(null);
    try {
      const url = await uploadToTemp(file);
      setBgImageUrl(url);
      setBgColor(null);
      setBgGradient(null);
    } catch (e) {
      setEditError(e.message ?? "Background upload failed.");
    } finally {
      setBgUploading(false);
    }
  };

  const hasStyleChange = !!(
    textColor ||
    textSize ||
    textWeight ||
    bgColor ||
    bgGradient ||
    bgImageUrl
  );
  const applyStyle = () => {
    if (!hasStyleChange) return;
    const parts = [];
    if (textColor) parts.push(`change all label text color to ${textColor}`);
    if (textSize) parts.push(`make the label text ${textSize}-sized`);
    if (textWeight) parts.push(`make the label text ${textWeight}`);
    if (bgColor)
      parts.push(`change the background to a solid ${bgColor} color`);
    if (bgGradient) parts.push(`change the background to a ${bgGradient.desc}`);
    if (bgImageUrl)
      parts.push(
        "use the second provided reference image as the new background, extended/cropped to fill the frame",
      );
    submitEdit(
      `Update this marketing infographic: ${parts.join("; ")}. Keep the product photo — including the model's ` +
        `exact face, identity, and expression if a person appears in it — plus the label positions and label text ` +
        `content exactly the same. Only apply the styling changes described above.`,
      bgImageUrl,
    );
  };

  return (
    <div>
      <a
        href={result.image}
        target="_blank"
        rel="noreferrer"
        className="cr-result-img-wrap"
        style={{ position: "relative", cursor: "zoom-in" }}
      >
        <img src={result.image} alt={result.label} className="cr-result-img" />
        {isEditing && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(255,255,255,0.85)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px",
            }}
          >
            <Spin size={20} color="#059669" />
            <span
              style={{ fontSize: "11px", fontWeight: 600, color: "#059669" }}
            >
              Applying edit…
            </span>
          </div>
        )}
      </a>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingTop: "8px",
          gap: "8px",
        }}
      >
        <span style={{ fontSize: "12px", fontWeight: 600, color: "#374151" }}>
          {result.label}
        </span>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            type="button"
            className="cr-btn cr-btn-outline"
            style={{ padding: "4px 10px", fontSize: "12px" }}
            onClick={() => setPanel((p) => (p === "style" ? null : "style"))}
            disabled={isEditing}
          >
            Style
          </button>
          <button
            type="button"
            className="cr-btn cr-btn-outline"
            style={{ padding: "4px 10px", fontSize: "12px" }}
            onClick={() => setPanel((p) => (p === "prompt" ? null : "prompt"))}
            disabled={isEditing}
          >
            Edit
          </button>
          <button
            type="button"
            className="cr-btn cr-btn-outline"
            style={{ padding: "4px 10px", fontSize: "12px" }}
            onClick={() =>
              downloadUrl(
                result.image,
                `infographic_${result.key}_${Date.now()}.png`,
              )
            }
          >
            Download
          </button>
        </div>
      </div>

      {panel === "style" && (
        <div
          style={{
            marginTop: "8px",
            padding: "10px",
            background: "#F9FAFB",
            border: "1px solid #E5E7EB",
            borderRadius: "8px",
          }}
        >
          <FieldLabel hint="optional">Text Color</FieldLabel>
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: "10px",
            }}
          >
            {TEXT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setTextColor((v) => (v === c ? null : c))}
                title={c}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: c,
                  cursor: "pointer",
                  border:
                    textColor === c ? "2px solid #4F46E5" : "1px solid #E5E7EB",
                }}
              />
            ))}
            <input
              type="color"
              title="Custom color"
              value={textColor ?? "#111827"}
              onChange={(e) => setTextColor(e.target.value)}
              style={{
                width: 24,
                height: 24,
                padding: 0,
                border: "1px solid #E5E7EB",
                borderRadius: "50%",
                cursor: "pointer",
                overflow: "hidden",
              }}
            />
          </div>
          <FieldLabel hint="optional">Text Size</FieldLabel>
          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            {["small", "medium", "large"].map((s) => (
              <button
                key={s}
                type="button"
                className={`cr-choice-btn ${textSize === s ? "active" : ""}`}
                onClick={() => setTextSize((v) => (v === s ? null : s))}
              >
                {s}
              </button>
            ))}
          </div>
          <FieldLabel hint="optional">Text Weight</FieldLabel>
          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            {["regular", "bold"].map((w) => (
              <button
                key={w}
                type="button"
                className={`cr-choice-btn ${textWeight === w ? "active" : ""}`}
                onClick={() => setTextWeight((v) => (v === w ? null : w))}
              >
                {w}
              </button>
            ))}
          </div>
          <FieldLabel hint="optional — solid color">Background</FieldLabel>
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: "10px",
            }}
          >
            {BG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => pickSolidColor(c)}
                title={c}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "6px",
                  background: c,
                  cursor: "pointer",
                  border:
                    bgColor === c ? "2px solid #4F46E5" : "1px solid #E5E7EB",
                }}
              />
            ))}
            <input
              type="color"
              title="Custom color"
              value={bgColor ?? "#FFFFFF"}
              onChange={(e) => pickSolidColor(e.target.value)}
              style={{
                width: 24,
                height: 24,
                padding: 0,
                border: "1px solid #E5E7EB",
                borderRadius: "6px",
                cursor: "pointer",
                overflow: "hidden",
              }}
            />
          </div>
          <FieldLabel hint="optional — linear gradient">
            Gradient Background
          </FieldLabel>
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              marginBottom: "10px",
            }}
          >
            {BG_GRADIENTS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => pickGradient(g)}
                title={g.label}
                style={{
                  width: 28,
                  height: 22,
                  borderRadius: "6px",
                  background: g.css,
                  cursor: "pointer",
                  border:
                    bgGradient?.id === g.id
                      ? "2px solid #4F46E5"
                      : "1px solid #E5E7EB",
                }}
              />
            ))}
          </div>
          <FieldLabel hint="optional — upload your own background photo">
            Image Background
          </FieldLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "10px",
            }}
          >
            {bgImageUrl ? (
              <>
                <img
                  src={bgImageUrl}
                  alt="Background reference"
                  style={{
                    width: 36,
                    height: 36,
                    objectFit: "cover",
                    borderRadius: "6px",
                    border: "1px solid #E5E7EB",
                  }}
                />
                <button
                  type="button"
                  className="cr-btn cr-btn-outline"
                  style={{ padding: "3px 8px", fontSize: "11px" }}
                  onClick={() => setBgImageUrl(null)}
                >
                  Remove
                </button>
              </>
            ) : (
              <label
                className="cr-btn cr-btn-outline"
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  cursor: "pointer",
                  display: "inline-flex",
                }}
              >
                {bgUploading ? "Uploading…" : "Upload Image"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  style={{ display: "none" }}
                  disabled={bgUploading}
                  onChange={(e) => {
                    uploadBgImage(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          {editError && (
            <p
              style={{ fontSize: "11px", color: "#DC2626", margin: "0 0 8px" }}
            >
              {editError}
            </p>
          )}
          <button
            type="button"
            className="cr-btn-save"
            style={{
              background: "#059669",
              fontSize: "12px",
              padding: "6px 14px",
            }}
            onClick={applyStyle}
            disabled={isEditing || !hasStyleChange}
          >
            {isEditing ? "Applying…" : "Apply Style"}
          </button>
        </div>
      )}

      {panel === "prompt" && (
        <div
          style={{
            marginTop: "8px",
            padding: "10px",
            background: "#F9FAFB",
            border: "1px solid #E5E7EB",
            borderRadius: "8px",
          }}
        >
          <textarea
            className="cr-input"
            rows={2}
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            placeholder="Describe the change — e.g. “remove the bottom label”, “add a festive theme”"
            style={{ resize: "vertical", margin: "0 0 8px", fontSize: "12px" }}
          />
          {editError && (
            <p
              style={{ fontSize: "11px", color: "#DC2626", margin: "0 0 8px" }}
            >
              {editError}
            </p>
          )}
          <button
            type="button"
            className="cr-btn-save"
            style={{
              background: "#059669",
              fontSize: "12px",
              padding: "6px 14px",
            }}
            onClick={applyEdit}
            disabled={isEditing || !editPrompt.trim()}
          >
            {isEditing ? "Applying…" : "Apply Edit"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Error Banner ──────────────────────────────────────────────────────────────

function ErrBanner({ msg, onDismiss }) {
  return (
    <div className="cr-err-banner">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        style={{ flexShrink: 0 }}
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 8v4M12 16h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span style={{ flex: 1 }}>{msg}</span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "inherit",
          fontSize: "16px",
          padding: "0 2px",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// WORKFLOW 1 — AI MODEL GENERATION
// ════════════════════════════════════════════════════════════════════════════

function WorkflowModelGeneration({ models }) {
  const wfId = "model-generation";
  const fetcher = useFetcher();
  const infoFetcher = useFetcher();
  const [step, setStep] = useState(0);
  const [productType, setProductType] = useState(null);
  const [wearType, setWearType] = useState("full");
  const [frontUrl, setFrontUrl] = useState(null);
  const [backUrl, setBackUrl] = useState(null);
  const [extraUrls, setExtraUrls] = useState([]);
  const extraRef = useRef(null);
  const [uploadingExtra, setUploadingExtra] = useState(false);
  const [extraErr, setExtraErr] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [modelUrl, setModelUrl] = useState(null);
  const [modelGender, setModelGender] = useState(null);
  const [settings, setSettings] = useState({
    gender: "female",
    ageGroup: "adult",
    ethnicity: "any",
    bodyType: "average",
    pose: "standing-natural",
    background: "clean-white",
    aspectRatio: "3:4",
  });
  const [result, setResult] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [pendingSessionId, setPendingSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [withInfographic, setWithInfographic] = useState(false);
  const [infoDescription, setInfoDescription] = useState("");
  const [infoStyle, setInfoStyle] = useState("modern");
  const [infoCustomStyle, setInfoCustomStyle] = useState("");
  const [infographicResult, setInfographicResult] = useState(null);
  const [infographicKeyPoints, setInfographicKeyPoints] = useState([]);
  const [infographicError, setInfographicError] = useState(null);
  const statusFetcher = useFetcher();

  const isGenerating = fetcher.state !== "idle" || !!pendingSessionId;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.status === "processing" && fetcher.data.session_id) {
        setPendingSessionId(fetcher.data.session_id);
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
        setStep(4);
      } // back to Review on failure
    }
  }, [fetcher.state, fetcher.data]);

  // Poll for the async result — generation runs on Fashn's side and a single
  // request can't block on it without risking the host's connection timeout.
  useEffect(() => {
    if (!pendingSessionId) return;
    const poll = () => {
      if (statusFetcher.state === "idle") {
        statusFetcher.submit(
          { _action: "generate-status", session_id: pendingSessionId },
          {
            method: "POST",
            action: "/app/studio/create",
            encType: "application/json",
          },
        );
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [pendingSessionId, statusFetcher]);

  useEffect(() => {
    if (statusFetcher.state === "idle" && statusFetcher.data) {
      if (statusFetcher.data.status === "completed") {
        setResult(statusFetcher.data.result_image);
        setSessionId(statusFetcher.data.session_id ?? null);
        setPendingSessionId(null);
        setStep(6);
      } else if (statusFetcher.data.status === "failed") {
        setError(statusFetcher.data.error);
        setPendingSessionId(null);
        setStep(4); // back to Review on failure
      }
    }
  }, [statusFetcher.state, statusFetcher.data]);

  useEffect(() => {
    if (infoFetcher.state === "idle" && infoFetcher.data) {
      if (infoFetcher.data.results?.length) {
        setInfographicError(null);
        setInfographicResult(infoFetcher.data.results);
        setInfographicKeyPoints(infoFetcher.data.key_points ?? []);
      } else if (infoFetcher.data.error) {
        setInfographicError(infoFetcher.data.error);
      }
    }
  }, [infoFetcher.state, infoFetcher.data]);

  const addExtra = async (file) => {
    if (!file || extraUrls.length >= 3) return;
    if (!file.type.startsWith("image/")) {
      setExtraErr("Images only.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setExtraErr("Max 5 MB.");
      return;
    }
    setUploadingExtra(true);
    setExtraErr(null);
    try {
      const url = await uploadToTemp(file);
      setExtraUrls((p) => [...p, url]);
    } catch (e) {
      setExtraErr(e.message ?? "Upload failed.");
    } finally {
      setUploadingExtra(false);
    }
  };

  const doGenerate = () => {
    setError(null);
    const productPrompt = buildProductPrompt(productType, wearType);
    const productCat = PRODUCT_CATS.find((c) => c.id === productType);
    fetcher.submit(
      {
        _action: "generate",
        workflow_type: "model-generation",
        front_image_url: frontUrl,
        back_image_url: backUrl || null,
        detail_image_1_url: extraUrls[0] || null,
        detail_image_2_url: extraUrls[1] || null,
        detail_image_3_url: extraUrls[2] || null,
        model_key: selectedModel !== "__custom__" ? selectedModel : null,
        model_image_url: selectedModel === "__custom__" ? modelUrl : null,
        model_gender: selectedModel === "__custom__" ? modelGender : null,
        garment_type: productCat?.garmentType ?? wearType ?? "full",
        clothing_prompt: productPrompt || null,
        ...settings,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
    if (withInfographic && infoDescription.trim()) {
      infoFetcher.submit(
        {
          _action: "infographic-create",
          product_image_url: frontUrl,
          description: infoDescription,
          style: infoStyle,
          custom_style_prompt: infoCustomStyle,
        },
        {
          method: "POST",
          action: "/app/studio/create",
          encType: "application/json",
        },
      );
    }
  };

  const S = (f, v) => setSettings((p) => ({ ...p, [f]: v }));
  const steps = WORKFLOWS[0].steps;

  if (step === 6 && result)
    return (
      <div>
        <Stepper steps={steps} wfId={wfId} current={6} />
        <Card>
          <OutputScreen
            result={result}
            sessionId={sessionId}
            wfId={wfId}
            onRegenerate={() => {
              setResult(null);
              setInfographicResult(null);
              setStep(0);
            }}
            infographicResult={infographicResult}
            infographicLoading={
              withInfographic &&
              infoFetcher.state !== "idle" &&
              !infographicResult
            }
            infographicError={infographicError}
            onInfographicUpdate={(idx, url) =>
              setInfographicResult((prev) =>
                prev
                  ? prev.map((r, i) => (i === idx ? { ...r, image: url } : r))
                  : prev,
              )
            }
            onInfographicAppend={(r) =>
              setInfographicResult((prev) => (prev ? [...prev, r] : [r]))
            }
            infographicRegenInput={{
              imageUrl: frontUrl,
              keyPoints: infographicKeyPoints,
              style: infoStyle,
              customStylePrompt: infoCustomStyle,
              category: "clothing",
            }}
          />
        </Card>
      </div>
    );
  if (isGenerating)
    return (
      <div>
        <Stepper steps={steps} wfId={wfId} current={5} />
        <Card>
          <GeneratingScreen wfId={wfId} />
        </Card>
      </div>
    );

  return (
    <div>
      <Stepper steps={steps} wfId={wfId} current={step} />
      {error && <ErrBanner msg={error} onDismiss={() => setError(null)} />}

      {step === 0 && (
        <Card>
          <SectionTitle>What are you selling?</SectionTitle>
          <SectionDesc>
            Select your product type so the AI applies the right drape, fit and
            framing.
          </SectionDesc>
          <ProductTypeStep
            productType={productType}
            wearType={wearType}
            onTypeChange={setProductType}
            onWearChange={setWearType}
          />
          <StepNav onNext={() => setStep(1)} nextDisabled={!productType} />
        </Card>
      )}

      {step === 1 && (
        <Card>
          <SectionTitle>Upload Product Images</SectionTitle>
          <SectionDesc>
            Add front, back and detail shots — more angles give the AI better
            accuracy and drape results.
          </SectionDesc>
          <div className="cr-req-row">
            {["High resolution", "Clean background", "JPEG / PNG / WEBP"].map(
              (r) => (
                <span key={r} className="cr-req">
                  {r}
                </span>
              ),
            )}
          </div>
          <div className="cr-img-pair">
            <UploadZone
              label="Front View"
              required
              value={frontUrl}
              onChange={setFrontUrl}
            />
            <UploadZone
              label="Back View"
              value={backUrl}
              onChange={setBackUrl}
              hint="optional"
            />
          </div>
          <div style={{ marginBottom: "4px" }}>
            <FieldLabel hint="optional — up to 3 more">
              Additional Detail Images
            </FieldLabel>
            <div className="cr-img-grid">
              {extraUrls.map((url, i) => (
                <div key={i} className="cr-img-thumb">
                  <img
                    src={url}
                    alt={`Detail ${i + 1}`}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                  <button
                    className="cr-img-rm"
                    onClick={() =>
                      setExtraUrls((p) => p.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              {extraUrls.length < 3 && (
                <div
                  className={`cr-img-add ${uploadingExtra ? "busy" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => !uploadingExtra && extraRef.current?.click()}
                  onKeyDown={(e) => {
                    if (
                      (e.key === "Enter" || e.key === " ") &&
                      !uploadingExtra
                    ) {
                      e.preventDefault();
                      extraRef.current?.click();
                    }
                  }}
                >
                  {uploadingExtra ? (
                    <Spin size={18} />
                  ) : (
                    <>
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        style={{ color: "#9CA3AF" }}
                      >
                        <path
                          d="M12 5v14M5 12h14"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span
                        style={{
                          fontSize: "11px",
                          color: "#9CA3AF",
                          marginTop: "3px",
                        }}
                      >
                        Add Image
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
            <input
              ref={extraRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                addExtra(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {extraErr && (
              <div className="cr-field-error">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{ flexShrink: 0 }}
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M12 8v4M12 16h.01"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                {extraErr}
              </div>
            )}
          </div>
          <StepNav
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            nextDisabled={!frontUrl}
          />
        </Card>
      )}

      {step === 2 && (
        <Card>
          <SectionTitle>Select Model</SectionTitle>
          <SectionDesc>
            Choose a saved studio model or upload a new reference photo.
          </SectionDesc>
          <ModelSelector
            models={models}
            selectedKey={selectedModel}
            onSelect={(k, u, g) => {
              setSelectedModel(k);
              setModelUrl(u);
              setModelGender(g);
            }}
          />
          <StepNav
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            nextDisabled={!selectedModel}
          />
        </Card>
      )}

      {step === 3 && (
        <Card>
          <SectionTitle>Generation Settings</SectionTitle>
          <SectionDesc>
            Adjust how the AI generates the final image.
          </SectionDesc>
          <div className="cr-settings-grid">
            <CrSelect
              label="Gender"
              value={settings.gender}
              onChange={(v) => S("gender", v)}
              options={[
                { value: "female", label: "Female" },
                { value: "male", label: "Male" },
                { value: "non-binary", label: "Non-binary" },
              ]}
            />
            <CrSelect
              label="Age Group"
              value={settings.ageGroup}
              onChange={(v) => S("ageGroup", v)}
              options={[
                { value: "child", label: "Child (5–12)" },
                { value: "teen", label: "Teen (13–17)" },
                { value: "young-adult", label: "Young Adult (18–25)" },
                { value: "adult", label: "Adult (26–40)" },
                { value: "mature", label: "Mature (40+)" },
              ]}
            />
            <CrSelect
              label="Ethnicity"
              value={settings.ethnicity}
              onChange={(v) => S("ethnicity", v)}
              options={[
                { value: "any", label: "Any / Model Default" },
                { value: "south-asian", label: "South Asian" },
                { value: "east-asian", label: "East Asian" },
                { value: "caucasian", label: "Caucasian" },
                { value: "african", label: "African" },
                { value: "latin", label: "Latin" },
              ]}
            />
            <CrSelect
              label="Body Type"
              value={settings.bodyType}
              onChange={(v) => S("bodyType", v)}
              options={[
                { value: "slim", label: "Slim" },
                { value: "average", label: "Average" },
                { value: "athletic", label: "Athletic" },
                { value: "curvy", label: "Curvy" },
                { value: "plus-size", label: "Plus Size" },
              ]}
            />
            <CrSelect
              label="Pose"
              value={settings.pose}
              onChange={(v) => S("pose", v)}
              options={[
                { value: "standing-natural", label: "Standing (Natural)" },
                { value: "standing-hands-on-hips", label: "Hands on Hips" },
                { value: "walking", label: "Walking" },
                { value: "sitting", label: "Sitting" },
                { value: "dynamic", label: "Dynamic / Editorial" },
              ]}
            />
            <CrSelect
              label="Background"
              value={settings.background}
              onChange={(v) => S("background", v)}
              options={[
                { value: "clean-white", label: "Clean White" },
                { value: "solid-light-grey", label: "Light Grey" },
                { value: "gradient-soft", label: "Soft Gradient" },
                { value: "lifestyle-indoor", label: "Lifestyle Indoor" },
                { value: "lifestyle-outdoor", label: "Lifestyle Outdoor" },
                { value: "studio", label: "Studio Lighting" },
              ]}
            />
            <CrSelect
              label="Aspect Ratio"
              value={settings.aspectRatio}
              onChange={(v) => S("aspectRatio", v)}
              options={[
                { value: "1:1", label: "1:1 — Square" },
                { value: "3:4", label: "3:4 — Portrait" },
                { value: "4:5", label: "4:5 — Instagram" },
                { value: "9:16", label: "9:16 — Stories" },
              ]}
            />
          </div>
          <StepNav onBack={() => setStep(2)} onNext={() => setStep(4)} />
        </Card>
      )}

      {step === 4 && (
        <Card>
          <SectionTitle>Review & Generate</SectionTitle>
          <SectionDesc>
            Confirm everything looks right before generating.
          </SectionDesc>
          <div
            style={{
              display: "flex",
              gap: "12px",
              marginBottom: "4px",
              flexWrap: "wrap",
            }}
          >
            <ReviewThumb label="Front" src={frontUrl} />
            {backUrl && <ReviewThumb label="Back" src={backUrl} />}
            {extraUrls.map((u, i) => (
              <ReviewThumb key={i} label={`Detail ${i + 1}`} src={u} />
            ))}
            <ReviewThumb
              label="Model"
              src={
                selectedModel !== "__custom__"
                  ? (models[selectedModel]?.image_url ?? null)
                  : modelUrl
              }
            />
          </div>
          <ReviewTable
            rows={[
              [
                "Product",
                PRODUCT_CATS.find((c) => c.id === productType)?.label ?? "-",
              ],
              ["Shot Type", wearType],
              ["Gender", settings.gender],
              ["Age Group", settings.ageGroup],
              ["Pose", settings.pose],
              ["Background", settings.background],
              ["Aspect Ratio", settings.aspectRatio],
            ]}
          />
          <InfographicAddon
            checked={withInfographic}
            onChange={(v) => {
              setWithInfographic(v);
              if (!v) setInfographicResult(null);
            }}
            description={infoDescription}
            onDescriptionChange={setInfoDescription}
            style={infoStyle}
            onStyleChange={setInfoStyle}
            customStyle={infoCustomStyle}
            onCustomStyleChange={setInfoCustomStyle}
          />
          <StepNav
            onBack={() => setStep(3)}
            onNext={() => {
              setStep(5);
              doGenerate();
            }}
            nextLabel="Generate Image"
            isGenerate
          />
        </Card>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// WORKFLOW 2 — FLAT LAY TO MODEL
// ════════════════════════════════════════════════════════════════════════════

function WorkflowFlatLay({ models }) {
  const wfId = "flat-lay";
  const fetcher = useFetcher();
  const infoFetcher = useFetcher();
  const [step, setStep] = useState(0);
  const [productType, setProductType] = useState(null);
  const [wearType, setWearType] = useState("full");
  const [flatUrl, setFlatUrl] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [modelUrl, setModelUrl] = useState(null);
  const [modelGender, setModelGender] = useState(null);
  const [details, setDetails] = useState({
    fabric: "",
    fit: "",
    sleeve: "",
    embroidery: "",
    notes: "",
  });
  const [settings, setSettings] = useState({
    pose: "standing-natural",
    background: "clean-white",
    aspectRatio: "3:4",
    resolution: "standard",
  });
  const [fashnModel, setFashnModel] = useState("tryon-v1.6");
  const [result, setResult] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [pendingSessionId, setPendingSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [withInfographic, setWithInfographic] = useState(false);
  const [infoDescription, setInfoDescription] = useState("");
  const [infoStyle, setInfoStyle] = useState("modern");
  const [infoCustomStyle, setInfoCustomStyle] = useState("");
  const [infographicResult, setInfographicResult] = useState(null);
  const [infographicKeyPoints, setInfographicKeyPoints] = useState([]);
  const [infographicError, setInfographicError] = useState(null);
  const statusFetcher = useFetcher();
  const isGenerating = fetcher.state !== "idle" || !!pendingSessionId;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.status === "processing" && fetcher.data.session_id) {
        setPendingSessionId(fetcher.data.session_id);
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
        setStep(5);
      } // back to Review on failure
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!pendingSessionId) return;
    const poll = () => {
      if (statusFetcher.state === "idle") {
        statusFetcher.submit(
          { _action: "generate-status", session_id: pendingSessionId },
          {
            method: "POST",
            action: "/app/studio/create",
            encType: "application/json",
          },
        );
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [pendingSessionId, statusFetcher]);

  useEffect(() => {
    if (statusFetcher.state === "idle" && statusFetcher.data) {
      if (statusFetcher.data.status === "completed") {
        setResult(statusFetcher.data.result_image);
        setSessionId(statusFetcher.data.session_id ?? null);
        setPendingSessionId(null);
        setStep(7);
      } else if (statusFetcher.data.status === "failed") {
        setError(statusFetcher.data.error);
        setPendingSessionId(null);
        setStep(5); // back to Review on failure
      }
    }
  }, [statusFetcher.state, statusFetcher.data]);

  useEffect(() => {
    if (infoFetcher.state === "idle" && infoFetcher.data) {
      if (infoFetcher.data.results?.length) {
        setInfographicError(null);
        setInfographicResult(infoFetcher.data.results);
        setInfographicKeyPoints(infoFetcher.data.key_points ?? []);
      } else if (infoFetcher.data.error) {
        setInfographicError(infoFetcher.data.error);
      }
    }
  }, [infoFetcher.state, infoFetcher.data]);

  const doGenerate = () => {
    const productPrompt = buildProductPrompt(productType, wearType);
    const detailsPrompt = [
      details.fabric,
      details.fit,
      details.sleeve,
      details.embroidery,
      details.notes,
    ]
      .filter(Boolean)
      .join(", ");
    const fullPrompt = [productPrompt, detailsPrompt]
      .filter(Boolean)
      .join("; ");
    const productCat = PRODUCT_CATS.find((c) => c.id === productType);
    fetcher.submit(
      {
        _action: "generate",
        workflow_type: "flat-lay",
        front_image_url: flatUrl,
        back_image_url: null,
        model_key: selectedModel !== "__custom__" ? selectedModel : null,
        model_image_url: selectedModel === "__custom__" ? modelUrl : null,
        model_gender: selectedModel === "__custom__" ? modelGender : null,
        garment_type: productCat?.garmentType ?? wearType ?? "full",
        clothing_prompt: fullPrompt || null,
        fashn_model: fashnModel,
        ...settings,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
    if (withInfographic && infoDescription.trim()) {
      infoFetcher.submit(
        {
          _action: "infographic-create",
          product_image_url: flatUrl,
          description: infoDescription,
          style: infoStyle,
          custom_style_prompt: infoCustomStyle,
        },
        {
          method: "POST",
          action: "/app/studio/create",
          encType: "application/json",
        },
      );
    }
  };

  const D = (f, v) => setDetails((p) => ({ ...p, [f]: v }));
  const S = (f, v) => setSettings((p) => ({ ...p, [f]: v }));
  const steps = WORKFLOWS[1].steps;

  if (step === 7 && result)
    return (
      <div>
        <Stepper steps={steps} wfId={wfId} current={7} />
        <Card>
          <OutputScreen
            result={result}
            sessionId={sessionId}
            wfId={wfId}
            onRegenerate={() => {
              setResult(null);
              setInfographicResult(null);
              setStep(0);
            }}
            infographicResult={infographicResult}
            infographicLoading={
              withInfographic &&
              infoFetcher.state !== "idle" &&
              !infographicResult
            }
            infographicError={infographicError}
            onInfographicUpdate={(idx, url) =>
              setInfographicResult((prev) =>
                prev
                  ? prev.map((r, i) => (i === idx ? { ...r, image: url } : r))
                  : prev,
              )
            }
            onInfographicAppend={(r) =>
              setInfographicResult((prev) => (prev ? [...prev, r] : [r]))
            }
            infographicRegenInput={{
              imageUrl: flatUrl,
              keyPoints: infographicKeyPoints,
              style: infoStyle,
              customStylePrompt: infoCustomStyle,
              category: "clothing",
            }}
          />
        </Card>
      </div>
    );
  if (isGenerating)
    return (
      <div>
        <Stepper steps={steps} wfId={wfId} current={6} />
        <Card>
          <GeneratingScreen wfId={wfId} />
        </Card>
      </div>
    );

  return (
    <div>
      <Stepper steps={steps} wfId={wfId} current={step} />
      {error && <ErrBanner msg={error} onDismiss={() => setError(null)} />}

      {step === 0 && (
        <Card>
          <SectionTitle>What are you selling?</SectionTitle>
          <SectionDesc>
            Select your product type so the AI applies the right drape, fit and
            framing.
          </SectionDesc>
          <ProductTypeStep
            productType={productType}
            wearType={wearType}
            onTypeChange={setProductType}
            onWearChange={setWearType}
          />
          <StepNav onNext={() => setStep(1)} nextDisabled={!productType} />
        </Card>
      )}

      {step === 1 && (
        <Card>
          <SectionTitle>Upload Flat Lay Image</SectionTitle>
          <SectionDesc>
            Upload your garment photographed flat on a surface. The AI will
            reconstruct how it looks on a real model.
          </SectionDesc>
          <UploadZone
            label="Flat Lay Image"
            required
            value={flatUrl}
            onChange={setFlatUrl}
            note="Garment laid flat on a clean surface, shot from above. Even slightly wrinkled flat-lays work well."
          />
          <StepNav
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            nextDisabled={!flatUrl}
          />
        </Card>
      )}

      {step === 2 && (
        <Card>
          <SectionTitle>Select Model</SectionTitle>
          <ModelSelector
            models={models}
            selectedKey={selectedModel}
            onSelect={(k, u, g) => {
              setSelectedModel(k);
              setModelUrl(u);
              setModelGender(g);
            }}
          />
          <StepNav
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            nextDisabled={!selectedModel}
          />
        </Card>
      )}

      {step === 3 && (
        <Card>
          <SectionTitle>Product Details</SectionTitle>
          <SectionDesc>
            Prompt is required — the more context you give, the more accurately
            the AI can recreate the garment. Other fields are optional.
          </SectionDesc>
          <div className="cr-two-col">
            <CrInput
              label="Fabric Type"
              value={details.fabric}
              onChange={(v) => D("fabric", v)}
              placeholder="e.g. Banarasi silk, cotton lawn…"
              hint="optional"
            />
            <CrInput
              label="Fit / Silhouette"
              value={details.fit}
              onChange={(v) => D("fit", v)}
              placeholder="e.g. A-line, slim-fit, flowy…"
              hint="optional"
            />
            <CrInput
              label="Sleeve Details"
              value={details.sleeve}
              onChange={(v) => D("sleeve", v)}
              placeholder="e.g. Bell sleeves, cold-shoulder…"
              hint="optional"
            />
            <CrInput
              label="Embroidery / Print"
              value={details.embroidery}
              onChange={(v) => D("embroidery", v)}
              placeholder="e.g. Gold zari border, floral print…"
              hint="optional"
            />
          </div>
          <CrTextarea
            label="Prompt"
            required
            value={details.notes}
            onChange={(v) => D("notes", v)}
            placeholder="e.g. Drape the dupatta over the left shoulder."
          />
          <StepNav
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            nextDisabled={!details.notes.trim()}
          />
        </Card>
      )}

      {step === 4 && (
        <Card>
          <SectionTitle>Generation Settings</SectionTitle>
          <div className="cr-settings-grid">
            <CrSelect
              label="Pose"
              value={settings.pose}
              onChange={(v) => S("pose", v)}
              options={[
                { value: "standing-natural", label: "Standing (Natural)" },
                { value: "standing-hands-on-hips", label: "Hands on Hips" },
                { value: "walking", label: "Walking" },
                { value: "sitting", label: "Sitting" },
              ]}
            />
            <CrSelect
              label="Background"
              value={settings.background}
              onChange={(v) => S("background", v)}
              options={[
                { value: "clean-white", label: "Clean White" },
                { value: "solid-light-grey", label: "Light Grey" },
                { value: "gradient-soft", label: "Soft Gradient" },
                { value: "lifestyle-indoor", label: "Lifestyle Indoor" },
                { value: "lifestyle-outdoor", label: "Lifestyle Outdoor" },
              ]}
            />
            <CrSelect
              label="Aspect Ratio"
              value={settings.aspectRatio}
              onChange={(v) => S("aspectRatio", v)}
              options={[
                { value: "1:1", label: "1:1 — Square" },
                { value: "3:4", label: "3:4 — Portrait" },
                { value: "4:5", label: "4:5 — Instagram" },
                { value: "9:16", label: "9:16 — Stories" },
              ]}
            />
            <CrSelect
              label="Resolution"
              value={settings.resolution}
              onChange={(v) => S("resolution", v)}
              options={[
                { value: "standard", label: "Standard (1024 px)" },
                { value: "high", label: "High (2048 px)" },
                { value: "ultra", label: "Ultra HD (4096 px)" },
              ]}
            />
            <CrSelect
              label="AI Engine"
              value={fashnModel}
              onChange={setFashnModel}
              options={[
                { value: "tryon-v1.6", label: "Standard (tryon-v1.6)" },
                { value: "tryon-max", label: "Try-On Max (higher quality)" },
                {
                  value: "product-to-model",
                  label: "Product to Model (best for saree/lehenga drape)",
                },
              ]}
            />
          </div>
          <StepNav onBack={() => setStep(3)} onNext={() => setStep(5)} />
        </Card>
      )}

      {step === 5 && (
        <Card>
          <SectionTitle>Review & Generate</SectionTitle>
          <div style={{ display: "flex", gap: "16px", marginBottom: "4px" }}>
            <ReviewThumb label="Flat Lay" src={flatUrl} />
          </div>
          <ReviewTable
            rows={[
              [
                "Product",
                PRODUCT_CATS.find((c) => c.id === productType)?.label ?? "-",
              ],
              ["Shot Type", wearType],
              ["Fabric", details.fabric],
              ["Fit", details.fit],
              ["Pose", settings.pose],
              ["Background", settings.background],
              ["Aspect Ratio", settings.aspectRatio],
              ["AI Engine", fashnModel],
            ]}
          />
          <InfographicAddon
            checked={withInfographic}
            onChange={(v) => {
              setWithInfographic(v);
              if (!v) setInfographicResult(null);
            }}
            description={infoDescription}
            onDescriptionChange={setInfoDescription}
            style={infoStyle}
            onStyleChange={setInfoStyle}
            customStyle={infoCustomStyle}
            onCustomStyleChange={setInfoCustomStyle}
          />
          <StepNav
            onBack={() => setStep(4)}
            onNext={() => {
              setStep(6);
              doGenerate();
            }}
            nextLabel="Generate Image"
            isGenerate
          />
        </Card>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// WORKFLOW 3 — GHOST MANNEQUIN TO MODEL
// ════════════════════════════════════════════════════════════════════════════

function WorkflowMannequin({ models }) {
  const wfId = "mannequin";
  const fetcher = useFetcher();
  const infoFetcher = useFetcher();
  const [step, setStep] = useState(0);
  const [productType, setProductType] = useState(null);
  const [wearType, setWearType] = useState("full");
  const [mannUrl, setMannUrl] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [modelUrl, setModelUrl] = useState(null);
  const [modelGender, setModelGender] = useState(null);
  const [settings, setSettings] = useState({
    pose: "standing-natural",
    expression: "natural",
    background: "clean-white",
    cameraAngle: "front",
  });
  const [result, setResult] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [pendingSessionId, setPendingSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [withInfographic, setWithInfographic] = useState(false);
  const [infoDescription, setInfoDescription] = useState("");
  const [infoStyle, setInfoStyle] = useState("modern");
  const [infoCustomStyle, setInfoCustomStyle] = useState("");
  const [infographicResult, setInfographicResult] = useState(null);
  const [infographicKeyPoints, setInfographicKeyPoints] = useState([]);
  const [infographicError, setInfographicError] = useState(null);
  const statusFetcher = useFetcher();
  const isGenerating = fetcher.state !== "idle" || !!pendingSessionId;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.status === "processing" && fetcher.data.session_id) {
        setPendingSessionId(fetcher.data.session_id);
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
        setStep(4);
      } // back to Review on failure
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!pendingSessionId) return;
    const poll = () => {
      if (statusFetcher.state === "idle") {
        statusFetcher.submit(
          { _action: "generate-status", session_id: pendingSessionId },
          {
            method: "POST",
            action: "/app/studio/create",
            encType: "application/json",
          },
        );
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [pendingSessionId, statusFetcher]);

  useEffect(() => {
    if (statusFetcher.state === "idle" && statusFetcher.data) {
      if (statusFetcher.data.status === "completed") {
        setResult(statusFetcher.data.result_image);
        setSessionId(statusFetcher.data.session_id ?? null);
        setPendingSessionId(null);
        setStep(6);
      } else if (statusFetcher.data.status === "failed") {
        setError(statusFetcher.data.error);
        setPendingSessionId(null);
        setStep(4); // back to Review on failure
      }
    }
  }, [statusFetcher.state, statusFetcher.data]);

  useEffect(() => {
    if (infoFetcher.state === "idle" && infoFetcher.data) {
      if (infoFetcher.data.results?.length) {
        setInfographicError(null);
        setInfographicResult(infoFetcher.data.results);
        setInfographicKeyPoints(infoFetcher.data.key_points ?? []);
      } else if (infoFetcher.data.error) {
        setInfographicError(infoFetcher.data.error);
      }
    }
  }, [infoFetcher.state, infoFetcher.data]);

  const doGenerate = () => {
    setError(null);
    const productPrompt = buildProductPrompt(productType, wearType);
    const productCat = PRODUCT_CATS.find((c) => c.id === productType);
    fetcher.submit(
      {
        _action: "generate",
        workflow_type: "mannequin",
        front_image_url: mannUrl,
        back_image_url: null,
        model_key: selectedModel !== "__custom__" ? selectedModel : null,
        model_image_url: selectedModel === "__custom__" ? modelUrl : null,
        model_gender: selectedModel === "__custom__" ? modelGender : null,
        garment_type: productCat?.garmentType ?? wearType ?? "full",
        clothing_prompt: productPrompt || null,
        ...settings,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
    if (withInfographic && infoDescription.trim()) {
      infoFetcher.submit(
        {
          _action: "infographic-create",
          product_image_url: mannUrl,
          description: infoDescription,
          style: infoStyle,
          custom_style_prompt: infoCustomStyle,
        },
        {
          method: "POST",
          action: "/app/studio/create",
          encType: "application/json",
        },
      );
    }
  };

  const S = (f, v) => setSettings((p) => ({ ...p, [f]: v }));
  const steps = WORKFLOWS[2].steps;

  if (step === 6 && result)
    return (
      <div>
        <Stepper steps={steps} wfId={wfId} current={6} />
        <Card>
          <OutputScreen
            result={result}
            sessionId={sessionId}
            wfId={wfId}
            onRegenerate={() => {
              setResult(null);
              setInfographicResult(null);
              setStep(0);
            }}
            infographicResult={infographicResult}
            infographicLoading={
              withInfographic &&
              infoFetcher.state !== "idle" &&
              !infographicResult
            }
            infographicError={infographicError}
            onInfographicUpdate={(idx, url) =>
              setInfographicResult((prev) =>
                prev
                  ? prev.map((r, i) => (i === idx ? { ...r, image: url } : r))
                  : prev,
              )
            }
            onInfographicAppend={(r) =>
              setInfographicResult((prev) => (prev ? [...prev, r] : [r]))
            }
            infographicRegenInput={{
              imageUrl: mannUrl,
              keyPoints: infographicKeyPoints,
              style: infoStyle,
              customStylePrompt: infoCustomStyle,
              category: "clothing",
            }}
          />
        </Card>
      </div>
    );
  if (isGenerating)
    return (
      <div>
        <Stepper steps={steps} wfId={wfId} current={5} />
        <Card>
          <GeneratingScreen wfId={wfId} />
        </Card>
      </div>
    );

  return (
    <div>
      <Stepper steps={steps} wfId={wfId} current={step} />
      {error && <ErrBanner msg={error} onDismiss={() => setError(null)} />}

      {step === 0 && (
        <Card>
          <SectionTitle>What are you selling?</SectionTitle>
          <SectionDesc>
            Select your product type so the AI applies the right drape, fit and
            framing.
          </SectionDesc>
          <ProductTypeStep
            productType={productType}
            wearType={wearType}
            onTypeChange={setProductType}
            onWearChange={setWearType}
          />
          <StepNav onNext={() => setStep(1)} nextDisabled={!productType} />
        </Card>
      )}

      {step === 1 && (
        <Card>
          <SectionTitle>Upload Ghost Mannequin Image</SectionTitle>
          <SectionDesc>
            Upload your invisible mannequin product photo. The AI removes the
            mannequin and replaces it with a real AI-generated model.
          </SectionDesc>
          <div className="cr-req-row">
            {[
              "Ghost / invisible mannequin",
              "Front-facing",
              "High resolution",
              "No real model visible",
            ].map((r) => (
              <span key={r} className="cr-req">
                {r}
              </span>
            ))}
          </div>
          <UploadZone
            label="Mannequin Image"
            required
            value={mannUrl}
            onChange={setMannUrl}
          />
          <StepNav
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            nextDisabled={!mannUrl}
          />
        </Card>
      )}

      {step === 2 && (
        <Card>
          <SectionTitle>Select Model</SectionTitle>
          <ModelSelector
            models={models}
            selectedKey={selectedModel}
            onSelect={(k, u, g) => {
              setSelectedModel(k);
              setModelUrl(u);
              setModelGender(g);
            }}
          />
          <StepNav
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            nextDisabled={!selectedModel}
          />
        </Card>
      )}

      {step === 3 && (
        <Card>
          <SectionTitle>Generation Settings</SectionTitle>
          <div className="cr-settings-grid">
            <CrSelect
              label="Pose"
              value={settings.pose}
              onChange={(v) => S("pose", v)}
              options={[
                { value: "standing-natural", label: "Standing (Natural)" },
                { value: "standing-hands-on-hips", label: "Hands on Hips" },
                { value: "walking", label: "Walking" },
                { value: "three-quarter", label: "Three-Quarter Turn" },
              ]}
            />
            <CrSelect
              label="Expression"
              value={settings.expression}
              onChange={(v) => S("expression", v)}
              options={[
                { value: "natural", label: "Natural / Neutral" },
                { value: "smiling", label: "Smiling" },
                { value: "editorial", label: "Editorial" },
              ]}
            />
            <CrSelect
              label="Background"
              value={settings.background}
              onChange={(v) => S("background", v)}
              options={[
                { value: "clean-white", label: "Clean White" },
                { value: "solid-light-grey", label: "Light Grey" },
                { value: "gradient-soft", label: "Soft Gradient" },
                { value: "lifestyle-indoor", label: "Lifestyle Indoor" },
                { value: "lifestyle-outdoor", label: "Lifestyle Outdoor" },
              ]}
            />
            <CrSelect
              label="Camera Angle"
              value={settings.cameraAngle}
              onChange={(v) => S("cameraAngle", v)}
              options={[
                { value: "front", label: "Front (Full Body)" },
                { value: "three-quarter", label: "Three-Quarter" },
                { value: "close-up", label: "Waist Up" },
                { value: "editorial", label: "Editorial / Low Angle" },
              ]}
            />
          </div>
          <StepNav onBack={() => setStep(2)} onNext={() => setStep(4)} />
        </Card>
      )}

      {step === 4 && (
        <Card>
          <SectionTitle>Review & Generate</SectionTitle>
          <div style={{ display: "flex", gap: "16px", marginBottom: "4px" }}>
            <ReviewThumb label="Mannequin" src={mannUrl} />
          </div>
          <ReviewTable
            rows={[
              [
                "Product",
                PRODUCT_CATS.find((c) => c.id === productType)?.label ?? "-",
              ],
              ["Shot Type", wearType],
              ["Pose", settings.pose],
              ["Expression", settings.expression],
              ["Background", settings.background],
              ["Camera Angle", settings.cameraAngle],
            ]}
          />
          <InfographicAddon
            checked={withInfographic}
            onChange={(v) => {
              setWithInfographic(v);
              if (!v) setInfographicResult(null);
            }}
            description={infoDescription}
            onDescriptionChange={setInfoDescription}
            style={infoStyle}
            onStyleChange={setInfoStyle}
            customStyle={infoCustomStyle}
            onCustomStyleChange={setInfoCustomStyle}
          />
          <StepNav
            onBack={() => setStep(3)}
            onNext={() => {
              setStep(5);
              doGenerate();
            }}
            nextLabel="Generate Image"
            isGenerate
          />
        </Card>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// WORKFLOW 4 — ACCESSORIES (mode selector → model try-on OR infographic)
// ════════════════════════════════════════════════════════════════════════════

function WorkflowAccessories({ models }) {
  const wfId = "accessories";

  // All hooks must be unconditional ─────────────────────────────────────────
  const fetcher = useFetcher(); // Fashn AI try-on
  const infoFetcher = useFetcher(); // infographic addon

  const [step, setStep] = useState(0);
  const [productType, setProductType] = useState(null);
  const [wearType, setWearType] = useState("top");
  const [category, setCategory] = useState("watch");
  const [accUrl, setAccUrl] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [modelUrl, setModelUrl] = useState(null);
  const [modelGender, setModelGender] = useState(null);
  const [placement, setPlacement] = useState(ACCESSORY_PLACEMENTS["watch"][0]);
  const [settings, setSettings] = useState({
    pose: "standing-natural",
    background: "clean-white",
    styling: "editorial",
  });
  const [result, setResult] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [pendingSessionId, setPendingSessionId] = useState(null);
  const [error, setError] = useState(null);
  const [withInfographic, setWithInfographic] = useState(false);
  const [infoDescription, setInfoDescription] = useState("");
  const [infoStyle, setInfoStyle] = useState("modern");
  const [infoCustomStyle, setInfoCustomStyle] = useState("");
  const [infographicResult, setInfographicResult] = useState(null);
  const [infographicKeyPoints, setInfographicKeyPoints] = useState([]);
  const [infographicError, setInfographicError] = useState(null);

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    setPlacement(ACCESSORY_PLACEMENTS[category]?.[0] ?? "");
  }, [category]);

  const statusFetcher = useFetcher();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.status === "processing" && fetcher.data.session_id) {
        setPendingSessionId(fetcher.data.session_id);
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
        setStep(5);
      }
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!pendingSessionId) return;
    const poll = () => {
      if (statusFetcher.state === "idle") {
        statusFetcher.submit(
          { _action: "generate-status", session_id: pendingSessionId },
          {
            method: "POST",
            action: "/app/studio/create",
            encType: "application/json",
          },
        );
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [pendingSessionId, statusFetcher]);

  useEffect(() => {
    if (statusFetcher.state === "idle" && statusFetcher.data) {
      if (statusFetcher.data.status === "completed") {
        setResult(statusFetcher.data.result_image);
        setSessionId(statusFetcher.data.session_id ?? null);
        setPendingSessionId(null);
        setStep(7);
      } else if (statusFetcher.data.status === "failed") {
        setError(statusFetcher.data.error);
        setPendingSessionId(null);
        setStep(5);
      }
    }
  }, [statusFetcher.state, statusFetcher.data]);

  useEffect(() => {
    if (infoFetcher.state === "idle" && infoFetcher.data) {
      if (infoFetcher.data.results?.length) {
        setInfographicError(null);
        setInfographicResult(infoFetcher.data.results);
        setInfographicKeyPoints(infoFetcher.data.key_points ?? []);
      } else if (infoFetcher.data.error) {
        setInfographicError(infoFetcher.data.error);
      }
    }
  }, [infoFetcher.state, infoFetcher.data]);

  // ── Submit handlers ───────────────────────────────────────────────────────
  const doModelGenerate = () => {
    setError(null);
    const productPrompt = buildProductPrompt(productType, null);
    const fullPrompt = [productPrompt, `${category}: ${placement}`]
      .filter(Boolean)
      .join("; ");
    fetcher.submit(
      {
        _action: "generate",
        workflow_type: "accessories",
        front_image_url: accUrl,
        back_image_url: null,
        model_key: selectedModel !== "__custom__" ? selectedModel : null,
        model_image_url: selectedModel === "__custom__" ? modelUrl : null,
        model_gender: selectedModel === "__custom__" ? modelGender : null,
        clothing_prompt: fullPrompt,
        ...settings,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
    if (withInfographic && infoDescription.trim()) {
      infoFetcher.submit(
        {
          _action: "infographic-create",
          product_image_url: accUrl,
          description: infoDescription,
          style: infoStyle,
          custom_style_prompt: infoCustomStyle,
        },
        {
          method: "POST",
          action: "/app/studio/create",
          encType: "application/json",
        },
      );
    }
  };

  const S = (f, v) => setSettings((p) => ({ ...p, [f]: v }));

  const modelSteps = [
    "Product Type",
    "Accessory Image",
    "Model",
    "Placement",
    "Settings",
    "Review",
    "Output",
  ];
  const isModelGenerating = fetcher.state !== "idle" || !!pendingSessionId;

  if (step === 7 && result)
    return (
      <div>
        <Stepper steps={modelSteps} wfId={wfId} current={7} />
        <Card>
          <OutputScreen
            result={result}
            sessionId={sessionId}
            wfId={wfId}
            onRegenerate={() => {
              setResult(null);
              setInfographicResult(null);
              setStep(0);
            }}
            infographicResult={infographicResult}
            infographicLoading={
              withInfographic &&
              infoFetcher.state !== "idle" &&
              !infographicResult
            }
            infographicError={infographicError}
            onInfographicUpdate={(idx, url) =>
              setInfographicResult((prev) =>
                prev
                  ? prev.map((r, i) => (i === idx ? { ...r, image: url } : r))
                  : prev,
              )
            }
            onInfographicAppend={(r) =>
              setInfographicResult((prev) => (prev ? [...prev, r] : [r]))
            }
            infographicRegenInput={{
              imageUrl: accUrl,
              keyPoints: infographicKeyPoints,
              style: infoStyle,
              customStylePrompt: infoCustomStyle,
              category: "clothing",
            }}
          />
        </Card>
      </div>
    );
  if (isModelGenerating)
    return (
      <div>
        <Stepper steps={modelSteps} wfId={wfId} current={6} />
        <Card>
          <GeneratingScreen wfId={wfId} />
        </Card>
      </div>
    );

  return (
    <div>
      <Stepper steps={modelSteps} wfId={wfId} current={step} />
      {error && <ErrBanner msg={error} onDismiss={() => setError(null)} />}

      {step === 0 && (
        <Card>
          <SectionTitle>What are you selling?</SectionTitle>
          <SectionDesc>
            Select your product type — pick from Accessories & Jewellery.
          </SectionDesc>
          <ProductTypeStep
            productType={productType}
            wearType={wearType}
            onTypeChange={(t) => {
              setProductType(t);
              const cat = PRODUCT_CATS.find((c) => c.id === t);
              if (cat?.accCategory) setCategory(cat.accCategory);
            }}
            onWearChange={setWearType}
          />
          <StepNav onNext={() => setStep(1)} nextDisabled={!productType} />
        </Card>
      )}

      {step === 1 && (
        <Card>
          <SectionTitle>Upload Accessory Image</SectionTitle>
          <SectionDesc>
            Select the accessory sub-type, then upload a clean product image.
          </SectionDesc>
          <div style={{ marginBottom: "18px" }}>
            <FieldLabel required>Accessory Type</FieldLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {Object.keys(ACCESSORY_PLACEMENTS).map((cat) => (
                <button
                  key={cat}
                  className={`cr-choice-btn ${category === cat ? "active" : ""}`}
                  onClick={() => setCategory(cat)}
                >
                  {cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <UploadZone
            label="Accessory Image"
            required
            value={accUrl}
            onChange={setAccUrl}
            note="Clean product-only shot on white or transparent background. No model, no extra props."
          />
          <StepNav
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
            nextDisabled={!accUrl}
          />
        </Card>
      )}

      {step === 2 && (
        <Card>
          <SectionTitle>Select Model</SectionTitle>
          <ModelSelector
            models={models}
            selectedKey={selectedModel}
            onSelect={(k, u, g) => {
              setSelectedModel(k);
              setModelUrl(u);
              setModelGender(g);
            }}
          />
          <StepNav
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            nextDisabled={!selectedModel}
          />
        </Card>
      )}

      {step === 3 && (
        <Card>
          <SectionTitle>Placement</SectionTitle>
          <SectionDesc>
            Choose where the <strong>{category}</strong> should appear on the
            model.
          </SectionDesc>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
              marginBottom: "8px",
            }}
          >
            {(ACCESSORY_PLACEMENTS[category] ?? []).map((p) => (
              <button
                key={p}
                className={`cr-choice-btn ${placement === p ? "active" : ""}`}
                onClick={() => setPlacement(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <StepNav
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            nextDisabled={!placement}
          />
        </Card>
      )}

      {step === 4 && (
        <Card>
          <SectionTitle>Generation Settings</SectionTitle>
          <div className="cr-settings-grid">
            <CrSelect
              label="Pose"
              value={settings.pose}
              onChange={(v) => S("pose", v)}
              options={[
                { value: "standing-natural", label: "Standing (Natural)" },
                { value: "posed", label: "Editorial Pose" },
                { value: "walking", label: "Walking" },
                { value: "sitting", label: "Sitting" },
              ]}
            />
            <CrSelect
              label="Background"
              value={settings.background}
              onChange={(v) => S("background", v)}
              options={[
                { value: "clean-white", label: "Clean White" },
                { value: "solid-light-grey", label: "Light Grey" },
                { value: "lifestyle-indoor", label: "Lifestyle Indoor" },
                { value: "luxury-studio", label: "Luxury Studio" },
              ]}
            />
            <CrSelect
              label="Styling"
              value={settings.styling}
              onChange={(v) => S("styling", v)}
              options={[
                { value: "editorial", label: "Editorial" },
                { value: "commercial", label: "Commercial / Catalog" },
                { value: "luxury", label: "Luxury / High-End" },
                { value: "casual", label: "Casual / Lifestyle" },
              ]}
            />
          </div>
          <StepNav onBack={() => setStep(3)} onNext={() => setStep(5)} />
        </Card>
      )}

      {step === 5 && (
        <Card>
          <SectionTitle>Review & Generate</SectionTitle>
          <div style={{ display: "flex", gap: "16px", marginBottom: "4px" }}>
            <ReviewThumb label={category} src={accUrl} />
          </div>
          <ReviewTable
            rows={[
              [
                "Product",
                PRODUCT_CATS.find((c) => c.id === productType)?.label ?? "-",
              ],
              ["Accessory Type", category],
              ["Placement", placement],
              ["Pose", settings.pose],
              ["Background", settings.background],
              ["Styling", settings.styling],
            ]}
          />
          <InfographicAddon
            checked={withInfographic}
            onChange={(v) => {
              setWithInfographic(v);
              if (!v) setInfographicResult(null);
            }}
            description={infoDescription}
            onDescriptionChange={setInfoDescription}
            style={infoStyle}
            onStyleChange={setInfoStyle}
            customStyle={infoCustomStyle}
            onCustomStyleChange={setInfoCustomStyle}
          />
          <StepNav
            onBack={() => setStep(4)}
            onNext={() => {
              setStep(6);
              doModelGenerate();
            }}
            nextLabel="Generate Try-On"
            isGenerate
          />
        </Card>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// WORKFLOW 5 — MARKETING INFOGRAPHIC (standalone)
// ════════════════════════════════════════════════════════════════════════════

function WorkflowInfographic({ savedGenerations }) {
  const igFetcher = useFetcher();

  const [useUpload, setUseUpload] = useState(savedGenerations.length === 0);
  const [igStep, setIgStep] = useState(0);
  const [igImageUrl, setIgImageUrl] = useState(null);
  const [igDesc, setIgDesc] = useState("");
  const [igStyle, setIgStyle] = useState("luxury");
  const [igCategory, setIgCategory] = useState("clothing");
  const [igCustomStyle, setIgCustomStyle] = useState("");
  const [igResults, setIgResults] = useState(null);
  const [igKPs, setIgKPs] = useState([]);
  const [igError, setIgError] = useState(null);

  useEffect(() => {
    if (igFetcher.state === "idle" && igFetcher.data) {
      if (igFetcher.data.results?.length) {
        setIgResults(igFetcher.data.results);
        setIgKPs(igFetcher.data.key_points ?? []);
        setIgStep(4);
      } else if (igFetcher.data.error) {
        setIgError(igFetcher.data.error);
        setIgStep(3); // back to review
      }
    }
  }, [igFetcher.state, igFetcher.data]);

  const doIgGenerate = () => {
    setIgError(null);
    igFetcher.submit(
      {
        _action: "infographic-create",
        product_image_url: igImageUrl,
        description: igDesc,
        style: igStyle,
        custom_style_prompt: igCustomStyle,
        product_category: igCategory,
      },
      {
        method: "POST",
        action: "/app/studio/create",
        encType: "application/json",
      },
    );
  };

  const igSteps = ["Source Image", "Description", "Style", "Review", "Output"];
  const isIgGenerating = igFetcher.state !== "idle";
  const fmt = (d) =>
    d
      ? new Date(d).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "—";

  if (igStep === 4 && igResults?.length)
    return (
      <div>
        <Stepper steps={igSteps} wfId="infographic" current={4} />
        <Card>
          <OutputScreen
            result={null}
            sessionId={null}
            wfId="infographic"
            onRegenerate={() => {
              setIgResults(null);
              setIgKPs([]);
              setIgStep(2);
            }}
            infographicResult={igResults}
            infographicLoading={false}
            onInfographicUpdate={(idx, url) =>
              setIgResults((prev) =>
                prev
                  ? prev.map((r, i) => (i === idx ? { ...r, image: url } : r))
                  : prev,
              )
            }
            onInfographicAppend={(r) =>
              setIgResults((prev) => (prev ? [...prev, r] : [r]))
            }
            infographicRegenInput={{
              imageUrl: igImageUrl,
              keyPoints: igKPs,
              style: igStyle,
              customStylePrompt: igCustomStyle,
              category: igCategory,
            }}
          />
          {igKPs.length > 0 && (
            <div
              style={{
                marginTop: "16px",
                padding: "14px",
                background: "#F0FDF4",
                borderRadius: "10px",
                border: "1px solid #D1FAE5",
              }}
            >
              <p
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "#065F46",
                  margin: "0 0 8px",
                }}
              >
                Key highlights used in this infographic
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {igKPs.map((pt, i) => (
                  <span
                    key={i}
                    style={{
                      background: "#D1FAE5",
                      color: "#059669",
                      fontWeight: 700,
                      fontSize: "12px",
                      padding: "3px 10px",
                      borderRadius: "999px",
                    }}
                  >
                    {pt}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    );

  if (isIgGenerating)
    return (
      <div>
        <Stepper steps={igSteps} wfId="infographic" current={3} />
        <Card>
          <GeneratingScreen wfId="infographic" />
        </Card>
      </div>
    );

  return (
    <div>
      <Stepper steps={igSteps} wfId="infographic" current={igStep} />
      {igError && (
        <ErrBanner msg={igError} onDismiss={() => setIgError(null)} />
      )}

      {igStep === 0 && (
        <Card>
          <SectionTitle>Choose Source Image</SectionTitle>
          <SectionDesc>
            {savedGenerations.length > 0
              ? "Reuse a Fashn AI model photo you've already saved, or upload a fresh product image."
              : "Upload a clean product photo. This will be the centrepiece of the infographic."}
          </SectionDesc>

          {savedGenerations.length > 0 && !useUpload && (
            <div style={{ marginBottom: "16px" }}>
              <FieldLabel required>Saved Fashn AI Models</FieldLabel>
              <select
                className="cr-input"
                style={{ cursor: "pointer" }}
                value={igImageUrl ?? ""}
                onChange={(e) => setIgImageUrl(e.target.value || null)}
              >
                <option value="" disabled>
                  Select a saved model photo…
                </option>
                {savedGenerations.map((g) => (
                  <option key={g.id} value={g.result_image_url}>
                    {g.garment_type
                      ? g.garment_type.charAt(0).toUpperCase() +
                        g.garment_type.slice(1)
                      : "Model"}{" "}
                    — {fmt(g.created_at)}
                  </option>
                ))}
              </select>
              {igImageUrl && (
                <div style={{ marginTop: "12px" }}>
                  <ReviewThumb label="Selected" src={igImageUrl} />
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setUseUpload(true);
                  setIgImageUrl(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  marginTop: "10px",
                  color: "#4F46E5",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Or upload a new image instead
              </button>
            </div>
          )}

          {(savedGenerations.length === 0 || useUpload) && (
            <div>
              <div className="cr-req-row">
                {[
                  "Clean background",
                  "High resolution",
                  "JPEG / PNG / WEBP",
                ].map((r) => (
                  <span key={r} className="cr-req">
                    {r}
                  </span>
                ))}
              </div>
              <UploadZone
                label="Product Photo"
                required
                value={igImageUrl}
                onChange={setIgImageUrl}
              />
              {savedGenerations.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setUseUpload(false);
                    setIgImageUrl(null);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    marginTop: "6px",
                    color: "#4F46E5",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Or choose a saved Fashn AI model instead
                </button>
              )}
            </div>
          )}

          <StepNav onNext={() => setIgStep(1)} nextDisabled={!igImageUrl} />
        </Card>
      )}

      {igStep === 1 && (
        <Card>
          <SectionTitle>Describe Your Product</SectionTitle>
          <SectionDesc>
            Write a short paragraph about the product. AI will extract 3–4 short
            highlights — no full sentences — and overlay them as bold badges on
            the infographic.
          </SectionDesc>
          <CrTextarea
            label="Product Description"
            required
            value={igDesc}
            onChange={setIgDesc}
            rows={5}
            placeholder="e.g. This 18-karat gold-plated watch features a sapphire crystal glass, Italian leather strap, and 50m water resistance. Swiss movement, 3-year international warranty."
          />
          <p
            style={{
              fontSize: "12px",
              color: "#6B7280",
              margin: "-4px 0 0",
              lineHeight: 1.5,
            }}
          >
            AI extracts highlights like <em>&ldquo;18k Gold Plated&rdquo;</em>,{" "}
            <em>&ldquo;Sapphire Crystal&rdquo;</em>,{" "}
            <em>&ldquo;50m Water Resistant&rdquo;</em> — short phrases only,
            never sentences.
          </p>
          <StepNav
            onBack={() => setIgStep(0)}
            onNext={() => setIgStep(2)}
            nextDisabled={!igDesc.trim()}
          />
        </Card>
      )}

      {igStep === 2 && (
        <Card>
          <SectionTitle>Choose Infographic Style</SectionTitle>
          <SectionDesc>Pick the visual theme for your infographic.</SectionDesc>
          <div style={{ marginBottom: "18px" }}>
            <FieldLabel hint="changes how labels are laid out around your photo">
              Product Type
            </FieldLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              <button
                type="button"
                className={`cr-choice-btn ${igCategory === "clothing" ? "active" : ""}`}
                onClick={() => setIgCategory("clothing")}
              >
                Clothing / Apparel
              </button>
              <button
                type="button"
                className={`cr-choice-btn ${igCategory === "food" ? "active" : ""}`}
                onClick={() => setIgCategory("food")}
              >
                Food / Packaged Goods
              </button>
            </div>
          </div>
          <div className="cr-template-list">
            {TEMPLATES.map((t) => (
              <div
                key={t.id}
                className={`cr-template-row ${igStyle === t.id ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setIgStyle(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setIgStyle(t.id);
                  }
                }}
              >
                <div
                  className="cr-template-dot"
                  style={{
                    background:
                      t.id === "luxury"
                        ? "#B48C32"
                        : t.id === "modern"
                          ? "#2563EB"
                          : t.id === "minimal"
                            ? "#E5E7EB"
                            : t.id === "ecommerce"
                              ? "#059669"
                              : t.id === "catalog"
                                ? "#334155"
                                : t.id === "collage"
                                  ? "#EC4899"
                                  : "#6366F1",
                  }}
                />
                <div style={{ flex: 1 }}>
                  <p
                    style={{
                      fontWeight: 600,
                      fontSize: "13px",
                      color: "#111827",
                      margin: "0 0 2px",
                    }}
                  >
                    {t.label}
                  </p>
                  <p style={{ fontSize: "12px", color: "#6B7280", margin: 0 }}>
                    {t.desc}
                  </p>
                </div>
                <div
                  className={`cr-template-check ${igStyle === t.id ? "visible" : ""}`}
                >
                  ✓
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "16px" }}>
            <FieldLabel hint="optional — describe how you want the background/theme to look">
              Custom Background / Theme
            </FieldLabel>
            <textarea
              className="cr-input"
              value={igCustomStyle}
              onChange={(e) => setIgCustomStyle(e.target.value)}
              placeholder="e.g. soft pastel pink background with floating stars, or a festive Diwali theme with diyas and marigold accents"
              rows={2}
              style={{ resize: "vertical", lineHeight: 1.5, margin: 0 }}
            />
          </div>
          <StepNav
            onBack={() => setIgStep(1)}
            onNext={() => setIgStep(3)}
            nextDisabled={!igStyle}
          />
        </Card>
      )}

      {igStep === 3 && (
        <Card>
          <SectionTitle>Review & Generate</SectionTitle>
          <SectionDesc>
            AI will extract key highlights from your description and compose the
            infographic — entirely via OpenAI.
          </SectionDesc>
          <div
            style={{
              display: "flex",
              gap: "12px",
              marginBottom: "12px",
              flexWrap: "wrap",
            }}
          >
            <ReviewThumb label="Source" src={igImageUrl} />
            <div style={{ flex: 1, minWidth: "180px" }}>
              <ReviewTable
                rows={[
                  [
                    "Source",
                    useUpload ? "Uploaded image" : "Saved Fashn AI model",
                  ],
                  [
                    "Product Type",
                    igCategory === "food"
                      ? "Food / Packaged Goods"
                      : "Clothing / Apparel",
                  ],
                  [
                    "Style",
                    TEMPLATES.find((t) => t.id === igStyle)?.label ?? igStyle,
                  ],
                  [
                    "Background",
                    igCustomStyle.length > 60
                      ? igCustomStyle.slice(0, 60) + "…"
                      : igCustomStyle,
                  ],
                  [
                    "Description",
                    igDesc.length > 80 ? igDesc.slice(0, 80) + "…" : igDesc,
                  ],
                ]}
              />
            </div>
          </div>
          <p
            style={{
              fontSize: "12px",
              color: "#6B7280",
              background: "#F9FAFB",
              padding: "10px 12px",
              borderRadius: "8px",
              margin: "0 0 4px",
              lineHeight: 1.6,
            }}
          >
            3–4 short highlights will be extracted and overlaid as bold callout
            badges on the infographic. No sentences.
          </p>
          <StepNav
            onBack={() => setIgStep(2)}
            onNext={() => {
              setIgStep(3);
              doIgGenerate();
            }}
            nextLabel="Generate Infographic"
            isGenerate
          />
        </Card>
      )}
    </div>
  );
}

// ── Workflow Selector ─────────────────────────────────────────────────────────

const WF_ICONS = {
  "model-generation": (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="7" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4 21v-1a8 8 0 0116 0v1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M18 2l2 2-5 5-2-2z" fill="currentColor" opacity=".6" />
    </svg>
  ),
  "flat-lay": (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect
        x="3"
        y="8"
        width="18"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M7 8V6a2 2 0 014 0v2M13 8V6a2 2 0 014 0v2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M8 13h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  mannequin: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="5" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 10h8l-1 5H9l-1-5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M10 15l-1 5M14 15l1 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  accessories: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="3 2"
      />
      <path
        d="M12 3v3M12 18v3M3 12h3M18 12h3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  infographic: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M7 17V13M10 17V9M13 17v-5M16 17V7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
};

const WF_NUMBERS = ["01", "02", "03", "04", "05"];

function WorkflowSelector({ onSelect }) {
  const [hovered, setHovered] = useState(null);
  return (
    <div>
      <div className="cr-sel-hero">
        <p className="cr-sel-label">AI Studio</p>
        <h2 className="cr-sel-title">Choose your workflow</h2>
        <p className="cr-sel-sub">
          Each workflow is a guided process — pick the one that matches your
          asset type.
        </p>
      </div>

      <div className="cr-wf-grid">
        {WORKFLOWS.map((wf, idx) => {
          const col = WF_COLORS[wf.id];
          const isHov = hovered === wf.id;
          return (
            <div
              key={wf.id}
              className="cr-wf-card"
              role="button"
              tabIndex={0}
              style={{
                "--accent": col.accent,
                "--light": col.light,
                "--dark": col.dark,
              }}
              onMouseEnter={() => setHovered(wf.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect(wf.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(wf.id);
                }
              }}
            >
              {/* Image area */}
              <div className="cr-wf-img">
                <div
                  className="cr-wf-img-ring"
                  style={{ borderColor: `${col.accent}28` }}
                />
                <div
                  className="cr-wf-img-ring cr-wf-img-ring2"
                  style={{ borderColor: `${col.accent}14` }}
                />
                <div
                  className="cr-wf-img-icon"
                  style={{
                    background: isHov ? col.accent : "rgba(255,255,255,0.92)",
                    color: isHov ? "#fff" : col.accent,
                  }}
                >
                  {WF_ICONS[wf.id]}
                </div>
                <span
                  className="cr-wf-num-tag"
                  style={{ background: col.accent }}
                >
                  {WF_NUMBERS[idx]}
                </span>
              </div>

              {/* Text content */}
              <div className="cr-wf-content">
                <h3 className="cr-wf-card-title">{wf.title}</h3>
                <p className="cr-wf-card-desc">{wf.desc}</p>
                <div className="cr-wf-badges">
                  <span
                    className="cr-wf-badge"
                    style={{ background: col.light, color: col.accent }}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      style={{
                        display: "inline",
                        marginRight: "3px",
                        verticalAlign: "middle",
                      }}
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M12 7v5l3 3"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    {col.time}
                  </span>
                  <span
                    className="cr-wf-badge"
                    style={{ background: col.light, color: col.accent }}
                  >
                    {wf.steps.length} steps
                  </span>
                </div>
                <button
                  className="cr-wf-cta"
                  style={{
                    background: isHov ? col.accent : "transparent",
                    color: isHov ? "#fff" : col.accent,
                    borderColor: col.accent,
                  }}
                >
                  Start workflow
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    style={{ marginLeft: "6px" }}
                  >
                    <path
                      d="M5 12h14M13 6l6 6-6 6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function CreatePage() {
  const { models, savedGenerations } = useLoaderData();
  const navigate = useNavigate();
  const [phase, setPhase] = useState("select");
  const [wfType, setWfType] = useState(null);
  const wf = WORKFLOWS.find((w) => w.id === wfType);
  const col = WF_COLORS[wfType] ?? {
    accent: "#4F46E5",
    light: "#EEF2FF",
    dark: "#4338CA",
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="cr-page">
        {/* Header */}
        <div
          className="cr-page-hdr"
          style={
            phase === "workflow"
              ? { borderBottom: `2px solid ${col.accent}` }
              : {}
          }
        >
          <button
            className="cr-back"
            onClick={() =>
              phase === "workflow"
                ? setPhase("select")
                : navigate("/app/studio")
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              style={{ marginRight: "5px" }}
            >
              <path
                d="M19 12H5M5 12l6 6M5 12l6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {phase === "select" ? "Back to Studio" : "Change"}
          </button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <h1 className="cr-page-title">
              {phase === "select"
                ? "Create New Asset"
                : (wf?.title ?? "Create")}
            </h1>
            {phase === "workflow" && (
              <p className="cr-page-sub" style={{ color: col.accent }}>
                {wf?.steps?.length} steps · {col.time} estimated
              </p>
            )}
          </div>
          <div style={{ width: "90px" }} />
        </div>

        <div className="cr-body">
          {phase === "select" && (
            <WorkflowSelector
              onSelect={(id) => {
                setWfType(id);
                setPhase("workflow");
              }}
            />
          )}
          {phase === "workflow" && wfType === "model-generation" && (
            <WorkflowModelGeneration models={models} />
          )}
          {phase === "workflow" && wfType === "flat-lay" && (
            <WorkflowFlatLay models={models} />
          )}
          {phase === "workflow" && wfType === "mannequin" && (
            <WorkflowMannequin models={models} />
          )}
          {phase === "workflow" && wfType === "accessories" && (
            <WorkflowAccessories models={models} />
          )}
          {phase === "workflow" && wfType === "infographic" && (
            <WorkflowInfographic savedGenerations={savedGenerations} />
          )}
        </div>
      </div>
    </>
  );
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
@keyframes cr-spin    { to { transform:rotate(360deg); } }
@keyframes cr-float   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
@keyframes cr-confetti{ 0%{transform:translateY(0) scale(1);opacity:1} 100%{transform:translateY(-28px) scale(0.6);opacity:0} }
@keyframes cr-shimmer { 0%{background-position:200% center} 100%{background-position:-200% center} }
@keyframes cr-bar-in  { from{width:0} }

/* ─── Page shell ──────────────────────────────────────────────────────────── */
.cr-page { max-width:860px; margin:0 auto; padding:0 0 80px; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#111827; background:#F8FAFC; min-height:100vh; }
.cr-body { padding:0 20px; }

/* ─── Page header ─────────────────────────────────────────────────────────── */
.cr-page-hdr { display:flex; align-items:center; padding:16px 20px; background:#fff; border-bottom:1px solid #E5E7EB; margin-bottom:24px; gap:12px; }
.cr-back { display:inline-flex; align-items:center; font-family:inherit; font-size:13px; font-weight:500; color:#6B7280; background:none; border:none; cursor:pointer; padding:7px 12px; border-radius:8px; transition:all 0.15s; }
.cr-back:hover { background:#F3F4F6; color:#374151; }
.cr-page-title { font-size:17px; font-weight:700; color:#111827; margin:0; letter-spacing:-0.2px; }
.cr-page-sub   { font-size:12px; font-weight:600; margin:2px 0 0; }

/* ─── Workflow selector ───────────────────────────────────────────────────── */
.cr-sel-hero { text-align:center; padding:32px 20px 24px; }
.cr-sel-label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; color:#9CA3AF; margin:0 0 8px; }
.cr-sel-title { font-size:24px; font-weight:800; color:#111827; margin:0 0 8px; letter-spacing:-0.4px; }
.cr-sel-sub   { font-size:14px; color:#6B7280; margin:0; }

.cr-wf-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; padding:0 0 24px; }
@media(max-width:700px){ .cr-wf-grid{grid-template-columns:repeat(2,1fr);} }
@media(max-width:420px){ .cr-wf-grid{grid-template-columns:1fr;} }

.cr-wf-card {
  background:#fff; border-radius:16px; overflow:hidden;
  cursor:pointer; position:relative; border:1.5px solid #E5E7EB;
  display:flex; flex-direction:column;
  transition:transform 0.18s, box-shadow 0.18s, border-color 0.18s;
}
.cr-wf-card:hover { transform:translateY(-4px); box-shadow:0 16px 40px rgba(0,0,0,0.12); border-color:var(--accent); }

/* ─── Card image area ─────────────────────────────────────────────────────── */
.cr-wf-img { height:140px; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; background:var(--light); }
.cr-wf-img-icon { width:60px; height:60px; border-radius:16px; display:flex; align-items:center; justify-content:center; transition:all 0.2s; z-index:1; position:relative; box-shadow:0 4px 16px rgba(0,0,0,0.08); }
.cr-wf-img-icon svg { width:28px; height:28px; }
.cr-wf-img-ring { position:absolute; width:88px; height:88px; border-radius:50%; border:1.5px solid; pointer-events:none; }
.cr-wf-img-ring2 { width:126px; height:126px; }
.cr-wf-num-tag { position:absolute; top:10px; left:10px; font-size:10px; font-weight:800; color:#fff; padding:2px 8px; border-radius:20px; letter-spacing:0.04em; z-index:2; }

/* ─── Card text content ───────────────────────────────────────────────────── */
.cr-wf-content { padding:14px 14px 14px; display:flex; flex-direction:column; flex:1; }
.cr-wf-card-title { font-size:13px; font-weight:700; color:#111827; margin:0 0 5px; line-height:1.3; }
.cr-wf-card-desc  { font-size:11px; color:#6B7280; margin:0 0 10px; line-height:1.5; flex:1; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.cr-wf-badges { display:flex; gap:4px; margin-bottom:12px; flex-wrap:wrap; }
.cr-wf-badge { font-size:10px; font-weight:600; padding:2px 7px; border-radius:20px; }
.cr-wf-cta { display:inline-flex; align-items:center; justify-content:center; font-family:inherit; font-size:12px; font-weight:600; padding:8px 14px; border-radius:8px; border:1.5px solid; cursor:pointer; transition:all 0.18s; width:100%; }

/* ─── Stepper — connected track ───────────────────────────────────────────── */
.cr-stepper { background:#fff; border-radius:14px; padding:18px 20px 22px; margin-bottom:16px; border:1px solid #E5E7EB; box-shadow:0 1px 4px rgba(0,0,0,0.04); }

/* context row */
.cr-step-ctx { display:flex; align-items:center; gap:10px; margin-bottom:24px; }
.cr-step-pill { font-size:11px; font-weight:700; padding:3px 11px; border-radius:20px; flex-shrink:0; letter-spacing:0.02em; }
.cr-step-curname { font-size:14px; font-weight:700; color:#111827; }

/* track wrapper — padding = half of dot width (28/2 = 14px) so rail centers on dots */
.cr-track { position:relative; padding:0 14px; }

/* gray rail */
.cr-rail-bg {
  position:absolute; top:14px; left:14px; right:14px; height:2px;
  background:#E5E7EB; border-radius:99px;
}

/* coloured fill — starts at left:14px (center of first dot) */
.cr-rail-fill {
  position:absolute; top:14px; left:14px; height:2px;
  border-radius:99px; z-index:1;
  transition:width 0.55s cubic-bezier(.4,0,.2,1);
}

/* dots row sits on top of the rails */
.cr-dots { display:flex; justify-content:space-between; position:relative; z-index:2; }

.cr-dot-item { display:flex; flex-direction:column; align-items:center; gap:7px; }

/* dot circles */
.cr-dot-circle {
  width:28px; height:28px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  flex-shrink:0; transition:all 0.25s;
}
.cr-dot-circle.idle   { background:#F3F4F6; }
.cr-dot-circle.done   { background:#10B981; }
.cr-dot-circle.active { /* colour + shadow set inline */ }

.cr-dot-n { font-size:11px; font-weight:700; color:#9CA3AF; }

/* labels */
.cr-dot-lbl { font-size:10px; color:#C4C4C4; text-align:center; white-space:nowrap; line-height:1; transition:all 0.2s; }
.cr-dot-lbl.active { color:#111827; font-weight:700; font-size:11px; }
.cr-dot-lbl.done   { color:#10B981; font-weight:500; }

@media(max-width:520px){ .cr-dot-lbl { display:none; } }

/* ─── Step card ───────────────────────────────────────────────────────────── */
.cr-card { background:#fff; border:1px solid #E5E7EB; border-radius:14px; padding:24px; margin-bottom:14px; }
.cr-card-title { font-size:16px; font-weight:700; color:#111827; margin:0 0 6px; }
.cr-card-desc  { font-size:13px; color:#6B7280; margin:0 0 20px; line-height:1.5; }

/* ─── Step nav ────────────────────────────────────────────────────────────── */
.cr-nav { display:flex; align-items:center; margin-top:24px; padding-top:18px; border-top:1px solid #F3F4F6; gap:10px; }
.cr-gen-wrap { display:flex; flex-direction:column; align-items:flex-end; gap:6px; margin-left:auto; }
.cr-btn-generate {
  display:inline-flex; align-items:center; justify-content:center;
  font-family:inherit; font-size:15px; font-weight:700; color:#fff;
  padding:13px 32px; border-radius:12px; border:none; cursor:pointer;
  background:linear-gradient(135deg,#1E1B4B,#111827);
  box-shadow:0 4px 16px rgba(0,0,0,0.25);
  transition:all 0.2s;
  position:relative; overflow:hidden;
}
.cr-btn-generate::after {
  content:""; position:absolute; inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent);
  background-size:200% 100%;
  animation:cr-shimmer 2s ease infinite;
}
.cr-btn-generate:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 24px rgba(0,0,0,0.3); }
.cr-btn-generate:disabled { opacity:0.45; cursor:not-allowed; }
.cr-credit-note { font-size:11px; color:#9CA3AF; margin:0; display:flex; align-items:center; }

/* ─── Upload zone ─────────────────────────────────────────────────────────── */
.cr-zone { border:2px dashed #D1D5DB; border-radius:12px; background:#FAFAFA; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; transition:all 0.15s; position:relative; overflow:hidden; }
.cr-zone:hover { border-color:#4F46E5; background:#F5F3FF; }
.cr-zone.drag   { border-color:#4F46E5; background:#EEF2FF; transform:scale(1.01); }
.cr-zone.filled { border-style:solid; border-color:#059669; background:#F0FDF4; }
.cr-zone.errored { border-color:#EF4444; background:#FEF2F2; }
.cr-zone-bar { position:absolute; bottom:0; left:0; right:0; background:rgba(5,150,105,0.9); padding:5px; text-align:center; font-size:10px; font-weight:700; color:#fff; }
.cr-field-error { display:flex; align-items:center; gap:6px; font-size:11px; color:#DC2626; background:#FEF2F2; border:1px solid #FECACA; border-radius:6px; padding:6px 10px; margin-top:6px; line-height:1.4; }

/* ─── Req chips ───────────────────────────────────────────────────────────── */
.cr-req-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px; }
.cr-req { font-size:11px; font-weight:500; color:#4F46E5; background:#EEF2FF; padding:3px 10px; border-radius:20px; }

/* ─── Model selector ──────────────────────────────────────────────────────── */
.cr-model-tabs { display:flex; border:1px solid #E5E7EB; border-radius:10px; overflow:hidden; margin-bottom:14px; }
.cr-model-tab  { flex:1; padding:10px; font-family:inherit; font-size:13px; font-weight:600; color:#6B7280; background:#F9FAFB; border:none; cursor:pointer; transition:all 0.15s; }
.cr-model-tab.active { background:#111827; color:#fff; }
.cr-model-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:10px; }
@media(max-width:640px){ .cr-model-grid{grid-template-columns:repeat(3,1fr);} }
@media(max-width:440px){ .cr-model-grid{grid-template-columns:repeat(2,1fr);} }
.cr-model-card { border:1.5px solid #E5E7EB; border-radius:10px; overflow:hidden; cursor:pointer; background:#fff; transition:all 0.15s; }
.cr-model-card:hover { border-color:#4F46E5; transform:translateY(-2px); box-shadow:0 4px 12px rgba(79,70,229,0.1); }
.cr-model-card.selected { border-color:#111827; box-shadow:0 0 0 2px #111827; }
.cr-model-thumb { height:100px; background:#F9FAFB; display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; }
.cr-model-tick { position:absolute; top:4px; right:4px; width:18px; height:18px; border-radius:50%; background:#111827; display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px; font-weight:700; }
.cr-model-name { font-size:10px; font-weight:500; color:#6B7280; padding:5px 7px 6px; line-height:1.3; }

/* ─── Settings grid ───────────────────────────────────────────────────────── */
.cr-settings-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 16px; }
@media(max-width:540px){ .cr-settings-grid{grid-template-columns:1fr;} }

/* ─── Form inputs ─────────────────────────────────────────────────────────── */
.cr-input { width:100%; padding:9px 12px; border:1.5px solid #E5E7EB; border-radius:9px; font-size:13px; font-family:inherit; color:#111827; background:#fff; outline:none; transition:border-color 0.15s; box-sizing:border-box; }
.cr-input:focus { border-color:#4F46E5; box-shadow:0 0 0 3px rgba(79,70,229,0.08); }
.cr-two-col { display:grid; grid-template-columns:1fr 1fr; gap:0 14px; }
@media(max-width:500px){ .cr-two-col{grid-template-columns:1fr;} }

/* ─── Tags ────────────────────────────────────────────────────────────────── */
.cr-tags { display:flex; flex-wrap:wrap; align-items:center; gap:5px; padding:6px 10px; border:1.5px solid #E5E7EB; border-radius:9px; background:#fff; min-height:42px; cursor:text; margin-bottom:14px; }
.cr-tags:focus-within { border-color:#4F46E5; }
.cr-tag { display:inline-flex; align-items:center; gap:3px; background:#EEF2FF; color:#4F46E5; font-size:12px; font-weight:600; padding:3px 9px; border-radius:20px; }
.cr-tag-x { background:none; border:none; cursor:pointer; color:#4F46E5; font-size:15px; padding:0; line-height:1; }
.cr-tag-input { border:none; outline:none; font-size:13px; font-family:inherit; flex:1; min-width:100px; color:#111827; background:transparent; }

/* ─── Choice / category buttons ──────────────────────────────────────────── */
.cr-choice-btn { padding:8px 16px; border:1.5px solid #E5E7EB; border-radius:8px; background:#fff; font-family:inherit; font-size:13px; font-weight:500; color:#6B7280; cursor:pointer; transition:all 0.15s; }
.cr-choice-btn.active { border-color:#111827; background:#111827; color:#fff; }
.cr-choice-btn:hover:not(.active) { border-color:#9CA3AF; color:#374151; }

/* ─── Template list ───────────────────────────────────────────────────────── */
.cr-template-list { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
.cr-template-row { display:flex; align-items:center; gap:14px; padding:13px 16px; border:1.5px solid #E5E7EB; border-radius:10px; cursor:pointer; transition:all 0.15s; }
.cr-template-row:hover { border-color:#4F46E5; background:#FAFBFF; }
.cr-template-row.selected { border-color:#111827; background:#FAFAFA; }
.cr-template-dot { width:18px; height:18px; border-radius:5px; flex-shrink:0; }
.cr-template-check { width:20px; height:20px; border-radius:50%; background:#111827; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:700; opacity:0; transition:opacity 0.15s; }
.cr-template-check.visible { opacity:1; }

/* ─── Front / back image pair ─────────────────────────────────────────────── */
.cr-img-pair { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:16px; }
@media(max-width:480px){ .cr-img-pair{grid-template-columns:1fr;} }

/* ─── Multi-image grid ────────────────────────────────────────────────────── */
.cr-img-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:8px; }
@media(max-width:500px){ .cr-img-grid{grid-template-columns:repeat(3,1fr);} }
.cr-img-thumb { height:90px; border-radius:9px; overflow:hidden; border:1px solid #E5E7EB; position:relative; }
.cr-img-rm { position:absolute; top:4px; right:4px; width:20px; height:20px; border-radius:50%; background:rgba(0,0,0,0.5); border:none; color:#fff; cursor:pointer; font-size:13px; display:flex; align-items:center; justify-content:center; padding:0; line-height:1; }
.cr-img-add { height:90px; border:2px dashed #D1D5DB; border-radius:9px; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; transition:all 0.15s; gap:4px; }
.cr-img-add:hover { border-color:#4F46E5; background:#EEF2FF; }
.cr-img-add.busy { opacity:0.6; cursor:wait; }

/* ─── Generating screen ───────────────────────────────────────────────────── */
.cr-generating { text-align:center; padding:48px 24px; }
.cr-gen-orbit { width:72px; height:72px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 24px; position:relative; }
.cr-gen-orbit-ring { position:absolute; inset:0; border-radius:50%; border:3px solid #E5E7EB; border-top-color:var(--accent,#4F46E5); animation:cr-spin 1s linear infinite; }
.cr-gen-orbit-inner { position:absolute; inset:8px; border-radius:50%; border:2px solid #F3F4F6; border-bottom-color:var(--accent,#4F46E5); animation:cr-spin 1.6s linear infinite reverse; opacity:0.6; }
.cr-gen-title { font-size:20px; font-weight:800; color:#111827; margin:0 0 6px; letter-spacing:-0.3px; }
.cr-gen-sub { font-size:13px; color:#9CA3AF; margin:0 0 20px; }
.cr-gen-bar-track { height:8px; background:#F3F4F6; border-radius:99px; overflow:hidden; max-width:360px; margin:0 auto 6px; }
.cr-gen-bar-fill { height:100%; border-radius:99px; transition:width 2s linear; }
.cr-gen-pct { font-size:13px; font-weight:700; margin-bottom:24px; }
.cr-gen-stages { max-width:340px; margin:0 auto; text-align:left; display:flex; flex-direction:column; gap:10px; }
.cr-gen-stage { display:flex; align-items:center; gap:10px; font-size:12px; color:#D1D5DB; transition:all 0.4s; }
.cr-gen-stage.active { color:#111827; font-weight:600; }
.cr-gen-stage.done   { color:#059669; }
.cr-gen-stage-icon { width:18px; height:18px; border-radius:50%; background:#E5E7EB; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.3s; }
.cr-gen-stage.done .cr-gen-stage-icon { background:#059669; }
.cr-gen-pulse { width:6px; height:6px; border-radius:50%; background:#fff; display:block; animation:cr-spin 0.6s linear infinite; }
.cr-gen-timer { font-size:11px; color:#9CA3AF; margin:20px 0 0; }

/* ─── Output / completion ─────────────────────────────────────────────────── */
.cr-complete-header { background:linear-gradient(135deg,#ECFDF5,#F0FDF4); border:1px solid #A7F3D0; border-radius:14px; padding:20px 20px 16px; margin-bottom:20px; display:flex; align-items:flex-start; gap:14px; position:relative; overflow:hidden; }
.cr-complete-check { width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 4px 12px rgba(5,150,105,0.3); animation:cr-float 2s ease-in-out infinite; }
.cr-complete-title { font-size:17px; font-weight:800; color:#065F46; margin:0 0 3px; }
.cr-complete-sub   { font-size:13px; color:#059669; margin:0; }
.cr-confetti { position:absolute; bottom:6px; right:12px; display:flex; gap:0; }
.cr-confetti-dot { width:7px; height:7px; border-radius:50%; position:absolute; bottom:0; animation:cr-confetti 1.6s ease-out infinite; }
.cr-result-img-wrap { background:#F1F5F9; border-radius:14px; display:flex; justify-content:center; align-items:center; padding:16px; margin-bottom:16px; border:1px solid #E2E8F0; min-height:200px; }
.cr-result-img { max-width:100%; max-height:500px; object-fit:contain; border-radius:10px; box-shadow:0 8px 32px rgba(0,0,0,0.12); }
.cr-result-actions { display:flex; gap:8px; flex-wrap:wrap; padding-top:16px; border-top:1px solid #F3F4F6; align-items:center; }
.cr-btn-save { display:inline-flex; align-items:center; justify-content:center; font-family:inherit; font-size:13px; font-weight:700; color:#fff; padding:10px 20px; border-radius:9px; border:none; cursor:pointer; transition:all 0.15s; margin-left:auto; }
.cr-btn-save:hover:not(:disabled) { filter:brightness(1.1); }
.cr-btn-save:disabled { opacity:0.5; cursor:not-allowed; }

/* ─── Banners ─────────────────────────────────────────────────────────────── */
.cr-ok-banner { background:#ECFDF5; border:1px solid #A7F3D0; border-radius:8px; padding:10px 12px; font-size:12px; color:#065F46; font-weight:500; margin-top:10px; }
.cr-err-banner { display:flex; align-items:center; gap:8px; background:#FEF2F2; border:1px solid #FECACA; border-radius:10px; padding:12px 14px; margin-bottom:16px; font-size:13px; color:#B91C1C; }

/* ─── Buttons ─────────────────────────────────────────────────────────────── */
.cr-btn { display:inline-flex; align-items:center; justify-content:center; font-family:inherit; font-weight:600; border-radius:9px; border:none; cursor:pointer; transition:all 0.15s; white-space:nowrap; font-size:13px; padding:9px 18px; }
.cr-btn:disabled { opacity:0.45; cursor:not-allowed; }
.cr-btn-primary { background:#111827; color:#fff; }
.cr-btn-primary:hover:not(:disabled) { background:#1F2937; }
.cr-btn-ghost { background:#F3F4F6; color:#374151; }
.cr-btn-ghost:hover { background:#E5E7EB; }
.cr-btn-outline { background:#fff; color:#374151; border:1px solid #D1D5DB; text-decoration:none; }
.cr-btn-outline:hover { background:#F9FAFB; }

@media(max-width:640px){
  .cr-body { padding:0 12px; }
  .cr-card { padding:18px 14px; }
  .cr-sel-title { font-size:20px; }
}

/* ─── Product type selector ───────────────────────────────────────────────── */
.cr-pt-group { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; color:#9CA3AF; margin:0 0 8px; }
.cr-pt-grid { display:flex; flex-wrap:wrap; gap:6px; }
.cr-pt-btn { padding:7px 14px; border:1.5px solid #E5E7EB; border-radius:20px; background:#fff; font-family:inherit; font-size:12px; font-weight:500; color:#374151; cursor:pointer; transition:all 0.15s; white-space:nowrap; }
.cr-pt-btn:hover:not(.active) { border-color:#9CA3AF; background:#F9FAFB; color:#111827; }
.cr-pt-btn.active { border-color:#4F46E5; background:#4F46E5; color:#fff; font-weight:600; }

/* ─── Wear type selector (shows below when clothing is selected) ───────────── */
.cr-weartype-box { background:#EEF2FF; border:1.5px solid #C7D2FE; border-radius:12px; padding:16px; margin-top:20px; }
.cr-weartype-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; }
@media(max-width:500px){ .cr-weartype-grid{ grid-template-columns:1fr; } }
.cr-weartype-btn { padding:12px 10px; border:1.5px solid #C7D2FE; border-radius:10px; background:#fff; font-family:inherit; cursor:pointer; transition:all 0.15s; text-align:left; }
.cr-weartype-btn:hover:not(.active) { border-color:#6366F1; background:#F5F3FF; }
.cr-weartype-btn.active { border-color:#4F46E5; background:#4F46E5; color:#fff; }
.cr-weartype-label { display:block; font-size:12px; font-weight:700; margin-bottom:3px; }
.cr-weartype-desc { display:block; font-size:11px; opacity:0.65; }

/* ─── Infographic addon toggle ────────────────────────────────────────────── */
.cr-addon-row { background:#F0FDF4; border:1.5px solid #A7F3D0; border-radius:10px; padding:12px 14px; margin:14px 0 0; cursor:pointer; transition:border-color 0.15s; }
.cr-addon-row:hover { border-color:#6EE7B7; }
.cr-addon-inner { display:flex; align-items:center; gap:10px; }
.cr-addon-icon-box { width:32px; height:32px; border-radius:8px; background:#D1FAE5; display:flex; align-items:center; justify-content:center; color:#059669; flex-shrink:0; }
.cr-addon-text { flex:1; }
.cr-addon-title { font-size:12px; font-weight:600; color:#065F46; margin:0 0 2px; }
.cr-addon-sub { font-size:11px; color:#6B7280; margin:0; }
.cr-addon-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }
.cr-addon-credit { font-size:10px; font-weight:700; color:#059669; background:#D1FAE5; padding:2px 7px; border-radius:20px; }
.cr-toggle { width:38px; height:22px; border-radius:11px; background:#D1D5DB; position:relative; cursor:pointer; transition:background 0.2s; flex-shrink:0; }
.cr-toggle.on { background:#059669; }
.cr-toggle-thumb { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform 0.2s; box-shadow:0 1px 4px rgba(0,0,0,0.2); }
.cr-toggle.on .cr-toggle-thumb { transform:translateX(16px); }

/* ─── Infographic result section ──────────────────────────────────────────── */
.cr-info-result { margin-top:20px; border-top:1px solid #D1FAE5; padding-top:16px; }
.cr-info-result-hdr { display:flex; align-items:center; gap:6px; margin-bottom:10px; }
.cr-info-result-title { font-size:13px; font-weight:600; color:#059669; margin:0; }
.cr-info-loading { display:flex; align-items:center; gap:10px; padding:12px 14px; background:#F0FDF4; border-radius:8px; border:1px solid #A7F3D0; }
.cr-info-loading-text { font-size:12px; color:#059669; font-weight:500; }
`;
