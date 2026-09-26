import React, { useEffect, useId, useState } from 'react';
import { Upload, Trash2, ChevronDown, ChevronRight, Loader2, Package } from 'lucide-react';
import { listPacks, createPack, addPackItem, updatePack, deletePack } from '../../../profile/api';
import { loadCatalogue, itemName } from '../../../profile/store';
import { Toggle } from '../../ui/Toggle.jsx';
import { t } from '../../../i18n/index.jsx';

const KINDS = ['avatar_decoration', 'profile_effect', 'nameplate', 'profile_frame'];
const MAX_SVG = 64 * 1024;
const MAX_IMAGE = 256 * 1024;

const slugify = (name) => name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
      reader.onload = () => resolve({ svg: String(reader.result) });
      reader.readAsText(file);
    } else {
      reader.onload = () => resolve({ image: { type: file.type, data: String(reader.result).split(',')[1] ?? '' } });
      reader.readAsDataURL(file);
    }
  });
}

/**
 * Instance admin › Cosmetics: the packs behind the free collectibles.
 * Upload SVG (sanitised on the server with a strict allow-list — scripts,
 * foreignObject, event handlers and external references are refused) or
 * PNG/WebP; disable or delete packs; switch single items off.
 *
 * Stable API: <CosmeticPackManager onToast />
 */
