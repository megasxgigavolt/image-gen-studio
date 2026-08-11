/** Whether a scene's stills are entirely selected, entirely unselected, or a
 * mix — drives the tri-state (checked/unchecked/indeterminate) scene
 * checkbox in the Bulk Generation panel. An empty `groupIds` (a scene with
 * no stills, which shouldn't normally happen) reads as "none". */
export function sceneSelectionState(
  groupIds: string[],
  selected: ReadonlySet<string>,
): "all" | "some" | "none" {
  if (groupIds.length === 0) return "none";
  const selectedCount = groupIds.reduce((count, id) => count + (selected.has(id) ? 1 : 0), 0);
  if (selectedCount === 0) return "none";
  if (selectedCount === groupIds.length) return "all";
  return "some";
}

/** Toggles an entire scene's selection in one action: if any stills in the
 * scene are currently selected ("all" or "some"), checking the scene's box
 * again clears all of them; if none are selected, checking it selects all
 * of them. Matches a standard tri-state checkbox's click behavior — the
 * "indeterminate" state clicks through to "none" first, then "all". */
export function toggleScene(groupIds: string[], selected: ReadonlySet<string>): Set<string> {
  const state = sceneSelectionState(groupIds, selected);
  const next = new Set(selected);
  if (state === "none") {
    for (const id of groupIds) next.add(id);
  } else {
    for (const id of groupIds) next.delete(id);
  }
  return next;
}
