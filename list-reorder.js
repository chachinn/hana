/* =====================================================
   HANA 🌸 Version 1 · touch-friendly list item reordering
   Persist only item order. Never alter item data, lanes or completion.
   ===================================================== */
(() => {
  "use strict";
  const FEATURE_KEY = "hana-v1-2026-11-03-list-reorder";
  const SEEN_KEY = "lastSeenListReorderKey";
  let drag = null;

  // Keep the original list renderer and all checkbox/edit/swipe actions.
  if (typeof listItemHTML === "function") {
    const originalListItemHTML = listItemHTML;
    listItemHTML = function (list, item, options) {
      const html = originalListItemHTML.apply(this, arguments);
      const label = escapeHTML(String(item.title || "item"));
      const handle = '<button type="button" class="list-drag-handle" data-list-drag-handle="' +
        escapeHTML(String(item.id)) + '" data-list-id="' + escapeHTML(String(list.id)) +
        '" aria-label="Move ' + label + ' up or down" title="Drag to rearrange · Arrow keys also work">⠿</button>';
      return html.replace('<button class="mini-icon-button" data-edit-list-item=', handle +
        '<button class="mini-icon-button" data-edit-list-item=');
    };
  }

  function groupRows(group) {
    return [...(group?.children || [])].filter(node => node.matches?.(".list-swipe-shell[data-list-id]"));
  }

  function boardPosition(listId) {
    const board = window.HanaListScrollMemory?.boardForList?.(listId);
    return board ? { left: board.scrollLeft, active: board.scrollWidth > board.clientWidth + 1 } : null;
  }

  function restoreAfterRender(listId, board, scrollTop) {
    const page = document.scrollingElement;
    if (page) page.scrollTop = scrollTop;
    if (board?.active) window.HanaListScrollMemory?.restore?.(listId, board.left);
    requestAnimationFrame(() => { if (page) page.scrollTop = scrollTop; });
  }

  function moveItem(listId, itemId, targetId, before) {
    const list = state.lists.find(entry => entry.id === listId);
    const from = list?.items.findIndex(item => item.id === itemId) ?? -1;
    const to = list?.items.findIndex(item => item.id === targetId) ?? -1;
    if (!list || from < 0 || to < 0 || from === to) return false;
    const source = list.items[from], target = list.items[to];
    if (source.completed !== target.completed) return false;
    if (list.columnMode && !source.completed &&
        listEffectiveLane(list, source.lane) !== listEffectiveLane(list, target.lane)) return false;
    if (categorizedPackingList(list) && String(source.detail || "") !== String(target.detail || "")) return false;

    const next = list.items.slice();
    next.splice(from, 1);
    const insertAt = next.findIndex(item => item.id === targetId) + (before ? 0 : 1);
    next.splice(insertAt, 0, source);
    if (next.every((item, index) => item === list.items[index])) return false;

    const board = boardPosition(listId);
    const scrollTop = document.scrollingElement?.scrollTop || 0;
    list.items = next;
    list.updatedAt = Date.now();
    render(); // Includes normal local persistence and partner sync.
    restoreAfterRender(listId, board, scrollTop);
    return true;
  }

  function pickDestination(x, y) {
    if (!drag) return null;
    const bounds = drag.group.getBoundingClientRect();
    if (x < bounds.left - 18 || x > bounds.right + 18) return null;
    const rows = groupRows(drag.group).filter(row => row !== drag.shell);
    if (!rows.length) return null;
    let winner = null, distance = Infinity;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const center = (rect.top + rect.bottom) / 2;
      const diff = Math.abs(y - center);
      if (diff < distance) { winner = row; distance = diff; }
    }
    if (!winner) return null;
    const rect = winner.getBoundingClientRect();
    return { row: winner, targetId: winner.dataset.listSwipeShell,
      before: y < (rect.top + rect.bottom) / 2 };
  }

  function updateDestination() {
    if (!drag) return;
    const previous = drag.destination;
    if (previous) previous.row.classList.remove("list-reorder-before", "list-reorder-after");
    drag.destination = pickDestination(drag.x, drag.y);
    const next = drag.destination;
    if (next) next.row.classList.add(next.before ? "list-reorder-before" : "list-reorder-after");
  }

  function scrollContainer(group) {
    let parent = group.parentElement;
    while (parent && parent !== document.body) {
      const overflow = getComputedStyle(parent).overflowY;
      if (/(auto|scroll)/.test(overflow) && parent.scrollHeight > parent.clientHeight + 4) return parent;
      parent = parent.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollSpeed() {
    if (!drag || !drag.started) return 0;
    const host = drag.scrollHost;
    const root = host === document.scrollingElement || host === document.documentElement;
    const rect = root ? { top: 0, bottom: innerHeight } : host.getBoundingClientRect();
    const insetTop = root ? 95 : 0, insetBottom = root ? 92 : 0;
    const top = rect.top + insetTop, bottom = rect.bottom - insetBottom;
    const edge = 58;
    if (drag.y < top + edge) return -Math.min(13, Math.max(0, (top + edge - drag.y) / 5));
    if (drag.y > bottom - edge) return Math.min(13, Math.max(0, (drag.y - (bottom - edge)) / 5));
    return 0;
  }

  function updateDraggedPosition() {
    if (!drag?.started) return;
    const scrollChange = drag.scrollHost.scrollTop - drag.initialScrollTop;
    drag.shell.style.transform = "translate3d(0," + (drag.y - drag.startY + scrollChange) + "px,0)";
    updateDestination();
  }

  function autoScrollTick() {
    if (!drag) return;
    drag.frame = 0;
    const speed = scrollSpeed();
    if (!speed) return;
    const host = drag.scrollHost;
    const old = host.scrollTop;
    host.scrollTop += speed;
    if (host.scrollTop !== old) {
      updateDraggedPosition();
      drag.frame = requestAnimationFrame(autoScrollTick);
    }
  }

  function onPointerDown(event) {
    const handle = event.target.closest?.("[data-list-drag-handle]");
    if (!handle || drag || (event.pointerType === "mouse" && event.button !== 0)) return;
    const shell = handle.closest(".list-swipe-shell");
    const group = shell?.parentElement;
    if (!shell || !group || groupRows(group).length < 2) return;
    if (typeof closeListSwipeActions === "function") closeListSwipeActions();
    event.preventDefault();
    const host = scrollContainer(group);
    drag = { handle, shell, group, scrollHost: host, initialScrollTop: host.scrollTop,
      pointerId: event.pointerId, listId: handle.dataset.listId,
      itemId: handle.dataset.listDragHandle, startY: event.clientY,
      x: event.clientX, y: event.clientY, started: false, destination: null, frame: 0 };
    try { handle.setPointerCapture(event.pointerId); } catch (_) { /* mouse/test fallback */ }
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.started) {
      if (Math.abs(drag.y - drag.startY) < 5) return;
      drag.started = true;
      drag.shell.classList.add("list-reorder-active");
      document.body.classList.add("list-reordering");
    }
    updateDraggedPosition();
    if (!drag.frame && scrollSpeed()) drag.frame = requestAnimationFrame(autoScrollTick);
  }

  function stopDrag(cancelled) {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (current.frame) cancelAnimationFrame(current.frame);
    if (current.destination) current.destination.row.classList.remove("list-reorder-before", "list-reorder-after");
    current.shell.classList.remove("list-reorder-active");
    current.shell.style.transform = "";
    document.body.classList.remove("list-reordering");
    try { if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId); } catch (_) {}
    if (!cancelled && current.started && current.destination) {
      const { targetId, before } = current.destination;
      moveItem(current.listId, current.itemId, targetId, before);
    }
  }

  function onPointerUp(event) {
    if (drag && event.pointerId === drag.pointerId) stopDrag(false);
  }
  function onPointerCancel(event) {
    if (drag && event.pointerId === drag.pointerId) stopDrag(true);
  }

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("blur", () => stopDrag(true));
  // The existing swipe handler listens to touchstart on document. The grip
  // must not enter that handler or turn a vertical drag into swipe-to-edit.
  document.addEventListener("touchstart", event => {
    if (event.target.closest?.("[data-list-drag-handle]")) event.stopPropagation();
  }, { capture: true, passive: true });
  document.addEventListener("click", event => {
    if (!event.target.closest?.("[data-list-drag-handle]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("keydown", event => {
    const handle = event.target.closest?.("[data-list-drag-handle]");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const shell = handle.closest(".list-swipe-shell");
    const rows = groupRows(shell?.parentElement);
    const index = rows.indexOf(shell);
    const adjacent = rows[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (!adjacent) return;
    if (moveItem(handle.dataset.listId, handle.dataset.listDragHandle,
      adjacent.dataset.listSwipeShell, event.key === "ArrowUp")) {
      const nextHandle = [...document.querySelectorAll("[data-list-drag-handle]")].find(node =>
        node.dataset.listId === handle.dataset.listId &&
        node.dataset.listDragHandle === handle.dataset.listDragHandle);
      nextHandle?.focus({ preventScroll: true });
    }
  });

  if (typeof HANA_RELEASE_NOTES === "object" && Array.isArray(HANA_RELEASE_NOTES.items)) {
    const title = "Arrange your lists by dragging";
    if (!HANA_RELEASE_NOTES.items.some(item => item.title === title)) {
      HANA_RELEASE_NOTES.items.unshift({
        icon: "☑️", title,
        text: "Use the new ⠿ handle to drag checklist items up or down. Your custom order stays saved, including inside columns, Completed and packing categories."
      });
    }
  }

  if (typeof finishTutorial === "function") {
    const originalFinish = finishTutorial;
    finishTutorial = function () {
      state.settings[SEEN_KEY] = FEATURE_KEY;
      return originalFinish.apply(this, arguments);
    };
  }
  if (typeof openWhatsNew === "function") {
    const originalOpen = openWhatsNew;
    openWhatsNew = function (options = {}) {
      const result = originalOpen.call(this, options);
      if (options.markSeen !== false && state?.settings?.[SEEN_KEY] !== FEATURE_KEY) {
        state.settings[SEEN_KEY] = FEATURE_KEY;
        saveState({ snapshot: false });
      }
      return result;
    };
  }
  setTimeout(() => {
    if (state?.settings?.tutorialCompleted !== true || state.settings[SEEN_KEY] === FEATURE_KEY) return;
    const modal = document.getElementById("whatsNewModal");
    if (modal && !modal.classList.contains("hidden")) {
      state.settings[SEEN_KEY] = FEATURE_KEY;
      saveState({ snapshot: false });
    } else openWhatsNew();
  }, 1100);

  window.HanaListReorder = { featureKey: FEATURE_KEY, moveItem };
})();