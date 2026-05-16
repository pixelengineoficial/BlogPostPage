'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : false
});
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-blog-secret-2024';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────────────────
// DB INIT
// ────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'USER',
        avatar_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        color TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        excerpt TEXT,
        cover_image_url TEXT,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        is_featured BOOLEAN NOT NULL DEFAULT FALSE,
        view_count INTEGER NOT NULL DEFAULT 0,
        like_count INTEGER NOT NULL DEFAULT 0,
        comment_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS post_tags (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        tag TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS post_likes (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(post_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[DB] Tables ready');
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────
function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    avatarUrl: u.avatar_url,
    createdAt: u.created_at
  };
}

function makeSlug(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) +
    '-' +
    Date.now().toString(36)
  );
}

async function buildPost(post, userId) {
  const { rows: [author] } = await pool.query(
    'SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = $1 LIMIT 1',
    [post.author_id]
  );

  let category = null;
  if (post.category_id) {
    const { rows: [cat] } = await pool.query(
      'SELECT c.*, (SELECT COUNT(*)::int FROM posts WHERE category_id = c.id) AS post_count FROM categories c WHERE c.id = $1 LIMIT 1',
      [post.category_id]
    );
    if (cat) category = { id: cat.id, name: cat.name, slug: cat.slug, description: cat.description, color: cat.color, createdAt: cat.created_at, postCount: cat.post_count };
  }

  const { rows: tagRows } = await pool.query('SELECT tag FROM post_tags WHERE post_id = $1', [post.id]);

  let likedByMe = false;
  if (userId) {
    const { rows } = await pool.query(
      'SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2 LIMIT 1',
      [post.id, userId]
    );
    likedByMe = rows.length > 0;
  }

  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    content: post.content,
    excerpt: post.excerpt,
    coverImageUrl: post.cover_image_url,
    authorId: post.author_id,
    categoryId: post.category_id,
    isPinned: post.is_pinned,
    isFeatured: post.is_featured,
    viewCount: post.view_count,
    likeCount: post.like_count,
    commentCount: post.comment_count,
    createdAt: post.created_at,
    updatedAt: post.updated_at,
    author: author ? serializeUser(author) : null,
    category,
    tags: tagRows.map(t => t.tag),
    likedByMe
  };
}

async function buildComment(comment) {
  const { rows: [author] } = await pool.query(
    'SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = $1 LIMIT 1',
    [comment.author_id]
  );
  return {
    id: comment.id,
    content: comment.content,
    postId: comment.post_id,
    authorId: comment.author_id,
    createdAt: comment.created_at,
    author: author ? serializeUser(author) : null
  };
}

// ────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ────────────────────────────────────────────────────────────
function auth(required = true) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      if (required) return res.status(401).json({ error: 'Unauthorized' });
      return next();
    }
    const token = header.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [payload.userId]);
      if (rows.length === 0) {
        if (required) return res.status(401).json({ error: 'User not found' });
        return next();
      }
      req.user = rows[0];
      next();
    } catch {
      if (required) return res.status(401).json({ error: 'Invalid token' });
      next();
    }
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'OWNER')) {
    return res.status(403).json({ error: 'Forbidden: admin required' });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'OWNER') {
    return res.status(403).json({ error: 'Forbidden: owner required' });
  }
  next();
}

