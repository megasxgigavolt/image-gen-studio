import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export type ContextMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/** A small right-click menu positioned at a fixed point (the click
 * coordinates), closing on outside-click or Escape. Used for Library cards,
 * Stills clips, and Caption blocks. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="tl-context-menu" style={{ left: x, top: y }}>
      {items.map((item) => (
        <button
          key={item.label}
          className={item.danger ? "danger-action" : ""}
          disabled={item.disabled}
          onClick={() => { item.onSelect(); onClose(); }}
        >
          {item.icon}{item.label}
        </button>
      ))}
    </div>
  );
}
