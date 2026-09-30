import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DavEntry } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { listDirectory } from '../../services/davClient';
import { pageCountFor } from '../../lib/davPage';

/**
 * Server-authoritative paging state. `total` is null when the backend does not
 * page, which is what leaves the view showing the full unpaged listing.
 */
interface Paging {
  page: number;
  pageCount: number;
  total: number | null;
  paged: boolean;
}

const UNPAGED: Paging = { page: 1, pageCount: 1, total: null, paged: false };

type Status = 'loading' | 'ready' | 'missing';

/**
 * Data-fetching slice for the file browser.
 *
 * `VolumeView` mixed routing, fetching and mutations; isolating the query keeps
 * the view a thin composition root like `SpaApp`.
 *
 * The reset-to-loading on every fetch is deliberate and was a bug once: navigating
 * to another folder re-ran the effect while `status` was still `ready`, so the
 * *previous* folder's rows stayed on screen until the new PROPFIND resolved. The
 * rows are cleared too, not just the status — `VolumeFileList` gates its
 * not-found state on `entries.length === 0`, so a *failed* PROPFIND used to leave
 * `status: 'missing'` alongside the old rows and render them under the new
 * breadcrumb, as though they lived in the folder that had just failed to load.
 *
 * `authorized` is deliberately not a dependency: it is not read here, and
 * including it fired the effect twice per cold load — once speculatively while
 * auth was resolving and once after — for an identical request.
 */
function useVolumeFiles(
  owner: string,
  volume: string,
  path: string,
  authorized: boolean | null,
  backend: string | null | undefined,
  requestedPage: number,
  pageSize: number,
) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DavEntry[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [paging, setPaging] = useState<Paging>(UNPAGED);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setStatus('loading');
      setEntries([]);
      setPaging(UNPAGED);
      try {
        const rows = await listDirectory(owner, volume, path, backend, { page: requestedPage, limit: pageSize });
        if (cancelled) return;
        setEntries(rows.entries);
        setPaging({
          page: rows.page,
          pageCount: rows.total === null ? 1 : pageCountFor(rows.total, rows.limit),
          total: rows.total,
          paged: rows.paged,
        });
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        setStatus('missing');
        setNotice({ type: 'error', text: toLocalizedErrorMessage(t, error, 'errors.failedToLoadFiles', 'Failed To Load Files.') });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, volume, path, requestedPage, pageSize, reloadKey, backend, t]);

  const refresh = useCallback(() => {
    setStatus('loading');
    setReloadKey((key) => key + 1);
  }, []);

  // Stable identity: a fresh arrow on every render made the caller's effect
  // re-run after every render, re-firing `showNotice` and restarting its
  // dismissal timer, which could make an error toast undismissable.
  const consumeNotice = useCallback(() => setNotice(null), []);

  const crumbs = path === '' ? [] : path.split('/');

  return { entries, status, refresh, crumbs, notice, consumeNotice, paging };
}

export { useVolumeFiles };
export type { Paging, Status };
