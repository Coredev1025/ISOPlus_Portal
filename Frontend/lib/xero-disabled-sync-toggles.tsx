"use client";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

const SYNC_TOGGLES = [
  {
    title: "Invoice Sync Status",
    description: "Sync invoices between ISO+ and Xero",
  },
  {
    title: "Customer Sync Status",
    description: "Sync customers between ISO+ and Xero",
  },
  {
    title: "Payment Sync Status",
    description: "Sync payments between ISO+ and Xero",
  },
  {
    title: "Contact Sync",
    description: "Sync contacts between ISO+ and Xero",
    optional: true,
  },
] as const;

export function XeroDisabledSyncToggles() {
  return (
    <div className="space-y-0">
      {SYNC_TOGGLES.map((item) => (
        <div
          key={item.title}
          className="flex items-start justify-between gap-4 border-t py-3 first:border-t-0 first:pt-0"
        >
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
              <span>{item.title}</span>
              <Badge variant="secondary" className="text-[10px] uppercase">
                coming soon
              </Badge>
              {"optional" in item && item.optional ? (
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {item.description}
            </p>
          </div>
          <Switch checked={false} disabled aria-label={item.title} />
        </div>
      ))}
    </div>
  );
}
