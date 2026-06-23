import { useEffect, useRef, useState } from "react";
import {
  Copy, Download, Image, LoaderCircle, Plus, RotateCw, Sparkles, Trash2, Upload,
} from "lucide-react";
import { projectsClient } from "./infrastructure/projects-client";
import { useAppStore } from "./store/app-store";

// ── Types ─────────────────────────────────────────────────────────────────────

type AR = "16:9" | "9:16";
type ElemType = "text" | "image";
type TA = "left" | "center" | "right";
type LeftTab = "bg" | "text" | "elements" | "ai";

export type DesignElem = {
  id: string; type: ElemType;
  x: number; y: number; w: number; h: number; // 0-100 % of canvas
  rot: number; z: number;
  // text
  text?: string; fontFamily?: string; fontSize?: number; // % of canvas height
  bold?: boolean; italic?: boolean; color?: string; align?: TA;
  // image
  src?: string; imgOpacity?: number;
};

type Design = { bgColor: string; bgSrc: string | null; elems: DesignElem[] };

type DragMode = "move" | "move-pending" | "resize" | "rotate";
type DragState = {
  mode: DragMode; elemId: string;
  startCX: number; startCY: number;       // client coords at drag start
  startEX: number; startEY: number;       // elem x,y at drag start
  startEW: number; startEH: number;       // elem w,h at drag start
  startRot: number;                       // elem rotation at drag start
  handle?: string;                        // resize handle direction
  pivotCX?: number; pivotCY?: number;     // element center in client coords (rotate)
  hasMoved: boolean;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const FONTS = ["Inter", "Arial", "Georgia", "Impact", "Verdana", "Courier New", "Times New Roman", "Comic Sans MS", "Trebuchet MS"];

const INIT_DESIGN: Design = { bgColor: "#1a1a2e", bgSrc: null, elems: [] };

function uid() { return Math.random().toString(36).slice(2, 10); }

function svgUrl(svg: string) {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

type PresetDef = { id: string; label: string; url: string; dw: number; dh: number };

const PRESETS: PresetDef[] = [
  { id: "arrow-r", label: "Arrow →", dw: 28, dh: 14,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><polygon points="0,15 80,15 80,0 120,30 80,60 80,45 0,45" fill="#FF3B3B"/></svg>`) },
  { id: "star", label: "Star ★", dw: 18, dh: 18,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35" fill="#FFD700"/></svg>`) },
  { id: "badge-new", label: "NEW Badge", dw: 16, dh: 16,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#FF3B3B" stroke="white" stroke-width="5"/><text x="50" y="58" text-anchor="middle" fill="white" font-size="28" font-weight="bold" font-family="Arial">NEW</text></svg>`) },
  { id: "check", label: "Check ✓", dw: 16, dh: 16,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#22c55e" stroke="white" stroke-width="5"/><polyline points="25,50 43,68 75,32" fill="none" stroke="white" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`) },
  { id: "subscribe", label: "Subscribe", dw: 36, dh: 14,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" rx="10" fill="#FF0000"/><text x="100" y="39" text-anchor="middle" fill="white" font-size="22" font-weight="bold" font-family="Arial">SUBSCRIBE</text></svg>`) },
  { id: "crown", label: "Crown ♛", dw: 22, dh: 14,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 65"><polygon points="5,60 5,30 25,50 50,5 75,50 95,30 95,60" fill="#FFD700" stroke="#B8860B" stroke-width="3" stroke-linejoin="round"/><rect x="5" y="60" width="90" height="5" rx="2" fill="#B8860B"/></svg>`) },
  { id: "fire", label: "Fire 🔥", dw: 14, dh: 20,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 90"><path d="M30 88C8 76 2 55 12 36 17 47 22 49 22 36 22 16 30 5 30 2 36 18 46 28 43 47 49 39 51 27 49 17 57 33 62 53 51 72 46 62 42 68 42 78Z" fill="#FF6B1A"/><path d="M30 88C16 80 11 65 20 51 22 59 26 61 26 51 26 39 30 32 30 28 35 38 40 46 38 56 42 50 44 41 42 34 48 47 51 63 45 77Z" fill="#FFD700"/></svg>`) },
  { id: "burst", label: "Burst ✦", dw: 18, dh: 18,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,2 54,42 92,33 60,55 76,90 50,63 24,90 40,55 8,33 46,42" fill="#FF3B3B"/></svg>`) },
  { id: "diamond", label: "Diamond ◆", dw: 18, dh: 18,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,4 96,50 50,96 4,50" fill="#A855F7" stroke="#7C3AED" stroke-width="4"/></svg>`) },
  { id: "exclaim", label: "Alert !", dw: 12, dh: 20,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 100"><rect x="18" y="4" width="24" height="62" rx="12" fill="#FF3B3B"/><circle cx="30" cy="88" r="10" fill="#FF3B3B"/></svg>`) },
  { id: "speech", label: "Speech", dw: 22, dh: 18,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><rect x="2" y="2" width="116" height="70" rx="14" fill="white" stroke="#ddd" stroke-width="2"/><polygon points="20,72 40,72 25,90" fill="white"/></svg>`) },
  { id: "banner", label: "Banner", dw: 36, dh: 12,
    url: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 60"><polygon points="0,0 220,0 220,48 110,60 0,48" fill="#1E40AF"/></svg>`) },
];

// ── Main component ─────────────────────────────────────────────────────────────

export function ThumbnailEditorPane() {
  const { addToast } = useAppStore();

  // Design state
  const [design, setDesign] = useState<Design>(INIT_DESIGN);
  const [ar, setAr] = useState<AR>("16:9");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("bg");

  // AI state
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Save state
  const [fileName, setFileName] = useState("thumbnail");
  const [saving, setSaving] = useState(false);

  // History
  const historyRef = useRef<Design[]>([]);
  const futureRef = useRef<Design[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Refs
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const preDragRef = useRef<Design | null>(null);
  const [containerH, setContainerH] = useState(400);

  const cw = ar === "9:16" ? 720 : 1280;
  const ch = ar === "9:16" ? 1280 : 720;

  // Track canvas container height for font scaling
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerH(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.getAttribute("contenteditable")) return;
        if (selectedId) { deleteElem(selectedId); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "d") { e.preventDefault(); if (selectedId) duplicateElem(selectedId); }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ── History ──────────────────────────────────────────────────────────────────

  function withHistory(updater: (d: Design) => Design) {
    setDesign(cur => {
      historyRef.current.push(cur);
      if (historyRef.current.length > 40) historyRef.current.shift();
      futureRef.current = [];
      setCanUndo(true); setCanRedo(false);
      return updater(cur);
    });
  }

  function undo() {
    if (!historyRef.current.length) return;
    setDesign(cur => {
      futureRef.current.push(cur);
      const prev = historyRef.current.pop()!;
      setCanUndo(historyRef.current.length > 0);
      setCanRedo(true);
      return prev;
    });
    setSelectedId(null);
  }

  function redo() {
    if (!futureRef.current.length) return;
    setDesign(cur => {
      historyRef.current.push(cur);
      const next = futureRef.current.pop()!;
      setCanRedo(futureRef.current.length > 0);
      setCanUndo(true);
      return next;
    });
    setSelectedId(null);
  }

  // ── Design mutations ─────────────────────────────────────────────────────────

  function updateElemDirect(id: string, ch: Partial<DesignElem>) {
    setDesign(d => ({ ...d, elems: d.elems.map(e => e.id === id ? { ...e, ...ch } : e) }));
  }

  function updateElemWithHistory(id: string, ch: Partial<DesignElem>) {
    withHistory(d => ({ ...d, elems: d.elems.map(e => e.id === id ? { ...e, ...ch } : e) }));
  }

  function deleteElem(id: string) {
    withHistory(d => ({ ...d, elems: d.elems.filter(e => e.id !== id) }));
    setSelectedId(null);
    setEditingId(null);
  }

  function duplicateElem(id: string) {
    withHistory(d => {
      const src = d.elems.find(e => e.id === id);
      if (!src) return d;
      const copy: DesignElem = { ...src, id: uid(), x: src.x + 3, y: src.y + 3, z: d.elems.length };
      return { ...d, elems: [...d.elems, copy] };
    });
  }

  function moveZ(id: string, dir: 1 | -1) {
    withHistory(d => {
      const sorted = [...d.elems].sort((a, b) => a.z - b.z);
      const idx = sorted.findIndex(e => e.id === id);
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= sorted.length) return d;
      [sorted[idx].z, sorted[targetIdx].z] = [sorted[targetIdx].z, sorted[idx].z];
      return { ...d, elems: sorted };
    });
  }

  function addTextElem() {
    const newElem: DesignElem = {
      id: uid(), type: "text",
      x: 20, y: 35, w: 60, h: 12, rot: 0, z: design.elems.length,
      text: "Add your text", fontFamily: "Inter", fontSize: 7,
      bold: true, italic: false, color: "#ffffff", align: "center",
    };
    withHistory(d => ({ ...d, elems: [...d.elems, newElem] }));
    setSelectedId(newElem.id);
    setLeftTab("text");
  }

  function addImageElem(src: string, defaultW = 28, defaultH = 28) {
    const newElem: DesignElem = {
      id: uid(), type: "image",
      x: 36, y: 36, w: defaultW, h: defaultH, rot: 0, z: design.elems.length,
      src, imgOpacity: 1,
    };
    withHistory(d => ({ ...d, elems: [...d.elems, newElem] }));
    setSelectedId(newElem.id);
  }

  function setBg(field: "bgColor" | "bgSrc", value: string | null) {
    withHistory(d => ({ ...d, [field]: value }));
  }

  async function pickBgImage() {
    const picked = await projectsClient.pickThumbnailImage();
    if (!picked) return;
    setBg("bgSrc", picked.dataUrl);
    setFileName(picked.fileName.replace(/\.[^.]+$/, "") + "-edited");
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith("image/"));
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBg("bgSrc", reader.result as string);
    reader.readAsDataURL(file);
  }

  async function generateAiElement() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true); setAiError(null);
    try {
      const src = document.createElement("canvas");
      src.width = 512; src.height = 512;
      const ctx = src.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 512, 512);
      const whiteDataUrl = src.toDataURL("image/png");
      const prompt = `Create a vivid, eye-catching thumbnail graphic element on a plain white background: ${aiPrompt.trim()}. Style: bold, vibrant. Center the subject in the frame. Do NOT add text. Keep the background solid white.`;
      const result = await projectsClient.editThumbnailImage(whiteDataUrl, prompt, null, "High", "1:1");
      addImageElem(result, 28, 28);
      setAiPrompt("");
      addToast("Element generated and added to canvas.", "success");
    } catch (err) { setAiError(String(err)); }
    finally { setAiLoading(false); }
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  async function saveDesign() {
    setSaving(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = design.bgColor;
      ctx.fillRect(0, 0, cw, ch);
      if (design.bgSrc) {
        await new Promise<void>(res => {
          const img = document.createElement("img");
          img.onload = () => { ctx.drawImage(img, 0, 0, cw, ch); res(); };
          img.onerror = () => res();
          img.src = design.bgSrc!;
        });
      }
      for (const elem of [...design.elems].sort((a, b) => a.z - b.z)) {
        const ex = elem.x / 100 * cw, ey = elem.y / 100 * ch;
        const ew = elem.w / 100 * cw, eh = elem.h / 100 * ch;
        ctx.save();
        ctx.translate(ex + ew / 2, ey + eh / 2);
        ctx.rotate(elem.rot * Math.PI / 180);
        ctx.translate(-ew / 2, -eh / 2);
        if (elem.type === "image" && elem.src) {
          ctx.globalAlpha = elem.imgOpacity ?? 1;
          await new Promise<void>(res => {
            const img = document.createElement("img");
            img.onload = () => { ctx.drawImage(img, 0, 0, ew, eh); res(); };
            img.onerror = () => res();
            img.src = elem.src!;
          });
        } else if (elem.type === "text" && elem.text) {
          const fs = (elem.fontSize ?? 5) / 100 * ch;
          ctx.font = `${elem.italic ? "italic " : ""}${elem.bold ? "bold " : ""}${fs}px "${elem.fontFamily ?? "Inter"}"`;
          try { (ctx as unknown as { letterSpacing: string }).letterSpacing = "0px"; } catch {}
          ctx.textAlign = elem.align ?? "left";
          ctx.textBaseline = "top";
          ctx.fillStyle = elem.color ?? "#ffffff";
          ctx.globalAlpha = 1;
          const lh = fs * 1.25;
          elem.text.split("\n").forEach((line, i) => {
            const tx = elem.align === "center" ? ew / 2 : elem.align === "right" ? ew : 0;
            ctx.fillText(line, tx, i * lh);
          });
        }
        ctx.restore();
      }
      const dataUrl = canvas.toDataURL("image/png");
      const saved = await projectsClient.saveThumbnailImage(dataUrl, `${fileName}.png`);
      if (saved) addToast(`Saved: ${saved}`, "success");
    } catch (err) { addToast(`Save failed: ${err}`, "error"); }
    finally { setSaving(false); }
  }

  // ── Drag / resize / rotate ────────────────────────────────────────────────────

  function startDrag(e: React.PointerEvent, elem: DesignElem) {
    e.stopPropagation();
    preDragRef.current = design;
    dragRef.current = {
      mode: "move-pending", elemId: elem.id,
      startCX: e.clientX, startCY: e.clientY,
      startEX: elem.x, startEY: elem.y,
      startEW: elem.w, startEH: elem.h,
      startRot: elem.rot, hasMoved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function startResize(e: React.PointerEvent, elem: DesignElem, handle: string) {
    e.stopPropagation();
    preDragRef.current = design;
    dragRef.current = {
      mode: "resize", elemId: elem.id, handle,
      startCX: e.clientX, startCY: e.clientY,
      startEX: elem.x, startEY: elem.y,
      startEW: elem.w, startEH: elem.h,
      startRot: elem.rot, hasMoved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function startRotate(e: React.PointerEvent, elem: DesignElem) {
    e.stopPropagation();
    const container = canvasRef.current;
    if (!container) return;
    const cr = container.getBoundingClientRect();
    const pivotCX = cr.left + (elem.x + elem.w / 2) / 100 * cr.width;
    const pivotCY = cr.top + (elem.y + elem.h / 2) / 100 * cr.height;
    preDragRef.current = design;
    dragRef.current = {
      mode: "rotate", elemId: elem.id,
      startCX: e.clientX, startCY: e.clientY,
      startEX: elem.x, startEY: elem.y,
      startEW: elem.w, startEH: elem.h,
      startRot: elem.rot,
      pivotCX, pivotCY, hasMoved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const container = canvasRef.current;
    if (!container) return;
    const cr = container.getBoundingClientRect();

    const d = dragRef.current;
    const dCX = e.clientX - d.startCX;
    const dCY = e.clientY - d.startCY;

    if (d.mode === "move-pending") {
      if (Math.abs(dCX) < 3 && Math.abs(dCY) < 3) return;
      dragRef.current = { ...d, mode: "move" };
    }
    dragRef.current.hasMoved = true;
    const mode = dragRef.current.mode;

    if (mode === "move") {
      const dxPct = dCX / cr.width * 100;
      const dyPct = dCY / cr.height * 100;
      updateElemDirect(d.elemId, {
        x: Math.max(0, Math.min(100 - d.startEW, d.startEX + dxPct)),
        y: Math.max(0, Math.min(100 - d.startEH, d.startEY + dyPct)),
      });
      return;
    }

    if (mode === "resize") {
      const dxPct = dCX / cr.width * 100;
      const dyPct = dCY / cr.height * 100;
      const handle = d.handle!;
      let nx = d.startEX, ny = d.startEY, nw = d.startEW, nh = d.startEH;
      if (handle.includes("e")) nw = Math.max(4, d.startEW + dxPct);
      if (handle.includes("w")) { nw = Math.max(4, d.startEW - dxPct); nx = d.startEX + dxPct; }
      if (handle.includes("s")) nh = Math.max(4, d.startEH + dyPct);
      if (handle.includes("n")) { nh = Math.max(4, d.startEH - dyPct); ny = d.startEY + dyPct; }
      updateElemDirect(d.elemId, { x: nx, y: ny, w: nw, h: nh });
      return;
    }

    if (mode === "rotate") {
      const angle = Math.atan2(e.clientY - d.pivotCY!, e.clientX - d.pivotCX!) * 180 / Math.PI;
      const startAngle = Math.atan2(d.startCY - d.pivotCY!, d.startCX - d.pivotCX!) * 180 / Math.PI;
      updateElemDirect(d.elemId, { rot: d.startRot + (angle - startAngle) });
    }
  }

  function handlePointerUp() {
    const d = dragRef.current;
    if (d?.hasMoved && preDragRef.current) {
      historyRef.current.push(preDragRef.current);
      if (historyRef.current.length > 40) historyRef.current.shift();
      futureRef.current = [];
      setCanUndo(true); setCanRedo(false);
    }
    dragRef.current = null;
    preDragRef.current = null;
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const selected = design.elems.find(e => e.id === selectedId) ?? null;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="ted-root">

      {/* ── Left library panel ── */}
      <div className="ted-left">
        <div className="ted-ltabs">
          {(["bg", "text", "elements", "ai"] as LeftTab[]).map(tab => (
            <button key={tab} className={leftTab === tab ? "ted-ltab active" : "ted-ltab"} onClick={() => setLeftTab(tab)}>
              {tab === "bg" ? "Background" : tab === "text" ? "Text" : tab === "elements" ? "Elements" : "AI"}
            </button>
          ))}
        </div>
        <div className="ted-lcontent">

          {/* Background tab */}
          {leftTab === "bg" && (
            <div className="ted-panel-inner">
              <div className="ted-panel-section">
                <div className="ted-panel-label">Background color</div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <input type="color" value={design.bgColor}
                    onChange={e => setBg("bgColor", e.target.value)}
                    className="ted-color-input" style={{ width: "42px", height: "32px" }} />
                  <span style={{ fontSize: "11px", color: "var(--muted)" }}>{design.bgColor}</span>
                </div>
              </div>
              <div className="ted-panel-section">
                <div className="ted-panel-label">Background image</div>
                <button className="secondary full" onClick={() => void pickBgImage()}>
                  <Upload size={13} /> Upload image
                </button>
                {design.bgSrc && (
                  <>
                    <img src={design.bgSrc} alt="" className="ted-bg-preview" />
                    <button className="secondary full" style={{ marginTop: "6px" }}
                      onClick={() => setBg("bgSrc", null)}>
                      <Trash2 size={13} /> Remove background image
                    </button>
                  </>
                )}
                <p className="ted-note" style={{ marginTop: "8px" }}>Or drag &amp; drop an image onto the canvas.</p>
              </div>
              <div className="ted-panel-section">
                <div className="ted-panel-label">File name</div>
                <input className="ted-input" value={fileName}
                  onChange={e => setFileName(e.target.value)} placeholder="thumbnail" />
              </div>
              <div className="ted-panel-section">
                <div className="ted-panel-label">Aspect ratio</div>
                <div className="ted-toggle2">
                  <button className={ar === "16:9" ? "active" : ""} onClick={() => setAr("16:9")}>16:9</button>
                  <button className={ar === "9:16" ? "active" : ""} onClick={() => setAr("9:16")}>9:16</button>
                </div>
              </div>
            </div>
          )}

          {/* Text tab */}
          {leftTab === "text" && (
            <div className="ted-panel-inner">
              <div className="ted-panel-section">
                <button className="primary full" onClick={addTextElem}>
                  <Plus size={14} /> Add text box
                </button>
              </div>
              <div className="ted-panel-section">
                <div className="ted-panel-label">Quick add</div>
                {[
                  { label: "Big Heading", fs: 11, bold: true },
                  { label: "Subheading", fs: 7, bold: false },
                  { label: "Body text", fs: 4, bold: false },
                ].map(preset => (
                  <button key={preset.label} className="secondary full" style={{ marginBottom: "6px" }}
                    onClick={() => {
                      const e: DesignElem = {
                        id: uid(), type: "text",
                        x: 10, y: 30, w: 80, h: preset.fs * 1.6, rot: 0, z: design.elems.length,
                        text: preset.label, fontFamily: "Inter", fontSize: preset.fs,
                        bold: preset.bold, italic: false, color: "#ffffff", align: "center",
                      };
                      withHistory(d => ({ ...d, elems: [...d.elems, e] }));
                      setSelectedId(e.id);
                    }}>
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Elements tab */}
          {leftTab === "elements" && (
            <div className="ted-panel-inner">
              <div className="ted-panel-section">
                <div className="ted-panel-label">Preset elements</div>
                <div className="ted-presets-grid">
                  {PRESETS.map(p => (
                    <button key={p.id} className="ted-preset-btn"
                      onClick={() => addImageElem(p.url, p.dw, p.dh)}
                      title={p.label}>
                      <img src={p.url} alt={p.label} className="ted-preset-img" />
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="ted-panel-section">
                <div className="ted-panel-label">Custom image</div>
                <button className="secondary full"
                  onClick={async () => {
                    const picked = await projectsClient.pickThumbnailImage();
                    if (picked) addImageElem(picked.dataUrl, 40, 40);
                  }}>
                  <Upload size={13} /> Upload image element
                </button>
              </div>
            </div>
          )}

          {/* AI Generate tab */}
          {leftTab === "ai" && (
            <div className="ted-panel-inner">
              <div className="ted-panel-section">
                <div className="ted-panel-label">AI element generation</div>
                <textarea
                  className="ted-textarea"
                  value={aiPrompt}
                  onChange={e => setAiPrompt(e.target.value)}
                  placeholder="Describe an element to generate… e.g. glowing lightning bolt, red rose, golden trophy"
                  rows={4}
                />
                {aiError && (
                  <div className="inline-error" style={{ marginTop: "8px" }}>
                    {aiError}
                    <button type="button" style={{ float: "right", border: 0, background: "transparent", cursor: "pointer" }}
                      onClick={() => setAiError(null)}>×</button>
                  </div>
                )}
                <button className="primary full" style={{ marginTop: "10px" }}
                  onClick={() => void generateAiElement()}
                  disabled={!aiPrompt.trim() || aiLoading}>
                  {aiLoading
                    ? <><LoaderCircle className="spin" size={14} />Generating…</>
                    : <><Sparkles size={14} />Generate Element</>}
                </button>
                <p className="ted-note" style={{ marginTop: "8px" }}>
                  Generates an image using Gemini AI. The element is placed on the canvas and can be moved, resized, and rotated.
                </p>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── Canvas column ── */}
      <div className="ted-canvas-col">
        {/* Toolbar */}
        <div className="ted-toolbar">
          <button className="tbar-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↩ Undo</button>
          <button className="tbar-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">↪ Redo</button>
          <div className="tbar-sep" />
          {selectedId && (
            <>
              <button className="tbar-btn" onClick={() => duplicateElem(selectedId)} title="Duplicate (Ctrl+D)"><Copy size={12} />Copy</button>
              <button className="tbar-btn" onClick={() => deleteElem(selectedId)} title="Delete" style={{ color: "#bd5147" }}><Trash2 size={12} />Delete</button>
              <div className="tbar-sep" />
            </>
          )}
          <button className="tbar-btn" disabled={saving} onClick={() => void saveDesign()}>
            {saving ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />}
            Save PNG
          </button>
        </div>

        {/* Canvas area */}
        <div className="ted-canvas-area">
          <div
            className="ted-canvas-outer"
            style={{ aspectRatio: ar === "9:16" ? "9/16" : "16/9" }}
            ref={canvasRef}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onPointerDown={() => { setSelectedId(null); setEditingId(null); }}
            onDragOver={e => e.preventDefault()}
            onDrop={handleDrop}
          >
            {/* Background */}
            <div className="ted-bg-layer" style={{ background: design.bgColor }}>
              {design.bgSrc && (
                <img src={design.bgSrc} alt="" className="ted-bg-img" draggable={false} />
              )}
            </div>

            {/* Drop hint when empty */}
            {!design.bgSrc && design.elems.length === 0 && (
              <div className="ted-drop-hint">
                <Image size={32} />
                <span>Drag &amp; drop an image here as background</span>
                <span style={{ fontSize: "11px" }}>or use the Background panel on the left</span>
              </div>
            )}

            {/* Elements */}
            {[...design.elems].sort((a, b) => a.z - b.z).map(elem => (
              <DesignElemComp
                key={elem.id}
                elem={elem}
                selected={selectedId === elem.id}
                editing={editingId === elem.id}
                containerH={containerH}
                canvasAspect={ar}
                onSelect={() => { setSelectedId(elem.id); setEditingId(null); }}
                onDragStart={(e) => startDrag(e, elem)}
                onResizeStart={(e, handle) => startResize(e, elem, handle)}
                onRotateStart={(e) => startRotate(e, elem)}
                onDoubleClick={() => { if (elem.type === "text") { setSelectedId(elem.id); setEditingId(elem.id); } }}
                onTextChange={(text) => updateElemDirect(elem.id, { text })}
                onTextBlur={() => {
                  setEditingId(null);
                  if (preDragRef.current) {
                    historyRef.current.push(preDragRef.current);
                    futureRef.current = [];
                    setCanUndo(true);
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Right properties panel ── */}
      <div className="ted-right">
        {selected ? (
          <PropertiesPanel
            elem={selected}
            onUpdate={(ch) => updateElemWithHistory(selected.id, ch)}
            onDelete={() => deleteElem(selected.id)}
            onDuplicate={() => duplicateElem(selected.id)}
            onZUp={() => moveZ(selected.id, 1)}
            onZDown={() => moveZ(selected.id, -1)}
          />
        ) : (
          <div className="ted-no-sel">
            <p>Select an element on the canvas to edit its properties.</p>
            <p>Double-click a text element to edit its content.</p>
          </div>
        )}
      </div>

    </div>
  );
}

// ── DesignElemComp ─────────────────────────────────────────────────────────────

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type ElemProps = {
  elem: DesignElem;
  selected: boolean;
  editing: boolean;
  containerH: number;
  canvasAspect: AR;
  onSelect: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent, handle: string) => void;
  onRotateStart: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onTextChange: (text: string) => void;
  onTextBlur: () => void;
};

function DesignElemComp({
  elem, selected, editing, containerH,
  onSelect, onDragStart, onResizeStart, onRotateStart,
  onDoubleClick, onTextChange, onTextBlur,
}: ElemProps) {
  const cssFontSize = ((elem.fontSize ?? 5) / 100) * containerH;

  const textStyle: React.CSSProperties = {
    fontFamily: elem.fontFamily ?? "Inter",
    fontSize: `${cssFontSize}px`,
    fontWeight: elem.bold ? "bold" : "normal",
    fontStyle: elem.italic ? "italic" : "normal",
    color: elem.color ?? "#ffffff",
    textAlign: elem.align ?? "left",
    lineHeight: 1.25,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  return (
    <div
      className={`ted-elem${selected ? " selected" : ""}`}
      style={{
        left: `${elem.x}%`, top: `${elem.y}%`,
        width: `${elem.w}%`, height: `${elem.h}%`,
        transform: `rotate(${elem.rot}deg)`,
        zIndex: elem.z + 1,
        cursor: selected ? "move" : "pointer",
      }}
      onPointerDown={e => {
        e.stopPropagation();
        onSelect();
        if (selected) onDragStart(e);
      }}
      onDoubleClick={e => { e.stopPropagation(); onDoubleClick(); }}
    >
      {elem.type === "image" && (
        <img
          src={elem.src} alt=""
          style={{ width: "100%", height: "100%", objectFit: "fill", display: "block", opacity: elem.imgOpacity ?? 1 }}
          draggable={false}
        />
      )}
      {elem.type === "text" && (
        editing ? (
          <textarea
            autoFocus
            className="ted-text-input"
            value={elem.text ?? ""}
            onChange={e => onTextChange(e.target.value)}
            onBlur={onTextBlur}
            onPointerDown={e => e.stopPropagation()}
            style={{ ...textStyle, background: "transparent", border: "none", outline: "none", resize: "none", width: "100%", height: "100%", padding: 0 }}
          />
        ) : (
          <div style={{ ...textStyle, width: "100%", height: "100%", overflow: "hidden" }}>
            {elem.text || "Add text"}
          </div>
        )
      )}

      {selected && !editing && (
        <>
          <div
            className="ted-rotate-handle"
            onPointerDown={e => { e.stopPropagation(); onRotateStart(e); }}
          >
            <RotateCw size={10} />
          </div>
          {HANDLES.map(h => (
            <div key={h} className={`ted-handle ${h}`}
              onPointerDown={e => { e.stopPropagation(); onResizeStart(e, h); }} />
          ))}
        </>
      )}
    </div>
  );
}

// ── PropertiesPanel ────────────────────────────────────────────────────────────

type PropsPanelProps = {
  elem: DesignElem;
  onUpdate: (ch: Partial<DesignElem>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onZUp: () => void;
  onZDown: () => void;
};

function PropertiesPanel({ elem, onUpdate, onDelete, onDuplicate, onZUp, onZDown }: PropsPanelProps) {
  const num = (v: number, field: keyof DesignElem, min = 0, max = 100) => (
    <input type="number" className="ted-num" value={Math.round(v * 10) / 10}
      min={min} max={max}
      onChange={e => onUpdate({ [field]: Number(e.target.value) })} />
  );

  return (
    <div className="ted-props">
      <div className="ted-props-section">
        <div className="ted-panel-label">Position &amp; Size</div>
        <div className="ted-props-grid">
          <label>X %{num(elem.x, "x")}</label>
          <label>Y %{num(elem.y, "y")}</label>
          <label>W %{num(elem.w, "w", 1, 100)}</label>
          <label>H %{num(elem.h, "h", 1, 100)}</label>
        </div>
        <label style={{ display: "grid", gap: "4px", marginTop: "8px", fontSize: "11px" }}>
          Rotation (°)
          <input type="range" min="-180" max="180" value={Math.round(elem.rot)}
            onChange={e => onUpdate({ rot: Number(e.target.value) })} />
          <span style={{ color: "var(--muted)" }}>{Math.round(elem.rot)}°</span>
        </label>
      </div>

      {elem.type === "text" && (
        <>
          <div className="ted-props-section">
            <div className="ted-panel-label">Font</div>
            <select className="tsel" value={elem.fontFamily ?? "Inter"}
              onChange={e => onUpdate({ fontFamily: e.target.value })}>
              {FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
            </select>
            <div style={{ display: "flex", gap: "6px", marginTop: "8px", alignItems: "center" }}>
              <label style={{ fontSize: "11px", flex: 1 }}>
                Size %
                <input type="number" className="ted-num" min={1} max={50} value={elem.fontSize ?? 5}
                  onChange={e => onUpdate({ fontSize: Number(e.target.value) })} style={{ width: "100%" }} />
              </label>
              <button className={elem.bold ? "tfmtbtn active" : "tfmtbtn"} style={{ fontWeight: "bold", marginTop: "14px" }}
                onClick={() => onUpdate({ bold: !elem.bold })}>B</button>
              <button className={elem.italic ? "tfmtbtn active" : "tfmtbtn"} style={{ fontStyle: "italic", marginTop: "14px" }}
                onClick={() => onUpdate({ italic: !elem.italic })}>I</button>
            </div>
          </div>
          <div className="ted-props-section">
            <div className="ted-panel-label">Color &amp; Alignment</div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input type="color" value={elem.color ?? "#ffffff"}
                onChange={e => onUpdate({ color: e.target.value })}
                className="ted-color-input" style={{ width: "36px", height: "28px" }} />
              <div style={{ display: "flex", gap: "4px" }}>
                {(["left", "center", "right"] as TA[]).map(a => (
                  <button key={a} className={elem.align === a ? "tfmtbtn active" : "tfmtbtn"}
                    onClick={() => onUpdate({ align: a })}>
                    {a === "left" ? "L" : a === "center" ? "C" : "R"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {elem.type === "image" && (
        <div className="ted-props-section">
          <div className="ted-panel-label">Opacity</div>
          <input type="range" min="0" max="100" value={Math.round((elem.imgOpacity ?? 1) * 100)}
            onChange={e => onUpdate({ imgOpacity: Number(e.target.value) / 100 })} />
          <span style={{ fontSize: "11px", color: "var(--muted)" }}>{Math.round((elem.imgOpacity ?? 1) * 100)}%</span>
        </div>
      )}

      <div className="ted-props-section">
        <div className="ted-panel-label">Layer order</div>
        <div style={{ display: "flex", gap: "6px" }}>
          <button className="secondary" style={{ flex: 1, padding: "6px" }} onClick={onZUp}>↑ Forward</button>
          <button className="secondary" style={{ flex: 1, padding: "6px" }} onClick={onZDown}>↓ Backward</button>
        </div>
      </div>
      <div className="ted-props-section" style={{ display: "flex", gap: "6px" }}>
        <button className="secondary" style={{ flex: 1 }} onClick={onDuplicate}><Copy size={12} />Duplicate</button>
        <button className="secondary" style={{ flex: 1, color: "#bd5147" }} onClick={onDelete}><Trash2 size={12} />Delete</button>
      </div>
    </div>
  );
}
