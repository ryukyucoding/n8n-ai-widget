/* n8n AI Widget — injected via EXTERNAL_FRONTEND_HOOKS_URLS */
(function () {
  'use strict';

  var CHAT_URL = 'http://localhost:3001/chat';

  function mount() {
    var BTN    = 56;
    var MIN_W  = 280;
    var MIN_H  = 320;
    var MARGIN = 24;
    var GAP    = 12;

    if (document.getElementById('n8n-ai-widget-btn')) return;

    // Restore saved state
    var side      = localStorage.getItem('n8n-widget-side') || 'right';
    var btnTopVal = parseInt(localStorage.getItem('n8n-widget-top') || '', 10);
    if (isNaN(btnTopVal)) btnTopVal = window.innerHeight - MARGIN - BTN;
    var panelW = Math.max(MIN_W, parseInt(localStorage.getItem('n8n-widget-w') || '', 10) || 380);
    var panelH = Math.max(MIN_H, parseInt(localStorage.getItem('n8n-widget-h') || '', 10) || 520);

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------
    var style = document.createElement('style');
    style.textContent = [
      '#n8n-ai-widget-backdrop {',
      '  position: fixed; inset: 0;',
      '  z-index: 99996;',
      '  display: none;',
      '}',
      '#n8n-ai-widget-btn {',
      '  position: fixed;',
      '  width: ' + BTN + 'px; height: ' + BTN + 'px;',
      '  border-radius: 50%;',
      '  background: #ff6d5a;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
      '  cursor: grab;',
      '  z-index: 99999;',
      '  border: none;',
      '  display: flex; align-items: center; justify-content: center;',
      '  user-select: none;',
      '}',
      '#n8n-ai-widget-btn:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.32); }',
      '#n8n-ai-widget-btn.dragging { cursor: grabbing !important; box-shadow: 0 8px 28px rgba(0,0,0,0.38); }',
      '#n8n-ai-widget-btn svg { pointer-events: none; }',
      '#n8n-ai-widget-panel {',
      '  position: fixed;',
      '  border-radius: 16px;',
      '  overflow: hidden;',
      '  box-shadow: 0 8px 32px rgba(0,0,0,0.22);',
      '  z-index: 99997;',
      '  border: none;',
      '  transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.18s ease;',
      '}',
      '#n8n-ai-widget-panel.hidden {',
      '  transform: scale(0.85); opacity: 0; pointer-events: none;',
      '}',
      '#n8n-ai-widget-resize {',
      '  position: fixed;',
      '  width: 22px; height: 22px;',
      '  z-index: 100000;',
      '  display: none;',
      '  border-radius: 4px;',
      '}',
      '#n8n-ai-widget-resize::after {',
      '  content: "";',
      '  position: absolute; inset: 3px;',
      '  background-image: radial-gradient(circle, rgba(0,0,0,0.3) 1.5px, transparent 1.5px);',
      '  background-size: 5px 5px;',
      '}',
    ].join('\n');
    document.head.appendChild(style);

    // -------------------------------------------------------------------------
    // DOM elements
    // -------------------------------------------------------------------------
    var backdrop = document.createElement('div');
    backdrop.id  = 'n8n-ai-widget-backdrop';

    var btn = document.createElement('button');
    btn.id    = 'n8n-ai-widget-btn';
    btn.title = 'AI Workflow Generator';
    btn.innerHTML = [
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none">',
      '  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="white" opacity="0.9"/>',
      '  <path d="M8 10h8M8 14h5" stroke="#ff6d5a" stroke-width="2" stroke-linecap="round"/>',
      '</svg>',
    ].join('');

    var panel = document.createElement('iframe');
    panel.id  = 'n8n-ai-widget-panel';
    panel.src = CHAT_URL;
    panel.classList.add('hidden');
    panel.style.width  = panelW + 'px';
    panel.style.height = panelH + 'px';

    var resizeHandle = document.createElement('div');
    resizeHandle.id = 'n8n-ai-widget-resize';

    // -------------------------------------------------------------------------
    // Open / Close
    // -------------------------------------------------------------------------
    var isOpen = false;

    function openPanel() {
      isOpen = true;
      panel.classList.remove('hidden');
      backdrop.style.display      = 'block';
      resizeHandle.style.display  = 'block';
    }

    function closePanel() {
      isOpen = false;
      panel.classList.add('hidden');
      backdrop.style.display      = 'none';
      resizeHandle.style.display  = 'none';
    }

    backdrop.addEventListener('click', closePanel);

    // -------------------------------------------------------------------------
    // Position helpers
    // -------------------------------------------------------------------------
    function clampTop(t) {
      return Math.max(MARGIN, Math.min(window.innerHeight - MARGIN - BTN, t));
    }

    // Returns { panelTop, flipped }
    function calcPanelTop() {
      var top = clampTop(btnTopVal);
      var pt  = top - panelH - GAP;
      var flipped = pt < MARGIN;
      if (flipped) pt = top + BTN + GAP;
      return { top: top, panelTop: pt, flipped: flipped };
    }

    function updateResizeHandle() {
      var c = calcPanelTop();
      // Handle sits at the corner of the panel that is:
      //  - horizontally: opposite side from the button anchor
      //  - vertically:   the "free" edge (top when normal, bottom when flipped)
      var hx, hy, cursor;
      if (side === 'right') {
        hx     = window.innerWidth - MARGIN - panelW - 11; // top-left of panel
        cursor = c.flipped ? 'nesw-resize' : 'nwse-resize';
      } else {
        hx     = MARGIN + panelW - 11;                     // top-right of panel
        cursor = c.flipped ? 'nwse-resize' : 'nesw-resize';
      }
      hy = c.flipped ? (c.panelTop + panelH - 11) : (c.panelTop - 11);

      resizeHandle.style.left   = hx + 'px';
      resizeHandle.style.top    = hy + 'px';
      resizeHandle.style.cursor = cursor;
    }

    function applyPositions(smooth) {
      var c = calcPanelTop();

      btn.style.transition = smooth
        ? 'top 0.15s ease, left 0.15s ease, right 0.15s ease, box-shadow 0.2s ease'
        : 'box-shadow 0.2s ease';

      btn.style.top    = c.top + 'px';
      btn.style.bottom = '';
      panel.style.top  = c.panelTop + 'px';
      panel.style.bottom = '';

      if (side === 'right') {
        btn.style.right   = MARGIN + 'px'; btn.style.left    = '';
        panel.style.right = MARGIN + 'px'; panel.style.left  = '';
        panel.style.transformOrigin = (c.flipped ? 'top' : 'bottom') + ' right';
      } else {
        btn.style.left    = MARGIN + 'px'; btn.style.right   = '';
        panel.style.left  = MARGIN + 'px'; panel.style.right = '';
        panel.style.transformOrigin = (c.flipped ? 'top' : 'bottom') + ' left';
      }

      updateResizeHandle();
    }

    applyPositions(false);

    // -------------------------------------------------------------------------
    // Drag (button repositioning)
    // -------------------------------------------------------------------------
    var dragging     = false;
    var hasMoved     = false;
    var dragStartX   = 0;
    var dragStartY   = 0;
    var btnStartLeft = 0;
    var btnStartTop  = 0;

    btn.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging     = true;
      hasMoved     = false;
      dragStartX   = e.clientX;
      dragStartY   = e.clientY;
      var rect     = btn.getBoundingClientRect();
      btnStartLeft = rect.left;
      btnStartTop  = rect.top;
      btn.style.transition = 'none';
      btn.classList.add('dragging');
    });

    // -------------------------------------------------------------------------
    // Resize (panel corner handle)
    // -------------------------------------------------------------------------
    var resizing  = false;
    var rsStartX  = 0;
    var rsStartY  = 0;
    var rsStartW  = 0;
    var rsStartH  = 0;
    var rsFlipped = false;

    resizeHandle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      resizing  = true;
      rsStartX  = e.clientX;
      rsStartY  = e.clientY;
      rsStartW  = panelW;
      rsStartH  = panelH;
      rsFlipped = calcPanelTop().flipped;
    });

    // -------------------------------------------------------------------------
    // Shared mousemove / mouseup
    // -------------------------------------------------------------------------
    document.addEventListener('mousemove', function (e) {
      var dx, dy;
      if (dragging) {
        dx = e.clientX - dragStartX;
        dy = e.clientY - dragStartY;
        if (!hasMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) hasMoved = true;
        if (!hasMoved) return;
        btn.style.left   = (btnStartLeft + dx) + 'px';
        btn.style.right  = '';
        btn.style.top    = clampTop(btnStartTop + dy) + 'px';
        btn.style.bottom = '';
      }

      if (resizing) {
        dx = e.clientX - rsStartX;
        dy = e.clientY - rsStartY;
        // Width: dragging away from anchor widens the panel
        panelW = Math.max(MIN_W, side === 'right' ? rsStartW - dx : rsStartW + dx);
        // Height: dragging away from the button widens vertically
        panelH = Math.max(MIN_H, rsFlipped ? rsStartH + dy : rsStartH - dy);
        panel.style.width  = panelW + 'px';
        panel.style.height = panelH + 'px';
        applyPositions(false);
      }
    });

    document.addEventListener('mouseup', function (e) {
      if (dragging) {
        dragging = false;
        btn.classList.remove('dragging');

        if (!hasMoved) {
          if (isOpen) { closePanel(); } else { openPanel(); }
          return;
        }

        // Snap to nearest side
        side      = (e.clientX < window.innerWidth / 2) ? 'left' : 'right';
        btnTopVal = clampTop(btnStartTop + (e.clientY - dragStartY));
        localStorage.setItem('n8n-widget-side', side);
        localStorage.setItem('n8n-widget-top',  String(btnTopVal));
        applyPositions(true);
      }

      if (resizing) {
        resizing = false;
        localStorage.setItem('n8n-widget-w', String(panelW));
        localStorage.setItem('n8n-widget-h', String(panelH));
      }
    });

    // -------------------------------------------------------------------------
    // Mount
    // -------------------------------------------------------------------------
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    document.body.appendChild(resizeHandle);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
