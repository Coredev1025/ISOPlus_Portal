"use client";

import { useParams } from "next/navigation";

import { SystemHealthDrilldownView } from "@/lib/system-health-drilldown-view";

export default function WorkspaceSystemHealthPage() {
  const params = useParams<{ id: string }>();

  return (
    <div className="container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">System Health</h1>
      <SystemHealthDrilldownView workspaceId={params.id} />
    </div>
  );
}
