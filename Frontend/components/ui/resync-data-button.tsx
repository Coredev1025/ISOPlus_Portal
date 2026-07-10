'use client';

import { Button } from '@/components/ui/button';
import Spinner from '@/components/ui/spin';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { HelpCircle } from 'lucide-react';

type ResyncDataButtonProps = {
  onSync: () => void;
  onHelp: () => void;
  isSyncing: boolean;
  disabled?: boolean;
  tooltipText?: string;
  className?: string;
};

export function ResyncDataButton({
  onSync,
  onHelp,
  isSyncing,
  disabled = false,
  tooltipText = 'It downloads brand-new data from the server, including any edits and new records.',
  className,
}: ResyncDataButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            className={`gap-2 ${className ?? ''}`}
            onClick={onSync}
            disabled={disabled || isSyncing}
          >
            {isSyncing ? (
              <>
                <Spinner className="h-4 w-4" />
                <span>Syncing...</span>
              </>
            ) : (
              <span>Resync Data</span>
            )}
            <HelpCircle
              className="h-4 w-4 shrink-0 opacity-90"
              aria-label="Learn more about Resync Data"
              onClick={(e) => {
                e.stopPropagation();
                onHelp();
              }}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <span>{tooltipText}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
