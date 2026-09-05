// ============================================================================
//  Forum channel — Discord's post list, not a message stream.
//
//  A post is a thread; opening one hands off to the normal thread view, so
//  replies, reactions and read state need nothing new. This file owns the
//  list: search, sort, tag filter, pinned-first ordering, the "New Post"
//  composer and (for staff) tag management. Everything here reads and writes
//  /api/channels/:id/forum/* and stays live through forum_post_* events.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessagesSquare, Plus, Search, Pin, PinOff, Tag, X, Loader2, Bell, BellOff,
  ChevronDown, Image as ImageIcon, MessageSquare, Check, Pencil, Trash2, Settings2, Lock, Users, List, LayoutGrid
} from 'lucide-react';
import { get, post, put, patch, del, upload } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { formatRelativeShort } from '../utils/messageGrouping';
import { avatarOf } from '../utils/avatar';
import { t } from '../i18n/index.jsx';

const SORTS = () => [
  { key: 'latest_activity', label: t('forum.sortActivity') },
  { key: 'creation_date',   label: t('forum.sortCreated') }
];

const TITLE_MAX = 100;
const BODY_MAX = 2000;
const TAGS_PER_POST = 5;

/* --- small pieces ---------------------------------------------------------- */

function TagChip({ tag, active = false, onClick, removable = false, size = 'sm' }) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick && !removable ? active : undefined}
      className={`inline-flex items-center gap-1 rounded-full border transition-colors
        ${size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'}
        ${active ? 'bg-d-brand/20 border-d-brand text-d-strong' : 'bg-d-surface border-d-edge text-d-text2'}
        ${onClick ? 'hover:border-d-text4 hover:text-d-strong' : ''}`}
    >
      {tag.emoji && <span aria-hidden="true">{tag.emoji}</span>}
      <span className="truncate max-w-[9rem]">{tag.name}</span>
      {tag.moderated && <Lock className="w-2.5 h-2.5 opacity-70" aria-label={t('forum.moderatedTag')} />}
      {removable && <X className="w-3 h-3" aria-hidden="true" />}
    </Comp>
  );
}

