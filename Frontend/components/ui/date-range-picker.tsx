'use client';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';

const CURRENT_YEAR = new Date().getFullYear();
export const DATE_PICKER_FROM_YEAR = CURRENT_YEAR - 15;
export const DATE_PICKER_TO_YEAR = CURRENT_YEAR + 2;

type DateRangePickerProps = {
  label: string;
  value?: DateRange;
  onChange: (range: DateRange | undefined) => void;
  className?: string;
  align?: 'start' | 'center' | 'end';
  fromYear?: number;
  toYear?: number;
};

function formatRangeLabel(value: DateRange | undefined, fallback: string) {
  if (!value?.from) {
    return fallback;
  }

  if (value.to) {
    return `${format(value.from, 'dd/MM/yyyy')} - ${format(value.to, 'dd/MM/yyyy')}`;
  }

  return format(value.from, 'dd/MM/yyyy');
}

export function DateRangePicker({
  label,
  value,
  onChange,
  className,
  align = 'start',
  fromYear = DATE_PICKER_FROM_YEAR,
  toYear = DATE_PICKER_TO_YEAR,
}: DateRangePickerProps) {
  const hint =
    value?.from && !value?.to
      ? 'Select an end date to complete the range.'
      : 'Use the month and year menus to jump quickly, then pick start and end dates.';

  return (
    <div className={cn('flex shrink-0 items-center gap-1', className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-fit min-w-[200px] max-w-[280px] flex-shrink-0 justify-start text-left font-normal"
          >
            <span className="flex min-w-0 w-full items-center gap-2">
              <CalendarIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{formatRangeLabel(value, label)}</span>
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align={align}>
          <div className="flex flex-col">
            <Calendar
              mode="range"
              selected={value}
              onSelect={onChange}
              numberOfMonths={2}
              captionLayout="dropdown-buttons"
              fromYear={fromYear}
              toYear={toYear}
              defaultMonth={value?.from ?? new Date()}
              initialFocus
            />
            <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
              <p className="text-xs text-muted-foreground">{hint}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => onChange(undefined)}
                disabled={!value?.from}
              >
                <span>Clear</span>
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {value?.from ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(undefined)}
          className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          aria-label={`Clear ${label}`}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
