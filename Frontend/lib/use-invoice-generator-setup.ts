import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import axios from '@/app/utils/axiosConfig';
import { canAccessWorkspace, type WorkspaceLike } from '@/lib/access';
import { getInvoiceGeneratorBoardFlags } from '@/lib/invoice-generator-helpers';

export function useInvoiceGeneratorSetup({
  id,
  boardId,
  boardLabel,
  user,
  workspace,
  setCurrentWorkspaceId,
  onBusinessTimezoneLoaded,
  setBoardLabel,
}: {
  id: string;
  boardId: string;
  boardLabel: string;
  user: { role: string };
  workspace: WorkspaceLike | null | undefined;
  setCurrentWorkspaceId: (id: string | null) => void;
  onBusinessTimezoneLoaded: (timezone: string) => void;
  setBoardLabel: (label: string) => void;
}) {
  const router = useRouter();
  const { isCareManagementBoard } = getInvoiceGeneratorBoardFlags(boardLabel);
  const canAccessInvoiceGenerator = isCareManagementBoard && canAccessWorkspace(user, workspace);

  useEffect(() => {
    if (id) setCurrentWorkspaceId(id);
    return () => setCurrentWorkspaceId(null);
  }, [id, setCurrentWorkspaceId]);

  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`, { params: { workspaceId: id }, signal: abort.signal })
      .then((res) => {
        if (res.data?.headOfficeTimezone) {
          onBusinessTimezoneLoaded(res.data.headOfficeTimezone);
        }
      })
      .catch((err) => {
        if (err.name !== 'CanceledError' && err.name !== 'AbortError') console.error(err);
      });
    return () => abort.abort();
  }, [id, onBusinessTimezoneLoaded]);

  useEffect(() => {
    if (!boardId) return;
    axios
      .get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards?id=${boardId}`, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      })
      .then((response) => {
        if (response.data?.board?.label) setBoardLabel(response.data.board.label);
      })
      .catch((err) => console.error('Error fetching board label:', err));
  }, [boardId, setBoardLabel]);

  useEffect(() => {
    if (!boardLabel) return;
    if (user.role === 'isoplus_user' && !workspace) return;
    if (!canAccessInvoiceGenerator) {
      router.replace('/workspace/access-denied');
    }
  }, [boardLabel, canAccessInvoiceGenerator, workspace, router, user.role]);
}
