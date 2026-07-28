import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CaptionStyle } from "../infrastructure/projects-client";
import { CAPTION_FONT_OPTIONS, CAPTION_STYLE_PRESETS } from "./timeline-rendering";

/** A range slider paired with a synced number input, so an exact value can
 * be typed instead of only dragged. */
function SliderField({
  label, value, min, max, step = 1, suffix, onChange,
}: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="tl-style-field">
      <span>{label}</span>
      <div className="tl-slider-row">
        <input type="range" className="tl-slider" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <input
          type="number"
          className="tl-slider-number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isNaN(next)) onChange(Math.min(max, Math.max(min, next)));
          }}
        />
        {suffix && <span className="tl-slider-suffix">{suffix}</span>}
      </div>
    </label>
  );
}

/** One collapsible section of the caption style editor. Only one section is
 * open at a time (the parent tracks which), so the panel shows one focused
 * group of controls instead of every control at once. `extra` renders an
 * interactive control (an enable checkbox) inline in the header — its own
 * clicks are stopped from also toggling the section open/closed. */
function AccordionSection({
  title, isOpen, onToggle, extra, children,
}: {
  title: string; isOpen: boolean; onToggle: () => void; extra?: ReactNode; children: ReactNode;
}) {
  return (
    <div className={isOpen ? "tl-style-section open" : "tl-style-section"}>
      <button type="button" className="tl-style-section-header" onClick={onToggle}>
        <ChevronDown size={14} className="tl-style-section-chevron" />
        <h4>{title}</h4>
        {extra && <span onClick={(event) => event.stopPropagation()}>{extra}</span>}
      </button>
      {isOpen && <div className="tl-style-section-body">{children}</div>}
    </div>
  );
}

export function CaptionStyleEditor({
  style,
  onChange,
}: {
  style: Required<CaptionStyle>;
  onChange: (patch: Partial<CaptionStyle>) => void;
}) {
  const [openSection, setOpenSection] = useState("font");
  function toggleSection(name: string) {
    setOpenSection((current) => (current === name ? "" : name));
  }

  // A timeline saved before the shadow fields below existed has an
  // old-shaped shadow object (just enabled/blur/offsetX/offsetY) — since
  // resolveCaptionStyle's merge replaces the whole "shadow" key rather than
  // filling in individual missing fields, default them here so the controls
  // never bind to `undefined`. Every onChange below spreads from this fully-
  // defaulted object, so touching any shadow control also backfills the rest.
  const shadow = {
    enabled: style.shadow.enabled ?? false,
    color: style.shadow.color ?? "#000000",
    opacity: style.shadow.opacity ?? 70,
    blur: style.shadow.blur ?? 30,
    distance: style.shadow.distance ?? 2,
    angle: style.shadow.angle ?? 90,
  };
  return (
    <div className="tl-caption-style-editor">
      <div className="tl-preset-grid two">
        {CAPTION_STYLE_PRESETS.map((preset) => (
          <button key={preset.label} className="tl-preset-btn" onClick={() => onChange(preset.style)}>{preset.label}</button>
        ))}
      </div>
      <AccordionSection title="Font" isOpen={openSection === "font"} onToggle={() => toggleSection("font")}>
        <div className="tl-style-row">
          <label className="tl-style-field">
            <span>Font</span>
            <select value={style.fontFamily} onChange={(event) => onChange({ fontFamily: event.target.value })}>
              {CAPTION_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
            </select>
          </label>
          <label className="tl-style-field tl-style-color">
            <span>Color</span>
            <input type="color" value={style.color} onChange={(event) => onChange({ color: event.target.value })} />
          </label>
        </div>
        <div className="tl-style-row">
          <SliderField label="Size" value={style.fontSizePx} min={14} max={48} suffix="px" onChange={(value) => onChange({ fontSizePx: value })} />
          <label className="tl-style-field tl-style-checkbox tl-style-bold">
            <input type="checkbox" checked={style.bold} onChange={(event) => onChange({ bold: event.target.checked })} />
            <span>Bold</span>
          </label>
        </div>
      </AccordionSection>
      <AccordionSection title="Blend" isOpen={openSection === "blend"} onToggle={() => toggleSection("blend")}>
        <SliderField label="Opacity" value={style.opacity} min={0} max={100} suffix="%" onChange={(value) => onChange({ opacity: value })} />
      </AccordionSection>
      <AccordionSection title="Stroke" isOpen={openSection === "stroke"} onToggle={() => toggleSection("stroke")}>
        <div className="tl-style-row">
          <label className="tl-style-field tl-style-color">
            <span>Color</span>
            <input type="color" value={style.outlineColor} onChange={(event) => onChange({ outlineColor: event.target.value })} />
          </label>
          <SliderField label="Thickness" value={style.outlineWidthPx} min={0} max={6} onChange={(value) => onChange({ outlineWidthPx: value })} />
        </div>
      </AccordionSection>
      <AccordionSection
        title="Shadow"
        isOpen={openSection === "shadow"}
        onToggle={() => toggleSection("shadow")}
        extra={<input type="checkbox" checked={shadow.enabled} onChange={(event) => onChange({ shadow: { ...shadow, enabled: event.target.checked } })} />}
      >
        <div className="tl-style-row">
          <label className="tl-style-field tl-style-color">
            <span>Color</span>
            <input type="color" value={shadow.color} onChange={(event) => onChange({ shadow: { ...shadow, color: event.target.value } })} />
          </label>
          <SliderField label="Opacity" value={shadow.opacity} min={0} max={100} suffix="%" onChange={(value) => onChange({ shadow: { ...shadow, opacity: value } })} />
        </div>
        <div className="tl-style-row">
          <SliderField label="Blur" value={shadow.blur} min={0} max={100} suffix="%" onChange={(value) => onChange({ shadow: { ...shadow, blur: value } })} />
          <SliderField label="Distance" value={shadow.distance} min={0} max={20} onChange={(value) => onChange({ shadow: { ...shadow, distance: value } })} />
        </div>
        <SliderField label="Angle" value={shadow.angle} min={0} max={360} suffix="°" onChange={(value) => onChange({ shadow: { ...shadow, angle: value } })} />
      </AccordionSection>
      <AccordionSection title="Position" isOpen={openSection === "position"} onToggle={() => toggleSection("position")}>
        <div className="tl-preset-grid three">
          {(["top", "middle", "bottom"] as const).map((position) => (
            <button
              key={position}
              className={style.position === position ? "tl-preset-btn active" : "tl-preset-btn"}
              onClick={() => onChange({ position })}
            >
              {position}
            </button>
          ))}
        </div>
      </AccordionSection>
      <AccordionSection
        title="Word highlight"
        isOpen={openSection === "highlight"}
        onToggle={() => toggleSection("highlight")}
        extra={
          <input
            type="checkbox"
            checked={style.wordHighlight.enabled}
            onChange={(event) => onChange({ wordHighlight: { ...style.wordHighlight, enabled: event.target.checked } })}
          />
        }
      >
        <label className="tl-style-field tl-style-color">
          <span>Color</span>
          <input
            type="color"
            value={style.wordHighlight.color}
            onChange={(event) => onChange({ wordHighlight: { ...style.wordHighlight, color: event.target.value } })}
          />
        </label>
      </AccordionSection>
      {/* Guarantees real trailing space below the last control when scrolled
          all the way down — the scroll container's own bottom padding isn't
          reliably respected once its content overflows its declared height,
          which otherwise left the last color swatch flush against the
          panel's edge. */}
      <div className="tl-style-bottom-spacer" />
    </div>
  );
}