function PostCard({ post, onOpen, canModerate, onTogglePin, onEditTags, isNew }) {
  const author = post.author;
  return (
    <article
      className={`group relative rounded-lg border bg-d-surface/60 hover:bg-d-surface transition-colors
        ${post.pinned ? 'border-d-brand/50' : 'border-d-edge'} ${isNew ? 'ring-1 ring-d-brand/40' : ''}`}
    >
      <button
        type="button"
        onClick={() => onOpen(post.id)}
        className="w-full text-left p-4 flex gap-4 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
        aria-label={t('forum.openPost', { title: post.name })}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 text-[11px] text-d-text3">
            {post.pinned && (
              <span className="inline-flex items-center gap-1 text-d-brand font-semibold">
                <Pin className="w-3 h-3" aria-hidden="true" />{t('forum.pinned')}
              </span>
            )}
            {post.archived && (
              <span className="bg-d-surface text-d-text3 px-1.5 py-0.5 rounded">{t('chat.archived')}</span>
            )}
            {post.locked && <Lock className="w-3 h-3" aria-label={t('forum.locked')} />}
          </div>
          <h3 className="font-bold text-d-strong text-[15px] leading-snug break-words">{post.name}</h3>
          {post.preview && (
            <p className="text-sm text-d-text2 mt-1 line-clamp-2 break-words whitespace-pre-line">{post.preview}</p>
          )}
          {post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {post.tags.map((tag) => <TagChip key={tag.id} tag={tag} />)}
            </div>
          )}
          <div className="flex items-center gap-3 mt-3 text-xs text-d-text3 min-w-0">
            {author && (
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <img src={avatarOf(author)} alt="" className="w-4 h-4 rounded-full object-cover" />
                <span className="truncate text-d-text2 font-medium">{author.display_name || author.username}</span>
              </span>
            )}
            <span aria-hidden="true">·</span>
            <span>{formatRelativeShort(post.created_at)}</span>
            <span className="inline-flex items-center gap-1 ml-auto shrink-0">
              <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
              {t('forum.replies', { count: post.reply_count })}
            </span>
            {post.reactions?.slice(0, 3).map((r) => (
              <span key={r.emoji} className="inline-flex items-center gap-0.5 shrink-0">
                <span aria-hidden="true">{r.emoji}</span>{r.count}
              </span>
            ))}
            {post.reply_count > 0 && (
              <span className="hidden sm:inline shrink-0">
                {t('forum.lastActive', { when: formatRelativeShort(post.last_activity_at) })}
              </span>
            )}
          </div>
        </div>
        {post.thumbnail_url && (
          <img
            src={post.thumbnail_url}
            alt=""
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-md object-cover shrink-0 bg-d-canvas"
            loading="lazy"
          />
        )}
      </button>

      {(canModerate || onEditTags) && (
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {onEditTags && (
            <button
              type="button"
              onClick={() => onEditTags(post)}
              className="p-1.5 rounded bg-d-canvas/80 text-d-text2 hover:text-d-strong"
              title={t('forum.editTags')}
              aria-label={t('forum.editTags')}
            >
              <Tag className="w-4 h-4" />
            </button>
          )}
          {canModerate && (
            <button
              type="button"
              onClick={() => onTogglePin(post)}
              className="p-1.5 rounded bg-d-canvas/80 text-d-text2 hover:text-d-strong"
              title={post.pinned ? t('forum.unpin') : t('forum.pin')}
              aria-label={post.pinned ? t('forum.unpin') : t('forum.pin')}
            >
              {post.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function GalleryCard({ post, onOpen, canModerate, onTogglePin, onEditTags }) {
  const author = post.author;
  return (
    <article className={`group relative rounded-lg border overflow-hidden bg-d-surface/60 hover:bg-d-surface transition-colors ${post.pinned ? 'border-d-brand/50' : 'border-d-edge'}`}>
      <button
        type="button"
        onClick={() => onOpen(post.id)}
        className="w-full text-left flex flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
        aria-label={t('forum.openPost', { title: post.name })}
      >
        <div className="aspect-[4/3] w-full bg-d-canvas flex items-center justify-center overflow-hidden">
          {post.thumbnail_url ? (
            <img src={post.thumbnail_url} alt="" className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <p className="text-sm text-d-text2 p-4 line-clamp-5 whitespace-pre-line break-words">{post.preview}</p>
          )}
        </div>
        <div className="p-3 min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-d-text3 mb-0.5">
            {post.pinned && <Pin className="w-3 h-3 text-d-brand" aria-label={t('forum.pinned')} />}
            {post.locked && <Lock className="w-3 h-3" aria-label={t('forum.locked')} />}
            {post.tags.slice(0, 2).map((tag) => <TagChip key={tag.id} tag={tag} />)}
          </div>
          <h3 className="font-bold text-d-strong text-sm leading-snug line-clamp-2 break-words">{post.name}</h3>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-d-text3 min-w-0">
            {author && <img src={avatarOf(author)} alt="" className="w-4 h-4 rounded-full object-cover" />}
            <span className="truncate">{author?.display_name || author?.username}</span>
            <span className="inline-flex items-center gap-1 ml-auto shrink-0">
              <MessageSquare className="w-3 h-3" aria-hidden="true" />{post.reply_count}
            </span>
          </div>
        </div>
      </button>
      {(canModerate || onEditTags) && (
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {onEditTags && (
            <button type="button" onClick={() => onEditTags(post)} className="p-1.5 rounded bg-d-canvas/80 text-d-text2 hover:text-d-strong" title={t('forum.editTags')} aria-label={t('forum.editTags')}>
              <Tag className="w-4 h-4" />
            </button>
          )}
          {canModerate && (
            <button type="button" onClick={() => onTogglePin(post)} className="p-1.5 rounded bg-d-canvas/80 text-d-text2 hover:text-d-strong" title={post.pinned ? t('forum.unpin') : t('forum.pin')} aria-label={post.pinned ? t('forum.unpin') : t('forum.pin')}>
              {post.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/* --- tag picker (shared by new-post and edit-tags) --------------------------- */

function TagPicker({ tags, selected, onChange, canModerate, requireTag }) {
  const toggle = (id) => {
    if (selected.includes(id)) return onChange(selected.filter((x) => x !== id));
    if (selected.length >= TAGS_PER_POST) return;
    onChange([...selected, id]);
  };
  const visible = tags.filter((tag) => canModerate || !tag.moderated || selected.includes(tag.id));
  if (visible.length === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wide text-d-text3">
          {t('forum.tags')}{requireTag && <span className="text-d-danger"> *</span>}
        </span>
        <span className="text-[11px] text-d-text3">{selected.length}/{TAGS_PER_POST}</span>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('forum.tags')}>
        {visible.map((tag) => (
          <TagChip
            key={tag.id}
            tag={tag}
            size="md"
            active={selected.includes(tag.id)}
            onClick={tag.moderated && !canModerate ? undefined : () => toggle(tag.id)}
          />
        ))}
      </div>
    </div>
  );
}

/* --- new post modal --------------------------------------------------------- */

function NewPostModal({ channel, tags, canModerate, onClose, onCreated, onToast }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [selected, setSelected] = useState([]);
  const [files, setFiles] = useState([]);       // File[]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap(true, onClose);
  const fileInput = useRef(null);
  const requireTag = Boolean(channel?.require_tag);

  const previews = useMemo(() => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const canSubmit = title.trim().length > 0 && (body.trim().length > 0 || files.length > 0)
    && (!requireTag || selected.length > 0) && !busy;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      let attachments = [];
      for (const file of files) {
        const uploaded = await upload('/api/upload/attachments', 'files', file);
        attachments = attachments.concat(uploaded?.attachments ?? []);
      }
      const result = await post(`/api/channels/${channel.id}/forum/posts`, {
        title: title.trim(), content: body.trim(), tag_ids: selected, attachments
      });
      onCreated(result.post);
    } catch (err) {
      setError(err.message);
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (list) => {
    const next = [...files, ...Array.from(list ?? [])].slice(0, 10);
    setFiles(next);
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center overlay-center p-4" onClick={onClose}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forum-new-post-title"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-d-canvas rounded-xl shadow-2xl border border-d-edge flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-d-edge">
          <h2 id="forum-new-post-title" className="font-bold text-d-strong text-lg flex items-center gap-2">
            <MessagesSquare className="w-5 h-5 text-d-text4" aria-hidden="true" />
            {t('forum.newPostIn', { channel: channel.name })}
          </h2>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label htmlFor="forum-post-title" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
              {t('forum.postTitle')} <span className="text-d-danger">*</span>
            </label>
            <input
              id="forum-post-title"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
              placeholder={t('forum.postTitlePlaceholder')}
              autoFocus
              className="w-full bg-d-input text-d-strong rounded-md px-3 py-2.5 text-[15px] font-semibold outline-none focus:ring-2 focus:ring-d-brand"
            />
            <div className="text-right text-[11px] text-d-text3 mt-1">{title.length}/{TITLE_MAX}</div>
          </div>

          <div>
            <label htmlFor="forum-post-body" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
              {t('forum.postBody')}
            </label>
            <textarea
              id="forum-post-body"
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
              placeholder={t('forum.postBodyPlaceholder')}
              rows={7}
              className="w-full bg-d-input text-d-strong rounded-md px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-d-brand resize-y min-h-[7rem]"
            />
            <div className="flex items-center justify-between mt-1">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-1.5 text-xs text-d-text2 hover:text-d-strong"
              >
                <ImageIcon className="w-4 h-4" aria-hidden="true" />{t('forum.addAttachment')}
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/*,video/*,audio/*,.pdf,.txt,.zip"
                className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
                aria-label={t('forum.addAttachment')}
              />
              <span className="text-[11px] text-d-text3">{body.length}/{BODY_MAX}</span>
            </div>
            {previews.length > 0 && (
              <ul className="flex flex-wrap gap-2 mt-2" aria-label={t('forum.attachments')}>
                {previews.map(({ file, url }, i) => (
                  <li key={url} className="relative w-20 h-20 rounded-md overflow-hidden bg-d-surface border border-d-edge">
                    {file.type.startsWith('image/') ? (
                      <img src={url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-d-text2 p-1 text-center break-all">{file.name}</div>
                    )}
                    <button
                      type="button"
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      className="absolute top-1 right-1 bg-black/70 rounded-full p-0.5 text-white"
                      aria-label={t('forum.removeAttachment', { name: file.name })}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <TagPicker tags={tags} selected={selected} onChange={setSelected} canModerate={canModerate} requireTag={requireTag} />

          {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-3 px-5 py-4 border-t border-d-edge bg-d-surface/40 rounded-b-xl">
          <button type="button" onClick={onClose} className="text-sm text-d-text2 hover:underline px-3 py-2">{t('common.cancel')}</button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-md"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {t('forum.publish')}
          </button>
        </footer>
      </form>
    </div>
  );
}

/* --- edit tags on an existing post ----------------------------------------- */

function EditTagsModal({ post, tags, canModerate, onClose, onSaved, onToast }) {
  const [selected, setSelected] = useState(post.tags.map((tag) => tag.id));
  const [busy, setBusy] = useState(false);
  const dialogRef = useFocusTrap(true, onClose);

  const save = async () => {
    setBusy(true);
    try {
      const updated = await put(`/api/forum/posts/${post.id}/tags`, { tag_ids: selected });
      onSaved(updated);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center overlay-center p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forum-edit-tags-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-d-canvas rounded-xl shadow-2xl border border-d-edge p-5"
      >
        <h2 id="forum-edit-tags-title" className="font-bold text-d-strong text-lg mb-1">{t('forum.editTags')}</h2>
        <p className="text-sm text-d-text2 mb-4 truncate">{post.name}</p>
        <TagPicker tags={tags} selected={selected} onChange={setSelected} canModerate={canModerate} />
        <div className="flex justify-end gap-3 mt-5">
          <button type="button" onClick={onClose} className="text-sm text-d-text2 hover:underline px-3 py-2">{t('common.cancel')}</button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-2 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-md"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --- tag manager (staff) --------------------------------------------------- */

function ManageTagsModal({ channel, tags, onClose, onChanged, onToast }) {
  const [draft, setDraft] = useState({ name: '', emoji: '', moderated: false });
  const [editing, setEditing] = useState(null);   // tag id
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState({
    default_sort_order: channel.default_sort_order || 'latest_activity',
    default_layout: channel.default_layout || 'list',
    require_tag: Boolean(channel.require_tag)
  });
  const dialogRef = useFocusTrap(true, onClose);

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); await onChanged(); } catch (err) { onToast?.(err.message, { type: 'error' }); } finally { setBusy(false); }
  };

  const create = (e) => {
    e.preventDefault();
    if (!draft.name.trim()) return;
    run(async () => {
      await post(`/api/channels/${channel.id}/forum/tags`, {
        name: draft.name.trim(), emoji: draft.emoji.trim() || null, moderated: draft.moderated
      });
      setDraft({ name: '', emoji: '', moderated: false });
    });
  };

  const saveSettings = (next) => {
    setSettings(next);
    run(() => patch(`/api/channels/${channel.id}/forum`, next));
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center overlay-center p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forum-manage-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-d-canvas rounded-xl shadow-2xl border border-d-edge flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-d-edge">
          <h2 id="forum-manage-title" className="font-bold text-d-strong text-lg">{t('forum.manageForum')}</h2>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-5 space-y-6 overflow-y-auto">
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-2">{t('forum.defaults')}</h3>
            <label htmlFor="forum-default-sort" className="block text-sm text-d-text2 mb-1">{t('forum.defaultSort')}</label>
            <select
              id="forum-default-sort"
              value={settings.default_sort_order}
              onChange={(e) => saveSettings({ ...settings, default_sort_order: e.target.value })}
              className="w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand"
            >
              {SORTS().map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <label htmlFor="forum-default-layout" className="block text-sm text-d-text2 mb-1 mt-3">{t('forum.layout')}</label>
            <select
              id="forum-default-layout"
              value={settings.default_layout}
              onChange={(e) => saveSettings({ ...settings, default_layout: e.target.value })}
              className="w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand"
            >
              <option value="list">{t('forum.layoutList')}</option>
              <option value="gallery">{t('forum.layoutGallery')}</option>
            </select>
            <label className="flex items-center justify-between gap-3 mt-3 text-sm text-d-text2">
              <span>
                <span className="block text-d-strong">{t('forum.requireTag')}</span>
                <span className="block text-xs text-d-text3">{t('forum.requireTagHint')}</span>
              </span>
              <input
                type="checkbox"
                checked={settings.require_tag}
                onChange={(e) => saveSettings({ ...settings, require_tag: e.target.checked })}
                className="w-4 h-4 accent-d-brand"
              />
            </label>
          </section>

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-2">
              {t('forum.tags')} <span className="text-d-text3 font-normal">({tags.length}/20)</span>
            </h3>
            <ul className="space-y-1.5">
              {tags.map((tag) => (
                <li key={tag.id} className="flex items-center gap-2 bg-d-surface/60 rounded-md px-3 py-2">
                  {editing === tag.id ? (
                    <TagEditRow
                      tag={tag}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={(patchBody) => run(async () => {
                        await patch(`/api/channels/${channel.id}/forum/tags/${tag.id}`, patchBody);
                        setEditing(null);
                      })}
                    />
                  ) : (
                    <>
                      <span className="w-6 text-center" aria-hidden="true">{tag.emoji || '🏷️'}</span>
                      <span className="flex-1 text-sm text-d-strong truncate">{tag.name}</span>
                      {tag.moderated && (
                        <span className="text-[10px] uppercase tracking-wide text-d-text3 inline-flex items-center gap-1">
                          <Lock className="w-3 h-3" aria-hidden="true" />{t('forum.modOnly')}
                        </span>
                      )}
                      <button type="button" onClick={() => setEditing(tag.id)} className="text-d-text3 hover:text-d-strong p-1" aria-label={t('forum.editTag', { name: tag.name })}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => run(() => del(`/api/channels/${channel.id}/forum/tags/${tag.id}`))}
                        className="text-d-text3 hover:text-d-danger p-1"
                        aria-label={t('forum.deleteTag', { name: tag.name })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </li>
              ))}
              {tags.length === 0 && <li className="text-sm text-d-text3">{t('forum.noTagsYet')}</li>}
            </ul>

            <form onSubmit={create} className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={draft.emoji}
                onChange={(e) => setDraft({ ...draft, emoji: e.target.value.slice(0, 8) })}
                placeholder="😀"
                aria-label={t('forum.tagEmoji')}
                className="w-14 bg-d-input text-d-strong rounded-md px-2 py-2 text-sm text-center outline-none focus:ring-2 focus:ring-d-brand"
              />
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value.slice(0, 20) })}
                placeholder={t('forum.tagNamePlaceholder')}
                aria-label={t('forum.tagName')}
                className="flex-1 min-w-[8rem] bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand"
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-d-text2">
                <input
                  type="checkbox"
                  checked={draft.moderated}
                  onChange={(e) => setDraft({ ...draft, moderated: e.target.checked })}
                  className="accent-d-brand"
                />
                {t('forum.modOnly')}
              </label>
              <button
                type="submit"
                disabled={busy || !draft.name.trim() || tags.length >= 20}
                className="inline-flex items-center gap-1.5 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-3 py-2 rounded-md"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />{t('forum.addTag')}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}

function TagEditRow({ tag, busy, onCancel, onSave }) {
  const [name, setName] = useState(tag.name);
  const [emoji, setEmoji] = useState(tag.emoji || '');
  const [moderated, setModerated] = useState(tag.moderated);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim(), emoji: emoji.trim() || null, moderated }); }}
      className="flex flex-wrap items-center gap-2 w-full"
    >
      <input value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 8))} aria-label={t('forum.tagEmoji')}
        className="w-12 bg-d-input text-d-strong rounded px-2 py-1 text-sm text-center outline-none focus:ring-2 focus:ring-d-brand" />
      <input value={name} onChange={(e) => setName(e.target.value.slice(0, 20))} aria-label={t('forum.tagName')} autoFocus
        className="flex-1 min-w-[6rem] bg-d-input text-d-strong rounded px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-d-brand" />
      <label className="inline-flex items-center gap-1 text-xs text-d-text2">
        <input type="checkbox" checked={moderated} onChange={(e) => setModerated(e.target.checked)} className="accent-d-brand" />
        {t('forum.modOnly')}
      </label>
      <button type="submit" disabled={busy || !name.trim()} className="text-d-success p-1" aria-label={t('common.save')}><Check className="w-4 h-4" /></button>
      <button type="button" onClick={onCancel} className="text-d-text3 p-1" aria-label={t('common.cancel')}><X className="w-4 h-4" /></button>
    </form>
  );
}

/* --- the view --------------------------------------------------------------- */

export default function ForumView({
  channel, currentUser, viewerPermissions, isOwner, socket,
  onOpenPost, onToast, onOpenNotificationSettings, channelSettings, onToggleMemberList, showMemberList
}) {
  const [tags, setTags] = useState([]);
  const [posts, setPosts] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState(null);           // null = forum default
  const [filterTags, setFilterTags] = useState([]);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [layout, setLayout] = useState(null);       // null = forum default
  const [modal, setModal] = useState(null);        // null | 'new' | 'manage' | {editTags: post}
  const [recentlyCreated, setRecentlyCreated] = useState(null);
  const debounce = useRef(null);

  const perms = Array.isArray(viewerPermissions) ? viewerPermissions : [];
  const has = (name) => isOwner || perms.includes(name) || perms.includes('ADMINISTRATOR');
  const canPost = has('CREATE_PUBLIC_THREADS') && has('SEND_MESSAGES');
  const canModerate = has('MANAGE_THREADS');
  const canManage = has('MANAGE_CHANNELS');
  const effectiveSort = sort ?? channel?.default_sort_order ?? 'latest_activity';
  const effectiveLayout = layout ?? channel?.default_layout ?? 'list';
  const muted = Boolean(channelSettings?.muted);

  const loadTags = useCallback(() => {
    if (!channel?.id) return Promise.resolve();
    return get(`/api/channels/${channel.id}/forum/tags`).then((list) => setTags(Array.isArray(list) ? list : [])).catch(() => {});
  }, [channel?.id]);

  const load = useCallback(async ({ append = false } = {}) => {
    if (!channel?.id) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('sort', effectiveSort);
      if (filterTags.length) params.set('tags', filterTags.join(','));
      if (query.trim()) params.set('q', query.trim());
      if (showArchived) params.set('includeArchived', 'true');
      if (append && nextBefore) params.set('before', nextBefore);
      const data = await get(`/api/channels/${channel.id}/forum/posts?${params}`);
      setPosts((prev) => (append && prev ? [...prev, ...data.posts] : data.posts));
      setHasMore(Boolean(data.has_more));
      setNextBefore(data.next_before ?? null);
    } catch (err) {
      setPosts((prev) => prev ?? []);
      onToast?.(err.message, { type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [channel?.id, effectiveSort, filterTags, query, showArchived, nextBefore, onToast]);

  // Reset when the channel or filters change; debounce typing in the search box.
  useEffect(() => { loadTags(); }, [loadTags]);
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { setPosts(null); load({ append: false }); }, query ? 250 : 0);
    return () => clearTimeout(debounce.current);
  }, [channel?.id, effectiveSort, filterTags, query, showArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates: new posts, tag/pin changes, tag list edits.
  useEffect(() => {
    if (!socket || !channel?.id) return undefined;
    const onCreated = (postRow) => {
      if (postRow.parent_id !== channel.id) return;
      setPosts((prev) => (prev && !prev.some((p) => p.id === postRow.id) ? [postRow, ...prev] : prev));
    };
    const onUpdated = (postRow) => {
      if (postRow.parent_id !== channel.id) return;
      setPosts((prev) => {
        if (!prev) return prev;
        const next = prev.map((p) => (p.id === postRow.id ? { ...p, ...postRow } : p));
        // Pin state affects ordering; keep pinned on top without a refetch.
        return next.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      });
    };
    const onTags = ({ channel_id }) => { if (channel_id === channel.id) loadTags(); };
    // A reply bumps the post's activity + reply count.
    const onMessage = (msg) => {
      setPosts((prev) => {
        if (!prev || !prev.some((p) => p.id === msg.channel_id)) return prev;
        const next = prev.map((p) => (p.id === msg.channel_id
          ? { ...p, reply_count: p.reply_count + 1, message_count: p.message_count + 1, last_activity_at: msg.created_at }
          : p));
        if (effectiveSort !== 'latest_activity') return next;
        return next.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (a.last_activity_at < b.last_activity_at ? 1 : -1));
      });
    };
    socket.on('forum_post_created', onCreated);
    socket.on('forum_post_updated', onUpdated);
    socket.on('forum_tags_updated', onTags);
    socket.on('new_message', onMessage);
    return () => {
      socket.off('forum_post_created', onCreated);
      socket.off('forum_post_updated', onUpdated);
      socket.off('forum_tags_updated', onTags);
      socket.off('new_message', onMessage);
    };
  }, [socket, channel?.id, effectiveSort, loadTags]);

  const togglePin = async (postRow) => {
    try {
      const updated = await put(`/api/forum/posts/${postRow.id}/pin`, { pinned: !postRow.pinned });
      setPosts((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)).sort((a, b) => Number(b.pinned) - Number(a.pinned)) ?? prev);
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const toggleFilterTag = (id) => setFilterTags((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  if (!channel) return null;

  return (
    <div className="flex-1 bg-d-canvas flex flex-col min-w-0 h-full relative">
      {/* header — same bar as a text channel */}
      <div className="h-12 px-4 shadow-sm border-b border-d-edge flex items-center justify-between shrink-0 bg-d-canvas z-10">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare className="w-6 h-6 text-d-text4 shrink-0" aria-hidden="true" />
          <span className="font-bold text-d-strong text-[15px] truncate">{channel.name}</span>
          {channel.is_private && <Lock className="w-3.5 h-3.5 text-d-text4 shrink-0" />}
          {channel.topic && (
            <>
              <div className="w-[1px] h-4 bg-d-divider mx-2 hidden sm:block" />
              <span className="text-xs text-d-text3 truncate hidden sm:block" title={channel.topic}>{channel.topic}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3 text-d-text2">
          {canManage && (
            <button type="button" onClick={() => setModal('manage')} className="hover:text-d-strong transition-colors" title={t('forum.manageForum')} aria-label={t('forum.manageForum')}>
              <Settings2 className="w-5 h-5" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOpenNotificationSettings?.(r.left - 120, r.bottom + 6); }}
            className={`hover:text-d-strong transition-colors ${muted ? 'text-d-danger' : ''}`}
            title={t('notif.notificationSettings')}
            aria-label={t('notif.notificationSettings')}
          >
            {muted ? <BellOff className="w-5 h-5" /> : <Bell className="w-5 h-5" />}
          </button>
          {onToggleMemberList && (
            <button type="button" onClick={onToggleMemberList} className={`hover:text-d-strong transition-colors ${showMemberList ? 'text-d-strong' : ''}`} title={t('chat.memberList')} aria-label={t('chat.memberList')} aria-pressed={showMemberList}>
              <Users className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* toolbar */}
      <div className="px-4 pt-3 pb-2 border-b border-d-edge shrink-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex-1 min-w-[10rem]">
            <span className="sr-only">{t('forum.search')}</span>
            <Search className="w-4 h-4 text-d-text3 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('forum.searchPlaceholder')}
              className="w-full bg-d-input text-d-strong rounded-md pl-8 pr-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-d-brand"
            />
          </label>

          <label className="relative">
            <span className="sr-only">{t('forum.sort')}</span>
            <select
              value={effectiveSort}
              onChange={(e) => setSort(e.target.value)}
              className="appearance-none bg-d-input text-d-strong rounded-md pl-3 pr-8 py-1.5 text-sm outline-none focus:ring-2 focus:ring-d-brand"
            >
              {SORTS().map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <ChevronDown className="w-4 h-4 text-d-text3 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          </label>

          <div className="inline-flex rounded-md border border-d-edge overflow-hidden" role="group" aria-label={t('forum.layout')}>
            <button type="button" onClick={() => setLayout('list')} aria-pressed={effectiveLayout === 'list'}
              className={`p-1.5 ${effectiveLayout === 'list' ? 'bg-d-surface text-d-strong' : 'text-d-text3 hover:text-d-strong'}`}
              title={t('forum.layoutList')} aria-label={t('forum.layoutList')}>
              <List className="w-4 h-4" />
            </button>
            <button type="button" onClick={() => setLayout('gallery')} aria-pressed={effectiveLayout === 'gallery'}
              className={`p-1.5 ${effectiveLayout === 'gallery' ? 'bg-d-surface text-d-strong' : 'text-d-text3 hover:text-d-strong'}`}
              title={t('forum.layoutGallery')} aria-label={t('forum.layoutGallery')}>
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>

          <label className="inline-flex items-center gap-1.5 text-xs text-d-text2 px-1">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-d-brand" />
            {t('forum.showArchived')}
          </label>

          {canPost && (
            <button
              type="button"
              onClick={() => setModal('new')}
              className="inline-flex items-center gap-1.5 bg-d-brand hover:bg-d-brand-hover text-white text-sm font-semibold px-3 py-1.5 rounded-md ml-auto"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />{t('forum.newPost')}
            </button>
          )}
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('forum.filterByTag')}>
            <Tag className="w-3.5 h-3.5 text-d-text3" aria-hidden="true" />
            {tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} active={filterTags.includes(tag.id)} onClick={() => toggleFilterTag(tag.id)} />
            ))}
            {filterTags.length > 0 && (
              <button type="button" onClick={() => setFilterTags([])} className="text-[11px] text-d-text3 hover:text-d-strong underline ml-1">
                {t('forum.clearFilters')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* posts */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {posts === null ? (
          <div className="flex items-center justify-center py-16 text-d-text3" role="status" aria-live="polite">
            <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center max-w-sm mx-auto">
            <div className="w-16 h-16 rounded-full bg-d-surface flex items-center justify-center mb-4">
              <MessagesSquare className="w-8 h-8 text-d-text4" aria-hidden="true" />
            </div>
            <h3 className="font-bold text-d-strong text-lg">
              {query || filterTags.length ? t('forum.noMatches') : t('forum.emptyTitle')}
            </h3>
            <p className="text-sm text-d-text3 mt-1">
              {query || filterTags.length ? t('forum.noMatchesHint') : t('forum.emptyHint')}
            </p>
            {canPost && !query && filterTags.length === 0 && (
              <button type="button" onClick={() => setModal('new')} className="mt-4 inline-flex items-center gap-1.5 bg-d-brand hover:bg-d-brand-hover text-white text-sm font-semibold px-4 py-2 rounded-md">
                <Plus className="w-4 h-4" aria-hidden="true" />{t('forum.newPost')}
              </button>
            )}
          </div>
        ) : (
          <div className={effectiveLayout === 'gallery'
            ? 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))] max-w-6xl mx-auto'
            : 'space-y-2 max-w-4xl mx-auto'}>
            {posts.map((p) => (effectiveLayout === 'gallery' ? (
              <GalleryCard
                key={p.id}
                post={p}
                onOpen={onOpenPost}
                canModerate={canModerate}
                onTogglePin={togglePin}
                onEditTags={(canModerate || p.owner_id === currentUser?.id) && tags.length > 0 ? (row) => setModal({ editTags: row }) : null}
              />
            ) : (
              <PostCard
                key={p.id}
                post={p}
                isNew={p.id === recentlyCreated}
                onOpen={onOpenPost}
                canModerate={canModerate}
                onTogglePin={togglePin}
                onEditTags={(canModerate || p.owner_id === currentUser?.id) && tags.length > 0 ? (row) => setModal({ editTags: row }) : null}
              />
            )))}
            {hasMore && (
              <div className="flex justify-center pt-2 pb-6 col-span-full">
                <button
                  type="button"
                  onClick={() => load({ append: true })}
                  disabled={loading}
                  className="inline-flex items-center gap-2 text-sm text-d-text2 hover:text-d-strong bg-d-surface hover:bg-d-surface/80 px-4 py-2 rounded-md disabled:opacity-50"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {t('forum.loadMore')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {modal === 'new' && (
        <NewPostModal
          channel={channel}
          tags={tags}
          canModerate={canModerate}
          onClose={() => setModal(null)}
          onToast={onToast}
          onCreated={(created) => {
            setModal(null);
            setRecentlyCreated(created.id);
            setPosts((prev) => (prev && !prev.some((p) => p.id === created.id) ? [created, ...prev] : prev));
            onToast?.(t('forum.posted'), { type: 'success', ttl: 2500 });
            onOpenPost(created.id);
          }}
        />
      )}
      {modal === 'manage' && (
        <ManageTagsModal channel={channel} tags={tags} onClose={() => setModal(null)} onChanged={loadTags} onToast={onToast} />
      )}
      {modal?.editTags && (
        <EditTagsModal
          post={modal.editTags}
          tags={tags}
          canModerate={canModerate}
          onClose={() => setModal(null)}
          onToast={onToast}
          onSaved={(updated) => {
            setModal(null);
            setPosts((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
          }}
        />
      )}
    </div>
  );
}
