'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { Header } from '@/components/ui/header';

type PageShellProps = {
  children: ReactNode;
  backLabel?: string;
  onBack?: () => void;
  showHeader?: boolean;
  className?: string;
};

export function PageShell({
  children,
  backLabel,
  onBack,
  showHeader = true,
  className,
}: PageShellProps) {
  return (
    <div className={`min-h-screen bg-background ${className ?? ''}`}>
      {showHeader ? <Header /> : null}
      <div className="container mx-auto animate-fade-in-up py-8">
        {backLabel && onBack ? (
          <Button
            variant="ghost"
            className="mb-6 print:hidden"
            onClick={onBack}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            <span>{backLabel}</span>
          </Button>
        ) : null}
        <div className="page-enter-stagger space-y-6">{children}</div>
      </div>
    </div>
  );
}

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

type StatCardProps = {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  valueClassName?: string;
};

export function StatCard({ label, value, icon, valueClassName }: StatCardProps) {
  return (
    <div className="stat-card rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className={`stat-value truncate text-2xl font-bold ${valueClassName ?? ''}`}>
            {value}
          </p>
        </div>
        {icon ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            {icon}
          </div>
        ) : null}
      </div>
    </div>
  );
}
