import { useEffect } from 'react';
import { fetchQrGeneratorPageData } from '@/lib/qr-generator-helpers';
import { showFetchErrorToast } from '@/lib/toast-utils';

const qrFetchCache = new Map<string, Promise<any>>();

export function useQrGeneratorBootstrap(
  id: string | undefined,
  boardId: string | undefined,
  setBoard: (board: any) => void,
  setBusiness: (business: any) => void,
  setItems: (items: any[]) => void,
  setLoading: (loading: boolean) => void,
) {
  useEffect(() => {
    if (!id || !boardId) return;

    const cacheKey = `${id}-${boardId}`;
    if (!qrFetchCache.has(cacheKey)) {
      qrFetchCache.set(cacheKey, fetchQrGeneratorPageData(id, boardId));
    }

    let cancelled = false;
    setLoading(true);
    qrFetchCache.get(cacheKey)!
      .then((data) => {
        if (!cancelled && data) {
          setBoard(data.boardData);
          setBusiness(data.businessData);
          setItems(data.items);
        }
      })
      .catch((error: any) => {
        if (!cancelled) {
          console.error('Error fetching data:', error);
          showFetchErrorToast('data', error.response?.data?.message || 'Failed to load data');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        qrFetchCache.delete(cacheKey);
      });

    return () => { cancelled = true; };
  }, [id, boardId, setBoard, setBusiness, setItems, setLoading]);
}
