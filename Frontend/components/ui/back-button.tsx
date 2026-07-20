'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ArrowLeft } from 'lucide-react';

type BackButtonProps = {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
};

export function BackButton({ onClick, children, className }: BackButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        'mb-6 text-muted-foreground hover:bg-muted/50 hover:text-muted-foreground active:scale-100 hover:translate-y-0 print:hidden',
        className
      )}
      onClick={onClick}
    >
      <ArrowLeft className="mr-2 h-4 w-4" />
      <span>{children}</span>
    </Button>
  );
}
