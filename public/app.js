/* ============================================================
   NEXUS BLOG — app.js
   Utilities compartilhados entre todas as páginas
   ============================================================ */

'use strict';

// ── Auth ─────────────────────────────────────────────────────
const Auth = {
  token()  { return localStorage.getItem('nexus_token'); },
  user()   { const u = localStorage.getItem('nexus_user'); try { return u ? JSON.parse(u) : null; } catch { return null; } },
  isLogged()  { return !!this.token() && !!this.user(); },
  isAdmin()   { const u = this.user(); return u && (u.role === 'ADMIN' || u.role === 'OWNER'); },
  isOwner()   { const u = this.user(); return u && u.role === 'OWNER'; },
  logout() { localStorage.removeItem('nexus_token'); localStorage.removeItem('nexus_user'); window.location.href = '/'; },
  headers() { return this.token() ? { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token()}` } : { 'Content-Type': 'application/json' }; },
  requireLogin() {
    if (!this.isLogged()) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.href);
      return false;
    }
    return true;
  },
  requireAdmin() {
    if (!this.isLogged()) { window.location.href = '/login.html'; return false; }
    if (!this.isAdmin()) { window.location.href = '/'; return false; }
    return true;
  }
};

// ── API ──────────────────────────────────────────────────────
const api = {
  async req(method, url, body) {
    const opts = { method, headers: Auth.headers() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  get(url)         { return this.req('GET',    url); },
  post(url, body)  { return this.req('POST',   url, body); },
  patch(url, body) { return this.req('PATCH',  url, body); },
  del(url)         { return this.req('DELETE', url); }
};

// ── Toast ────────────────────────────────────────────────────
const Toast = {
  show(msg, type = 'info', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'toastOut .3s ease-in forwards';
      setTimeout(() => t.remove(), 300);
    }, duration);
  },
  success(m) { this.show(m, 'success'); },
  error(m)   { this.show(m, 'error'); },
  info(m)    { this.show(m, 'info'); }
};

// ── Format ───────────────────────────────────────────────────
function formatRelative(date) {
  const d = new Date(date);
  const now = Date.now();
  const diff = now - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min atrás`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h atrás`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d atrás`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function avatarInitials(name) {
  if (!name) return '?';
  const parts = name.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function avatarEl(user, size = '') {
  const d = document.createElement('div');
  d.className = `avatar ${size}`;
  d.textContent = avatarInitials(user?.username || '?');
  // derive consistent color from username
  if (user?.username) {
    const hues = [280, 220, 160, 340, 40, 180, 60];
    const h = hues[user.username.charCodeAt(0) % hues.length];
    d.style.background = `linear-gradient(135deg, hsl(${h},60%,30%), hsl(${h+40},60%,45%))`;
  }
  return d;
}

function roleColor(role) {
  if (role === 'OWNER') return '#D4A853';
  if (role === 'ADMIN') return '#3b82f6';
  return '#6b7280';
}

// ── Header ───────────────────────────────────────────────────
function renderHeader() {
  const header = document.getElementById('site-header');
  if (!header) return;

  const user = Auth.user();
  header.innerHTML = `
    <div class="header-inner">
      <a href="/" class="logo">NEXUS<br/>BLOG<span>retro gamer &amp; anime</span></a>
      <div class="search-bar">
        <input type="text" id="header-search" placeholder="Buscar posts..." />
        <button id="header-search-btn" title="Buscar">🔍</button>
      </div>
      <nav class="nav" id="main-nav">
        <a href="/">Início</a>
        ${user && Auth.isAdmin() ? '<a href="/admin.html">Admin</a>' : ''}
      </nav>
      <div class="user-menu" id="user-menu">
        ${user ? `
          <button class="user-btn" id="user-btn">
            ${avatarEl(user, 'sm').outerHTML}
            <span>${user.username}</span>
            <span style="font-size:.6rem;margin-left:4px;opacity:.6">▼</span>
          </button>
          <div class="dropdown" id="user-dropdown">
            <div style="padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.06)">
              <div style="font-family:var(--font-head);font-size:.62rem;color:var(--gold)">${user.username}</div>
              <div style="font-size:.68rem;color:var(--muted);margin-top:2px">${user.email}</div>
              <span class="role-badge role-${user.role}" style="margin-top:4px;display:inline-block">${user.role}</span>
            </div>
            ${Auth.isAdmin() ? '<a href="/admin.html">Painel Admin</a>' : ''}
            <button id="logout-btn">Sair</button>
          </div>
        ` : `
          <a href="/login.html" class="btn btn-outline btn-sm">Login</a>
          <a href="/login.html" class="btn btn-gold btn-sm">Registro</a>
        `}
      </div>
    </div>
  `;

  const searchInput = document.getElementById('header-search');
  const searchBtn = document.getElementById('header-search-btn');
  function doSearch() {
    const q = searchInput.value.trim();
    if (q) window.location.href = `/?search=${encodeURIComponent(q)}`;
  }
  if (searchBtn) searchBtn.addEventListener('click', doSearch);
  if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  if (user) {
    const userBtn = document.getElementById('user-btn');
    const dropdown = document.getElementById('user-dropdown');
    userBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown?.classList.remove('open'));
    document.getElementById('logout-btn')?.addEventListener('click', () => Auth.logout());
  }
}

// ── Highlight active nav ─────────────────────────────────────
function highlightNav() {
  const links = document.querySelectorAll('.nav a');
  const path = window.location.pathname;
  links.forEach(a => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
}

// ── Post card ────────────────────────────────────────────────
function postCardEl(post) {
  const card = document.createElement('div');
  card.className = 'post-card';
  card.style.cursor = 'pointer';

  const cover = post.coverImageUrl
    ? `<img class="post-card-cover" src="${escHtml(post.coverImageUrl)}" alt="" loading="lazy" />`
    : `<div class="post-card-cover-placeholder">🎮</div>`;

  const catBadge = post.category
    ? `<span class="cat-badge" style="background:${post.category.color ? post.category.color + '22' : ''};color:${post.category.color || 'var(--gold)'};border-color:${post.category.color ? post.category.color + '55' : ''}">${escHtml(post.category.name)}</span>`
    : '';
  const pinnedBadge  = post.isPinned   ? '<span class="cat-badge pinned-badge">📌 Fixado</span>' : '';
  const featuredBadge = post.isFeatured ? '<span class="cat-badge featured-badge">⭐ Destaque</span>' : '';

  card.innerHTML = `
    ${cover}
    <div class="post-card-body">
      <div class="post-card-meta">${catBadge}${pinnedBadge}${featuredBadge}</div>
      <div class="post-card-title">${escHtml(post.title)}</div>
      ${post.excerpt ? `<div class="post-card-excerpt">${escHtml(post.excerpt)}</div>` : ''}
      <div class="post-card-footer">
        <div style="display:flex;align-items:center;gap:8px">
          ${avatarEl(post.author, 'sm').outerHTML}
          <div>
            <div style="font-family:var(--font-head);font-size:.65rem;color:var(--gold)">${escHtml(post.author?.username || '?')}</div>
            <div style="font-size:.67rem;color:var(--muted)">${formatRelative(post.createdAt)}</div>
          </div>
        </div>
        <div class="post-card-stats">
          <span class="post-card-stat">👁 ${post.viewCount||0}</span>
          <span class="post-card-stat">❤️ ${post.likeCount||0}</span>
          <span class="post-card-stat">💬 ${post.commentCount||0}</span>
        </div>
      </div>
    </div>
  `;
  card.addEventListener('click', () => window.location.href = `/post.html?id=${post.slug}`);
  return card;
}

// ── Escape HTML ──────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Sidebar ──────────────────────────────────────────────────
async function renderSidebar(sidebarEl) {
  if (!sidebarEl) return;
  sidebarEl.innerHTML = `
    <div class="online-badge">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="online-dot"></div>
        <span style="font-family:var(--font-head);font-size:.62rem;color:var(--green);font-weight:700">ONLINE</span>
      </div>
      <span style="font-family:var(--font-title);font-size:.7rem;color:var(--green)" id="sidebar-online">0</span>
    </div>

    <div class="sidebar-section">
      <div class="card-header"><span>📁</span><h3>Categorias</h3></div>
      <div class="card-body" id="sidebar-cats"><div class="skeleton" style="height:24px;margin-bottom:6px"></div><div class="skeleton" style="height:24px;margin-bottom:6px"></div><div class="skeleton" style="height:24px"></div></div>
    </div>

    <div class="sidebar-section">
      <div class="card-header"><span>🕐</span><h3>Posts Recentes</h3></div>
      <div class="card-body" id="sidebar-recent"><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px"></div></div>
    </div>

    <div class="sidebar-section" id="sidebar-tags-wrap">
      <div class="card-header"><span>🏷</span><h3>Tags</h3></div>
      <div class="card-body" id="sidebar-tags"></div>
    </div>
  `;

  try {
    const [cats, recent, tags, online] = await Promise.all([
      api.get('/api/categories'),
      api.get('/api/posts/recent'),
      api.get('/api/tags'),
      api.get('/api/analytics/online')
    ]);

    const onlineEl = document.getElementById('sidebar-online');
    if (onlineEl) onlineEl.textContent = online?.count || 0;

    // Categories
    const catsEl = document.getElementById('sidebar-cats');
    if (catsEl) {
      if (!cats || cats.length === 0) {
        catsEl.innerHTML = '<div class="empty-state"><p>Sem categorias</p></div>';
      } else {
        catsEl.innerHTML = '';
        cats.forEach(cat => {
          const li = document.createElement('a');
          li.href = `/?category=${cat.id}`;
          li.className = 'sidebar-cat';
          li.innerHTML = `<span class="dot" style="background:${cat.color || 'var(--gold)'}"></span><span class="name">${escHtml(cat.name)}</span><span class="count">${cat.postCount||0}</span>`;
          catsEl.appendChild(li);
        });
      }
    }

    // Recent posts
    const recentEl = document.getElementById('sidebar-recent');
    if (recentEl) {
      if (!recent || recent.posts?.length === 0 && !Array.isArray(recent)) {
        recentEl.innerHTML = '<div class="empty-state"><p>Sem posts</p></div>';
      } else {
        const list = Array.isArray(recent) ? recent : (recent.posts || []);
        recentEl.innerHTML = '';
        list.forEach(p => {
          const div = document.createElement('a');
          div.href = `/post.html?id=${p.slug}`;
          div.className = 'recent-post';
          div.innerHTML = `<div class="title line-clamp-2">${escHtml(p.title)}</div><div class="date">${formatRelative(p.createdAt)}</div>`;
          recentEl.appendChild(div);
        });
      }
    }

    // Tags
    const tagsEl = document.getElementById('sidebar-tags');
    if (tagsEl && tags && tags.length > 0) {
      tags.slice(0, 20).forEach(tag => {
        const a = document.createElement('a');
        a.href = `/?tag=${encodeURIComponent(tag.name)}`;
        a.className = 'tag-pill';
        a.textContent = `#${tag.name} (${tag.post_count||tag.postCount||0})`;
        tagsEl.appendChild(a);
      });
    } else if (document.getElementById('sidebar-tags-wrap')) {
      document.getElementById('sidebar-tags-wrap').style.display = 'none';
    }

  } catch (err) {
    console.error('[sidebar]', err);
  }
}

// Expose globals
window.Auth = Auth;
window.api  = api;
window.Toast = Toast;
window.formatRelative = formatRelative;
window.formatDate = formatDate;
window.avatarEl = avatarEl;
window.postCardEl = postCardEl;
window.escHtml = escHtml;
window.renderHeader = renderHeader;
window.highlightNav = highlightNav;
window.renderSidebar = renderSidebar;
window.roleColor = roleColor;