// ────────────────────────────────────────────────────────────
// AUTH ROUTES
// ────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });

  try {
    const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
    if (existing.length > 0) return res.status(400).json({ error: 'Email já cadastrado' });

    const { rows: existingUser } = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
    if (existingUser.length > 0) return res.status(400).json({ error: 'Username já em uso' });

    const passwordHash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, 'USER') RETURNING *`,
      [username, email, passwordHash]
    );

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: serializeUser(user) });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/auth/me', auth(), async (req, res) => {
  res.json(serializeUser(req.user));
});

// ────────────────────────────────────────────────────────────
// CATEGORIES ROUTES
// ────────────────────────────────────────────────────────────
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT c.*, (SELECT COUNT(*)::int FROM posts WHERE category_id = c.id) AS post_count FROM categories c ORDER BY c.name'
    );
    res.json(rows.map(c => ({ id: c.id, name: c.name, slug: c.slug, description: c.description, color: c.color, createdAt: c.created_at, postCount: c.post_count })));
  } catch (err) {
    console.error('[categories]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/categories', auth(), requireAdmin, async (req, res) => {
  const { name, description, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const { rows: [cat] } = await pool.query(
      'INSERT INTO categories (name, slug, description, color) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, slug, description || null, color || null]
    );
    res.status(201).json({ id: cat.id, name: cat.name, slug: cat.slug, description: cat.description, color: cat.color, createdAt: cat.created_at, postCount: 0 });
  } catch (err) {
    console.error('[categories POST]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.patch('/api/categories/:id', auth(), requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, description, color } = req.body;
  const updates = [];
  const vals = [];
  let idx = 1;
  if (name !== undefined) { updates.push(`name = $${idx++}`, `slug = $${idx++}`); vals.push(name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }
  if (description !== undefined) { updates.push(`description = $${idx++}`); vals.push(description); }
  if (color !== undefined) { updates.push(`color = $${idx++}`); vals.push(color); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
  vals.push(id);
  try {
    const { rows: [cat] } = await pool.query(`UPDATE categories SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
    if (!cat) return res.status(404).json({ error: 'Categoria não encontrada' });
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int FROM posts WHERE category_id = $1', [id]);
    res.json({ id: cat.id, name: cat.name, slug: cat.slug, description: cat.description, color: cat.color, createdAt: cat.created_at, postCount: count });
  } catch (err) {
    console.error('[categories PATCH]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/categories/:id', auth(), requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('[categories DELETE]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ────────────────────────────────────────────────────────────
// TAGS ROUTE
// ────────────────────────────────────────────────────────────
app.get('/api/tags', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT tag AS name, COUNT(*)::int AS post_count FROM post_tags GROUP BY tag ORDER BY post_count DESC LIMIT 30'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ────────────────────────────────────────────────────────────
// POSTS ROUTES
// ────────────────────────────────────────────────────────────
app.get('/api/posts', auth(false), async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const categoryId = req.query.categoryId ? parseInt(req.query.categoryId) : null;
  const tag = req.query.tag || null;
  const search = req.query.search || null;

  try {
    const where = [];
    const vals = [];
    let idx = 1;

    if (tag) {
      const { rows: tagRows } = await pool.query('SELECT post_id FROM post_tags WHERE tag = $1', [tag]);
      const postIds = tagRows.map(r => r.post_id);
      if (postIds.length === 0) return res.json({ posts: [], total: 0, page, limit });
      where.push(`p.id = ANY($${idx++})`); vals.push(postIds);
    }
    if (categoryId) { where.push(`p.category_id = $${idx++}`); vals.push(categoryId); }
    if (search) { where.push(`p.title ILIKE $${idx++}`); vals.push(`%${search}%`); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const { rows: [{ total }] } = await pool.query(`SELECT COUNT(*)::int AS total FROM posts p ${whereClause}`, vals);

    const countVals = [...vals];
    countVals.push(limit, offset);
    const { rows: rawPosts } = await pool.query(
      `SELECT p.* FROM posts p ${whereClause} ORDER BY p.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      countVals
    );

    const posts = await Promise.all(rawPosts.map(p => buildPost(p, req.user?.id)));
    res.json({ posts, total, page, limit });
  } catch (err) {
    console.error('[posts GET]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/posts/pinned', auth(false), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM posts WHERE is_pinned = TRUE ORDER BY created_at DESC LIMIT 5');
    const posts = await Promise.all(rows.map(p => buildPost(p, req.user?.id)));
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/posts/featured', auth(false), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM posts WHERE is_featured = TRUE ORDER BY created_at DESC LIMIT 6');
    const posts = await Promise.all(rows.map(p => buildPost(p, req.user?.id)));
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/posts/recent', auth(false), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM posts ORDER BY created_at DESC LIMIT 5');
    const posts = await Promise.all(rows.map(p => buildPost(p, req.user?.id)));
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/posts/:id', auth(false), async (req, res) => {
  const { id } = req.params;
  try {
    let post;
    const numId = parseInt(id);
    if (!isNaN(numId)) {
      const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1 LIMIT 1', [numId]);
      post = rows[0];
    }
    if (!post) {
      const { rows } = await pool.query('SELECT * FROM posts WHERE slug = $1 LIMIT 1', [id]);
      post = rows[0];
    }
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    res.json(await buildPost(post, req.user?.id));
  } catch (err) {
    console.error('[post GET]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/posts', auth(), requireAdmin, async (req, res) => {
  const { title, content, excerpt, coverImageUrl, categoryId, tags, isPinned, isFeatured } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Título e conteúdo são obrigatórios' });
  const slug = makeSlug(title);
  try {
    const { rows: [post] } = await pool.query(
      `INSERT INTO posts (title, slug, content, excerpt, cover_image_url, author_id, category_id, is_pinned, is_featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, slug, content, excerpt || null, coverImageUrl || null, req.user.id, categoryId || null, !!isPinned, !!isFeatured]
    );
    if (tags && Array.isArray(tags) && tags.length > 0) {
      for (const tag of tags) {
        await pool.query('INSERT INTO post_tags (post_id, tag) VALUES ($1, $2)', [post.id, tag]);
      }
    }
    const built = await buildPost(post, req.user.id);
    io.emit('new_post', built);
    res.status(201).json(built);
  } catch (err) {
    console.error('[post POST]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.patch('/api/posts/:id', auth(), requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, content, excerpt, coverImageUrl, categoryId, tags, isPinned, isFeatured } = req.body;
  const updates = ['updated_at = NOW()'];
  const vals = [];
  let idx = 1;
  if (title !== undefined) { updates.push(`title = $${idx++}`); vals.push(title); }
  if (content !== undefined) { updates.push(`content = $${idx++}`); vals.push(content); }
  if (excerpt !== undefined) { updates.push(`excerpt = $${idx++}`); vals.push(excerpt); }
  if (coverImageUrl !== undefined) { updates.push(`cover_image_url = $${idx++}`); vals.push(coverImageUrl || null); }
  if (categoryId !== undefined) { updates.push(`category_id = $${idx++}`); vals.push(categoryId || null); }
  if (isPinned !== undefined) { updates.push(`is_pinned = $${idx++}`); vals.push(!!isPinned); }
  if (isFeatured !== undefined) { updates.push(`is_featured = $${idx++}`); vals.push(!!isFeatured); }
  vals.push(id);
  try {
    const { rows: [post] } = await pool.query(`UPDATE posts SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
    if (!post) return res.status(404).json({ error: 'Post não encontrado' });
    if (tags !== undefined) {
      await pool.query('DELETE FROM post_tags WHERE post_id = $1', [id]);
      if (Array.isArray(tags) && tags.length > 0) {
        for (const tag of tags) {
          await pool.query('INSERT INTO post_tags (post_id, tag) VALUES ($1, $2)', [id, tag]);
        }
      }
    }
    const built = await buildPost(post, req.user.id);
    res.json(built);
  } catch (err) {
    console.error('[post PATCH]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/posts/:id', auth(), requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/posts/:id/like', auth(), async (req, res) => {
  const postId = parseInt(req.params.id);
  const userId = req.user.id;
  try {
    const { rows } = await pool.query('SELECT id FROM post_likes WHERE post_id = $1 AND user_id = $2 LIMIT 1', [postId, userId]);
    let liked;
    if (rows.length > 0) {
      await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, userId]);
      await pool.query('UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1', [postId]);
      liked = false;
    } else {
      await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2)', [postId, userId]);
      await pool.query('UPDATE posts SET like_count = like_count + 1 WHERE id = $1', [postId]);
      liked = true;
    }
    const { rows: [post] } = await pool.query('SELECT like_count FROM posts WHERE id = $1 LIMIT 1', [postId]);
    res.json({ liked, likeCount: post?.like_count ?? 0 });
  } catch (err) {
    console.error('[like]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/posts/:id/view', async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    await pool.query('UPDATE posts SET view_count = view_count + 1 WHERE id = $1', [postId]);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ────────────────────────────────────────────────────────────
// COMMENTS ROUTES
// ────────────────────────────────────────────────────────────
app.get('/api/posts/:id/comments', async (req, res) => {
  const postId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at DESC', [postId]);
    const comments = await Promise.all(rows.map(buildComment));
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/posts/:id/comments', auth(), async (req, res) => {
  const postId = parseInt(req.params.id);
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Conteúdo obrigatório' });
  if (content.length > 1000) return res.status(400).json({ error: 'Comentário muito longo' });
  try {
    const { rows: [comment] } = await pool.query(
      'INSERT INTO comments (content, post_id, author_id) VALUES ($1, $2, $3) RETURNING *',
      [content.trim(), postId, req.user.id]
    );
    await pool.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [postId]);
    const built = await buildComment(comment);
    io.emit('new_comment', { postId, comment: built });
    res.status(201).json(built);
  } catch (err) {
    console.error('[comment POST]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/comments/:id', auth(), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query('SELECT * FROM comments WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Comentário não encontrado' });
    const comment = rows[0];
    const u = req.user;
    if (u.role !== 'ADMIN' && u.role !== 'OWNER' && u.id !== comment.author_id) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    await pool.query('DELETE FROM comments WHERE id = $1', [id]);
    await pool.query('UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [comment.post_id]);
    res.status(204).send();
  } catch (err) {
    console.error('[comment DELETE]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ────────────────────────────────────────────────────────────
// USERS ROUTES
// ────────────────────────────────────────────────────────────
app.get('/api/users', auth(), requireOwner, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json(rows.map(serializeUser));
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.patch('/api/users/:id/role', auth(), requireOwner, async (req, res) => {
  const id = parseInt(req.params.id);
  const { role } = req.body;
  if (!['USER', 'ADMIN', 'OWNER'].includes(role)) return res.status(400).json({ error: 'Role inválido' });
  try {
    const { rows: [user] } = await pool.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING *', [role, id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(serializeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ────────────────────────────────────────────────────────────
// ANALYTICS ROUTES
// ────────────────────────────────────────────────────────────
let onlineCount = 0;

app.get('/api/analytics/overview', auth(), requireAdmin, async (req, res) => {
  try {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      { rows: [{ total_posts }] },
      { rows: [{ total_users }] },
      { rows: [{ total_comments }] },
      { rows: [{ total_views }] },
      { rows: [{ total_likes }] },
      { rows: [{ posts_this_week }] },
      { rows: [{ comments_this_week }] },
      { rows: topRaw }
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total_posts FROM posts'),
      pool.query('SELECT COUNT(*)::int AS total_users FROM users'),
      pool.query('SELECT COUNT(*)::int AS total_comments FROM comments'),
      pool.query('SELECT COALESCE(SUM(view_count), 0)::int AS total_views FROM posts'),
      pool.query('SELECT COALESCE(SUM(like_count), 0)::int AS total_likes FROM posts'),
      pool.query('SELECT COUNT(*)::int AS posts_this_week FROM posts WHERE created_at >= $1', [oneWeekAgo]),
      pool.query('SELECT COUNT(*)::int AS comments_this_week FROM comments WHERE created_at >= $1', [oneWeekAgo]),
      pool.query('SELECT id, title, slug, view_count, like_count, comment_count FROM posts ORDER BY view_count DESC LIMIT 5')
    ]);
    res.json({
      totalPosts: total_posts,
      totalUsers: total_users,
      totalComments: total_comments,
      totalViews: total_views,
      totalLikes: total_likes,
      postsThisWeek: posts_this_week,
      commentsThisWeek: comments_this_week,
      topPosts: topRaw.map(p => ({ id: p.id, title: p.title, slug: p.slug, viewCount: p.view_count, likeCount: p.like_count, commentCount: p.comment_count }))
    });
  } catch (err) {
    console.error('[analytics]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/analytics/online', (req, res) => {
  res.json({ count: onlineCount });
});

// ────────────────────────────────────────────────────────────
// NOTIFICATIONS ROUTES
// ────────────────────────────────────────────────────────────
app.get('/api/notifications', auth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/notifications/read', auth(), async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ────────────────────────────────────────────────────────────
// ADMIN COMMENTS LIST
// ────────────────────────────────────────────────────────────
app.get('/api/comments', auth(), requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT c.*, u.username, u.role AS user_role, p.title AS post_title, p.slug AS post_slug FROM comments c JOIN users u ON c.author_id = u.id JOIN posts p ON c.post_id = p.id ORDER BY c.created_at DESC LIMIT 100');
    res.json(rows.map(c => ({
      id: c.id, content: c.content, postId: c.post_id, authorId: c.author_id, createdAt: c.created_at,
      author: { id: c.author_id, username: c.username, role: c.user_role },
      post: { id: c.post_id, title: c.post_title, slug: c.post_slug }
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ────────────────────────────────────────────────────────────
// SPA FALLBACK — serve index.html for unknown routes
// ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ────────────────────────────────────────────────────────────
// SOCKET.IO
// ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount++;
  io.emit('online_count', { count: onlineCount });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('online_count', { count: onlineCount });
  });
});

// ────────────────────────────────────────────────────────────
// START
// ────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] Nexus Blog rodando em http://0.0.0.0:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[server] Falha ao iniciar:', err.message);
    process.exit(1);
  });

process.on('uncaughtException', err => {
  console.error('[server] Erro nao tratado:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Promise rejeitada:', reason);
});
