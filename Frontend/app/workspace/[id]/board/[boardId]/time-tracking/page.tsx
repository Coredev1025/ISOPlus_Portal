"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Clock } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import { Header } from "@/components/ui/header";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useAppContext } from "@/app/context";

export default function TimeTrackingPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [timeTrackingEnabled, setTimeTrackingEnabled] = useState(false);
  const { workspaces, boards } = useAppContext();
  const id = pathname.split("/")[2];
  const boardId = pathname.split("/")[4];
  
  const workspace = workspaces.find(workspace => workspace.id.toString() === id);
  const board = boards.find(b => b.id === boardId);

  if (!workspace || !board) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Board
        </Button>

        <div className="space-y-6 max-w-2xl mx-auto">
          <Card className="p-6">
            <div className="text-center space-y-4 mb-6">
              <div className="bg-primary/10 w-16 h-16 rounded-full flex items-center justify-center mx-auto">
                <Clock className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">Time Tracking Configuration</h1>
              <p className="text-muted-foreground max-w-md mx-auto">
                Configure time tracking settings for tasks in this board
              </p>
            </div>

            <div className="space-y-6">
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="space-y-0.5">
                  <Label className="text-base">Enable Time Tracking</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow users to track time on tasks within this board
                  </p>
                </div>
                <Switch
                  checked={timeTrackingEnabled}
                  onCheckedChange={setTimeTrackingEnabled}
                />
              </div>

              {timeTrackingEnabled && (
                <div className="bg-muted/30 p-4 rounded-lg">
                  <div className="flex items-start gap-3">
                    <Clock className="h-5 w-5 text-primary mt-0.5" />
                    <div>
                      <h3 className="text-sm font-medium">Time Tracking is Enabled</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        Users can now track time on tasks within this board. Time entries will be available for reporting and can be exported to integrated systems.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {!timeTrackingEnabled && (
                <div className="bg-muted/30 p-4 rounded-lg">
                  <div className="flex items-start gap-3">
                    <Clock className="h-5 w-5 text-muted-foreground mt-0.5" />
                    <div>
                      <h3 className="text-sm font-medium">Time Tracking is Disabled</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        Enable time tracking to allow users to log time against tasks in this board. This is useful for billing, reporting, and productivity analysis.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-4">
                <Button size="lg">Save Configuration</Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}