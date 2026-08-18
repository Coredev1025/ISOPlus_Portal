"use client";

import { Button } from "@/components/ui/button";

type Props = Readonly<{
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}>;

/**
 * Plain previous/next paging for the drill-down history — an operator screen,
 * not a product surface, so this deliberately skips the numbered-page-link
 * Pagination component in components/ui in favour of "page X of Y".
 */
export function RunHistoryPager({ page, pageSize, total, onChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        Page {page} of {totalPages} ({total} run{total === 1 ? "" : "s"})
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
