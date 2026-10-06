"use client";

import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SystemHealthDrilldownView } from "@/lib/system-health-drilldown-view";

export default function WorkspaceSystemHealthPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  return (
    <div className="container mx-auto max-w-5xl space-y-6 px-4 py-8">
      {/* KAN-267: opened directly, this page dropped a reader into the run
          list with no way out but the browser's back button. Every sibling
          workspace page offers the same control, so this matches them rather
          than inventing a breadcrumb only this page would have. */}
      <Button
        variant="ghost"
        className="mb-2"
        onClick={() => router.replace(`/workspace/${params.id}`)}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Workspace
      </Button>

      <h1 className="text-2xl font-semibold tracking-tight">System Health</h1>
      <SystemHealthDrilldownView workspaceId={params.id} />
    </div>
  );
}
