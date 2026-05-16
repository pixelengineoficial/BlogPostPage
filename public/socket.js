/* ============================================================
   NEXUS BLOG — socket.js
   Socket.IO client para atualizações em tempo real
   ============================================================ */

'use strict';

(function () {
  // Espera o Socket.IO carregar
  function connectSocket() {
    if (typeof io === 'undefined') {
      setTimeout(connectSocket, 200);
      return;
    }

    const socket = io({ transports: ['websocket', 'polling'] });

    window.NexusSocket = socket;

    socket.on('connect', () => {
      console.log('[socket] conectado:', socket.id);
    });

    socket.on('disconnect', () => {
      console.log('[socket] desconectado');
    });

    // Atualiza contagem online no sidebar
    socket.on('online_count', (data) => {
      const els = document.querySelectorAll('[data-online-count]');
      els.forEach(el => { el.textContent = data.count || 0; });
      // sidebar específico
      const sidebarOnline = document.getElementById('sidebar-online');
      if (sidebarOnline) sidebarOnline.textContent = data.count || 0;
    });

    // Novo post — home page exibe notificação
    socket.on('new_post', (post) => {
      // Dispara evento customizado para páginas escutarem
      window.dispatchEvent(new CustomEvent('nexus:new_post', { detail: post }));
    });

    // Novo comentário — post detail atualiza em tempo real
    socket.on('new_comment', (data) => {
      window.dispatchEvent(new CustomEvent('nexus:new_comment', { detail: data }));
    });
  }

  connectSocket();
})();