export default function CosmeticPackManager({ onToast }) {
  const [packs, setPacks] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);

  const refresh = () => listPacks().then(setPacks).catch((err) => setError(err.message));
  useEffect(() => { refresh(); }, []);

  const changed = () => { refresh(); loadCatalogue({ force: true }).catch(() => {}); };

  const toggle = async (pack, enabled) => {
    try { await updatePack(pack.id, { enabled }); changed(); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
  };
  const toggleItem = async (pack, itemId, enabled) => {
    const disabled = pack.items.filter((i) => (i.id === itemId ? !enabled : !i.enabled)).map((i) => i.id);
    try { await updatePack(pack.id, { disabled_items: disabled }); changed(); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
  };
  const remove = async (pack) => {
    try { await deletePack(pack.id); changed(); onToast?.(t('cosAdmin.deleted'), { type: 'success', ttl: 2500 }); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="flex items-center gap-2 text-xl font-semibold text-d-strong">
          <Package className="h-5 w-5" aria-hidden="true" /> {t('cosAdmin.title')}
        </h2>
        <p className="mt-1 text-sm text-d-text2">{t('cosAdmin.lead')}</p>
      </header>

      {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
      {!packs && !error && <p className="text-sm text-d-text3">{t('common.loading')}</p>}

      <ul className="space-y-2">
        {(packs ?? []).map((pack) => (
          <li key={pack.id} className="rounded-lg border border-d-divider bg-d-sunken">
            <div className="flex items-center gap-3 px-3 py-2">
              <button type="button" onClick={() => setOpen(open === pack.id ? null : pack.id)} aria-expanded={open === pack.id}
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left">
                {open === pack.id ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-d-strong">{pack.name}</span>
                  <span className="block truncate text-xs text-d-text3">
                    {t('cosAdmin.packMeta', { count: pack.item_count, source: pack.source === 'builtin' ? t('cosAdmin.builtin') : (pack.author || t('cosAdmin.custom')) })}
                    {pack.license ? ` · ${pack.license}` : ''}
                  </span>
                </span>
              </button>
              <Toggle checked={pack.enabled} onChange={(v) => toggle(pack, v)} label={t('cosAdmin.enabled', { name: pack.name })} />
              {pack.source !== 'builtin' && (
                <button type="button" onClick={() => remove(pack)} aria-label={t('common.deleteNamed', { name: pack.name })}
                  className="flex h-9 w-9 items-center justify-center rounded text-d-text3 hover:bg-d-hover hover:text-d-danger">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
            {open === pack.id && (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 border-t border-d-divider p-3">
                {pack.items.map((item) => (
                  <li key={item.id} className="rounded-md border border-d-divider bg-d-panel p-2 text-center">
                    <img src={item.asset_url} alt="" className="mx-auto h-16 w-full object-contain" loading="lazy" />
                    <span className="mt-1 block truncate text-xs text-d-text">{itemName(item)}</span>
                    <span className="block text-[11px] text-d-text3">{t(`profiles.kind.${item.kind}`)}</span>
                    <label className="mt-1 flex items-center justify-center gap-1 text-[11px] text-d-text2">
                      <input type="checkbox" checked={item.enabled} onChange={(e) => toggleItem(pack, item.id, e.target.checked)} />
                      {t('cosAdmin.itemOn')}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <UploadPack onDone={changed} onToast={onToast} />
    </div>
  );
}

function UploadPack({ onDone, onToast }) {
  const id = useId();
  const [meta, setMeta] = useState({ slug: '', name: '', author: '', license: 'CC-BY-4.0', version: '1.0.0' });
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);

  const addFiles = async (files) => {
    const next = [];
    for (const file of files) {
      const svg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
      if (!svg && !['image/png', 'image/webp'].includes(file.type)) { setErrors((e) => [...e, t('cosAdmin.badType', { name: file.name })]); continue; }
      if (file.size > (svg ? MAX_SVG : MAX_IMAGE)) { setErrors((e) => [...e, t('cosAdmin.tooBig', { name: file.name })]); continue; }
      next.push({ file, kind: 'avatar_decoration', slug: slugify(file.name), name: file.name.replace(/\.[^.]+$/, ''), preview: URL.createObjectURL(file) });
    }
    setItems((list) => [...list, ...next]);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    const problems = [];
    try {
      const pack = await createPack({ ...meta, items: [] });
      for (const it of items) {
        try {
          const asset = await readFile(it.file);
          await addPackItem(pack.id, { kind: it.kind, slug: it.slug, name: it.name, ...asset });
        } catch (err) {
          problems.push(`${it.file.name}: ${err.message}`);
        }
      }
      setErrors(problems);
      if (!problems.length) {
        items.forEach((it) => URL.revokeObjectURL(it.preview));
        setItems([]);
        setMeta({ slug: '', name: '', author: '', license: 'CC-BY-4.0', version: '1.0.0' });
        onToast?.(t('cosAdmin.uploadDone'), { type: 'success', ttl: 2500 });
      }
      onDone();
    } catch (err) {
      setErrors([err.message]);
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded bg-d-input px-2 py-1.5 text-sm text-d-strong focus:outline-none focus:ring-2 focus:ring-d-brand';
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-dashed border-d-divider p-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-d-text2">{t('cosAdmin.uploadTitle')}</h3>
      <p className="text-xs text-d-text3">{t('cosAdmin.uploadRules')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {['slug', 'name', 'author', 'license', 'version'].map((k) => (
          <label key={k} className="text-xs font-semibold text-d-text2" htmlFor={`${id}-${k}`}>
            {t(`cosAdmin.field.${k}`)}
            <input id={`${id}-${k}`} value={meta[k]} required={k === 'slug' || k === 'name'}
              onChange={(e) => setMeta({ ...meta, [k]: k === 'slug' ? slugify(e.target.value) : e.target.value })}
              className={`${field} mt-1`} />
          </label>
        ))}
      </div>
      <label className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded border border-d-divider px-3 text-sm font-semibold text-d-text hover:bg-d-hover has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-d-brand">
        <Upload className="h-4 w-4" aria-hidden="true" /> {t('cosAdmin.addFiles')}
        <input type="file" multiple accept=".svg,image/svg+xml,image/png,image/webp" className="sr-only"
          onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </label>
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={it.preview} className="flex flex-wrap items-center gap-2 rounded border border-d-divider p-2">
              <img src={it.preview} alt="" className="h-10 w-10 rounded bg-d-panel object-contain" />
              <input value={it.name} aria-label={t('cosAdmin.field.name')} className={`${field} w-36 flex-1`}
                onChange={(e) => setItems((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <select value={it.kind} aria-label={t('cosAdmin.kind')} className={`${field} w-auto`}
                onChange={(e) => setItems((list) => list.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                {KINDS.map((k) => <option key={k} value={k}>{t(`profiles.kind.${k}`)}</option>)}
              </select>
              <button type="button" onClick={() => setItems((list) => list.filter((_, j) => j !== i))}
                aria-label={t('common.remove')} className="flex h-9 w-9 items-center justify-center rounded text-d-text3 hover:text-d-danger">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-d-danger">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      <button type="submit" disabled={busy || !meta.slug || !meta.name || !items.length}
        className="flex min-h-9 items-center gap-2 rounded bg-d-brand px-4 text-sm font-semibold text-white hover:bg-d-brandhover disabled:opacity-50">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} {t('cosAdmin.upload')}
      </button>
    </form>
  );
}
