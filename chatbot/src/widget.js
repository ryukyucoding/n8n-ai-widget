/* n8n AI Widget — injected via EXTERNAL_FRONTEND_HOOKS_URLS */
(function () {
  'use strict';

  var CHAT_BASE = (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (src && src.indexOf('/widget.js') !== -1) {
        return src.substring(0, src.indexOf('/widget.js'));
      }
    }
    return 'http://localhost:3001';
  })();
  var MSG_TYPE = 'n8n-ai-widget';
  var n8nHookStore = null;

  function chatOrigin() {
    try {
      return new URL(CHAT_BASE).origin;
    } catch (e) {
      return CHAT_BASE.replace(/\/$/, '');
    }
  }

  function captureN8nStore(store) {
    if (store) n8nHookStore = store;
  }

  function getPinia() {
    var el = document.getElementById('app');
    var app = el && el.__vue_app__;
    if (!app) return null;
    var pinia = app.config.globalProperties.$pinia;
    if (pinia) return pinia;
    var provides = app._context && app._context.provides;
    if (!provides) return null;
    for (var key in provides) {
      if (provides[key] && provides[key]._s) return provides[key];
    }
    return null;
  }

  function getPiniaStore(name) {
    var pinia = getPinia();
    if (!pinia || !pinia._s || !pinia._s.has(name)) return null;
    return pinia._s.get(name);
  }

  function getN8nStore() {
    return n8nHookStore || getPiniaStore('webhooks');
  }

  function getVueRouter() {
    var el = document.getElementById('app');
    var app = el && el.__vue_app__;
    return (app && app.config.globalProperties.$router) || null;
  }

  function workflowDocumentStoreId(workflowId) {
    return 'workflowDocuments/' + workflowId + '@latest';
  }

  function ensureExternalHooks() {
    if (!window.n8nExternalHooks) window.n8nExternalHooks = {};

    function registerHook(path, fn) {
      var parts = path.split('.');
      var root = window.n8nExternalHooks;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!root[parts[i]]) root[parts[i]] = {};
        root = root[parts[i]];
      }
      var leaf = parts[parts.length - 1];
      if (!root[leaf]) root[leaf] = [];
      var hooks = root[leaf];
      for (var j = 0; j < hooks.length; j++) {
        if (hooks[j] && hooks[j].__n8nAiWidget) return;
      }
      fn.__n8nAiWidget = true;
      hooks.push(fn);
    }

    registerHook('nodeView.mount', function (store) {
      captureN8nStore(store);
    });
    registerHook('workflow.open', function (store) {
      captureN8nStore(store);
    });
  }

  function resolveDocumentStore(store, workflowId) {
    if (store) {
      var doc = store.workflowDocumentStore;
      if (doc && typeof doc.hydrate === 'function') return doc;
      if (doc && doc.value && typeof doc.value.hydrate === 'function') return doc.value;
    }
    return getPiniaStore(workflowDocumentStoreId(workflowId));
  }

  function readStoreWorkflowId(store) {
    if (!store) return '';
    var openId = store.workflowId;
    if (typeof openId === 'object' && openId && openId.value !== undefined) openId = openId.value;
    if (!openId && store.workflow) {
      openId = store.workflow.id;
      if (typeof openId === 'object' && openId && openId.value !== undefined) openId = openId.value;
    }
    return openId ? String(openId) : '';
  }

  function restContextFromStore(store) {
    var ctx = store && store.restApiContext;
    if (ctx && ctx.baseUrl) return ctx;
    var baseUrl = store && (store.restUrl || store.baseUrl);
    if (typeof baseUrl === 'object' && baseUrl && baseUrl.value) baseUrl = baseUrl.value;
    var pushRef = store && store.pushRef;
    if (typeof pushRef === 'object' && pushRef && pushRef.value) pushRef = pushRef.value;
    if (baseUrl) return { baseUrl: baseUrl, pushRef: pushRef || '' };
    return { baseUrl: window.location.origin + '/rest', pushRef: pushRef || '' };
  }

  function fetchWorkflowFromSession(store, workflowId) {
    var ctx = restContextFromStore(store);
    var url = String(ctx.baseUrl).replace(/\/$/, '') + '/workflows/' + encodeURIComponent(workflowId);
    var headers = { Accept: 'application/json' };
    if (ctx.pushRef) headers['push-ref'] = ctx.pushRef;
    return fetch(url, { credentials: 'include', headers: headers }).then(function (r) {
      if (!r.ok) throw new Error('GET /rest/workflows/' + workflowId + ' ' + r.status);
      return r.json();
    }).then(function (body) {
      return body && body.data !== undefined ? body.data : body;
    });
  }

  function loadWorkflowForRefresh(store, workflowId) {
    var listStore = getPiniaStore('workflowsList');
    if (listStore && typeof listStore.fetchWorkflow === 'function') {
      return Promise.resolve(listStore.fetchWorkflow(String(workflowId)));
    }
    return fetchWorkflowFromSession(store, workflowId);
  }

  function applyHydrateRefresh(store, wf) {
    var listStore = getPiniaStore('workflowsList');
    if (listStore && typeof listStore.addWorkflow === 'function') listStore.addWorkflow(wf);
    if (store && typeof store.setWorkflowId === 'function') store.setWorkflowId(wf.id);

    var docStore = resolveDocumentStore(store, wf.id);
    if (!docStore || typeof docStore.hydrate !== 'function') {
      throw new Error('workflowDocumentStore unavailable');
    }
    docStore.hydrate(wf);
    if (store && typeof store.markStateClean === 'function') store.markStateClean();
  }

  function routerSoftReloadWorkflow(workflowId) {
    // Do not route through /home/workflows: it visibly throws the user out of
    // the canvas whenever Pinia hydration is unavailable. A direct reload of
    // the workflow URL keeps the user in the same workflow and rebuilds n8n's
    // document stores from the saved version.
    var target = '/workflow/' + encodeURIComponent(String(workflowId));
    try {
      window.location.assign(target);
      return Promise.resolve({ ok: true, method: 'page_reload' });
    } catch (err) {
      console.error('[n8n-ai-widget] Workflow reload failed:', err);
      return Promise.resolve({
        ok: false,
        reason: 'reload_error',
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  function refreshN8nCanvas(payload) {
    var workflowId = payload && (payload.workflowId || payload.id);
    if (!workflowId) {
      return Promise.resolve({ ok: false, reason: 'no_id' });
    }

    var store = getN8nStore();
    var openId = readStoreWorkflowId(store);
    if (openId && openId !== String(workflowId)) {
      return routerSoftReloadWorkflow(workflowId);
    }

    return loadWorkflowForRefresh(store, workflowId).then(function (wf) {
      if (!wf || !Array.isArray(wf.nodes)) {
        throw new Error('Invalid workflow payload');
      }
      if (!wf.id) wf.id = workflowId;
      try {
        applyHydrateRefresh(store, wf);
        return { ok: true, method: 'hydrate' };
      } catch (hydrateErr) {
        console.warn('[n8n-ai-widget] hydrate refresh failed, trying router fallback:', hydrateErr);
        return routerSoftReloadWorkflow(workflowId);
      }
    }).catch(function (err) {
      console.warn('[n8n-ai-widget] fetch refresh failed, trying router fallback:', err);
      return routerSoftReloadWorkflow(workflowId).then(function (routerResult) {
        if (routerResult.ok) return routerResult;
        return {
          ok: false,
          reason: 'error',
          error: err && err.message ? err.message : String(err),
        };
      });
    });
  }

  function notifyChatIframe(payload) {
    var iframe = document.getElementById('n8n-ai-widget-panel');
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(payload, chatOrigin());
    } catch (e) {
      /* ignore */
    }
  }

  function onWidgetMessage(event) {
    if (!event || !event.data || typeof event.data !== 'object') return;
    if (event.data.type !== MSG_TYPE) return;
    if (event.origin !== chatOrigin()) return;
    if (event.data.action === 'refreshCanvas') {
      refreshN8nCanvas(event.data.payload || {}).then(function (result) {
        notifyChatIframe({
          type: MSG_TYPE,
          action: 'refreshCanvasResult',
          requestId: event.data.requestId,
          ok: !!result.ok,
          reason: result.reason,
          method: result.method,
        });
      });
    }
  }

  ensureExternalHooks();
  window.addEventListener('message', onWidgetMessage);

  function workflowIdFromN8nPath() {
    var m = window.location.pathname.match(/\/workflow\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function chatIframeUrl() {
    var id = workflowIdFromN8nPath();
    return id
      ? CHAT_BASE + '/chat?workflowId=' + encodeURIComponent(id)
      : CHAT_BASE + '/chat';
  }

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
    var savedPanelW = panelW;
    var savedPanelH = panelH;
    var planReviewExpanded = false;

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
    panel.src = chatIframeUrl();
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
      panel.src = chatIframeUrl();
      isOpen = true;
      panel.classList.remove('hidden');
      backdrop.style.display      = 'block';
      resizeHandle.style.display  = 'block';
      // Keep FAB below iframe (99997) so it cannot cover the chat send button (FAB was 99999).
      btn.style.zIndex = '99990';
    }

    function closePanel() {
      isOpen = false;
      panel.classList.add('hidden');
      backdrop.style.display      = 'none';
      resizeHandle.style.display  = 'none';
      btn.style.zIndex = '';
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

    function setPanelDimensions(width, height) {
      panelW = Math.max(MIN_W, Math.min(width, window.innerWidth - (MARGIN * 2)));
      panelH = Math.max(MIN_H, Math.min(height, window.innerHeight - (MARGIN * 2) - BTN - GAP));
      panel.style.width = panelW + 'px';
      panel.style.height = panelH + 'px';
      applyPositions(false);
    }

    window.addEventListener('message', function (event) {
      if (!event || !event.data || typeof event.data !== 'object') return;
      if (event.data.type !== MSG_TYPE || event.data.action !== 'panelPresentation') return;
      if (event.origin !== chatOrigin() || event.source !== panel.contentWindow) return;

      if (event.data.presentation === 'plan-review') {
        if (!planReviewExpanded) {
          savedPanelW = panelW;
          savedPanelH = panelH;
        }
        planReviewExpanded = true;
        setPanelDimensions(560, 720);
      } else if (event.data.presentation === 'default' && planReviewExpanded) {
        planReviewExpanded = false;
        setPanelDimensions(savedPanelW, savedPanelH);
      }
    });

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
        planReviewExpanded = false;
        savedPanelW = panelW;
        savedPanelH = panelH;
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
