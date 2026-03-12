/* n8n AI Widget — injected via EXTERNAL_FRONTEND_HOOKS_URLS */
(function () {
  'use strict';

  var CHAT_URL = 'http://localhost:3000/chat';
  var BUTTON_SIZE = '56px';
  var PANEL_WIDTH = '380px';
  var PANEL_HEIGHT = '520px';

  // Avoid double-mounting
  if (document.getElementById('n8n-ai-widget-btn')) return;

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = [
    '#n8n-ai-widget-btn {',
    '  position: fixed;',
    '  bottom: 24px;',
    '  right: 24px;',
    '  width: ' + BUTTON_SIZE + ';',
    '  height: ' + BUTTON_SIZE + ';',
    '  border-radius: 50%;',
    '  background: #ff6d5a;',
    '  box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
    '  cursor: pointer;',
    '  z-index: 99999;',
    '  border: none;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  transition: transform 0.2s ease, box-shadow 0.2s ease;',
    '}',
    '#n8n-ai-widget-btn:hover {',
    '  transform: scale(1.08);',
    '  box-shadow: 0 6px 20px rgba(0,0,0,0.32);',
    '}',
    '#n8n-ai-widget-btn svg { pointer-events: none; }',
    '#n8n-ai-widget-panel {',
    '  position: fixed;',
    '  bottom: calc(24px + ' + BUTTON_SIZE + ' + 12px);',
    '  right: 24px;',
    '  width: ' + PANEL_WIDTH + ';',
    '  height: ' + PANEL_HEIGHT + ';',
    '  border-radius: 16px;',
    '  overflow: hidden;',
    '  box-shadow: 0 8px 32px rgba(0,0,0,0.22);',
    '  z-index: 99998;',
    '  border: none;',
    '  transform-origin: bottom right;',
    '  transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.18s ease;',
    '}',
    '#n8n-ai-widget-panel.hidden {',
    '  transform: scale(0.85);',
    '  opacity: 0;',
    '  pointer-events: none;',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // -------------------------------------------------------------------------
  // Button
  // -------------------------------------------------------------------------
  var btn = document.createElement('button');
  btn.id = 'n8n-ai-widget-btn';
  btn.title = 'AI Workflow Generator';
  btn.innerHTML = [
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">',
    '  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="white" opacity="0.9"/>',
    '  <path d="M8 10h8M8 14h5" stroke="#ff6d5a" stroke-width="2" stroke-linecap="round"/>',
    '</svg>',
  ].join('');

  // -------------------------------------------------------------------------
  // Panel (iframe)
  // -------------------------------------------------------------------------
  var panel = document.createElement('iframe');
  panel.id = 'n8n-ai-widget-panel';
  panel.src = CHAT_URL;
  panel.classList.add('hidden');

  // -------------------------------------------------------------------------
  // Toggle logic
  // -------------------------------------------------------------------------
  var isOpen = false;

  btn.addEventListener('click', function () {
    isOpen = !isOpen;
    if (isOpen) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  });

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------
  document.body.appendChild(panel);
  document.body.appendChild(btn);
})();
