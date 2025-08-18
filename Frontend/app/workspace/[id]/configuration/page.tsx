"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Terminal, Link, CheckCircle, AlertCircle } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState } from "react";
import { useAppContext } from "@/app/context";
import axios from "@/app/utils/axiosConfig";
import { showFetchSuccessToast, showFetchErrorToast } from "@/lib/toast-utils";
import Spinner from "@/components/ui/spin";

// Function to decode HTML entities
const decodeHtmlEntities = (text: string): string => {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
};

export default function WorkspaceConfiguration() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const { workspaces, user } = useAppContext();
  const workspace = workspaces.find(w => w.id.toString() === id);
  const [isCheckingLinks, setIsCheckingLinks] = useState(false);
  const [isCreatingLinks, setIsCreatingLinks] = useState(false);
  const [checkResults, setCheckResults] = useState<any>(null);
  const [createResults, setCreateResults] = useState<any>(null);

  const handleCheckLinks = async () => {
    setIsCheckingLinks(true);
    setCheckResults(null);
    setCreateResults(null);
    try {
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/${id}/check-links`
      );
      setCheckResults(response.data);
      showFetchSuccessToast("Link check completed");
    } catch (error: any) {
      console.error("Error checking links:", error);
      showFetchErrorToast("link check", error.response?.data?.message || "Failed to check links");
    } finally {
      setIsCheckingLinks(false);
    }
  };

  const handleCreateLinks = async () => {
    setIsCreatingLinks(true);
    setCreateResults(null);
    setCheckResults(null);
    try {
      const response = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/${id}/create-links`
      );
      setCreateResults(response.data);
      showFetchSuccessToast("Links created successfully");
    } catch (error: any) {
      console.error("Error creating links:", error);
      showFetchErrorToast("link creation", error.response?.data?.message || "Failed to create links");
    } finally {
      setIsCreatingLinks(false);
    }
  };

  if (!workspace) {
    return <div>Loading...</div>;
  }

  // Check if user has permission to access this page
  const isOwnerOrSupport = user.role === "owner" || user.role === "support_admin";
  const isIsoPlusUserWithAdminOrOwner = user.role === "isoplus_user" && (workspace && (workspace.user_role === "admin" || workspace.user_role === "owner"));

  if (!isOwnerOrSupport && !isIsoPlusUserWithAdminOrOwner) {
    router.replace("/workspace/access-denied");
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6 hover:bg-secondary"
          onClick={() => router.push(`/workspace/${id}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Workspace
        </Button>

        <div className="space-y-6">
          {/* Header */}
          <Card className="p-6 shadow-lg card-hover">
            <div className="flex items-center gap-4">
              <div className="bg-primary/10 w-16 h-16 rounded-full flex items-center justify-center">
                <Terminal className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">
                  Workspace Configuration
                </h1>
                <p className="text-muted-foreground">
                  Configure workspace settings and manage board links
                </p>
              </div>
            </div>
          </Card>

          {/* Permission Info */}
          <Card className="p-6 shadow-lg">
            <div className="flex items-start gap-4">
              <AlertCircle className="h-6 w-6 text-amber-500 mt-1" />
              <div>
                <h3 className="text-lg font-semibold mb-2">Permission Required</h3>
                <p className="text-muted-foreground">
                  This feature is available to <strong>Owner</strong> and <strong>Support Admin</strong> users only.
                </p>
              </div>
            </div>
          </Card>

          {/* Dynamic Linking Actions */}
          <Card className="p-6 shadow-lg">
            <div className="flex items-start gap-4 mb-6">
              <Link className="h-6 w-6 text-primary mt-1" />
              <div>
                <h3 className="text-xl font-semibold mb-2">Dynamic Board Linking</h3>
                <p className="text-muted-foreground">
                  This tool updates links between workspace boards by replacing templates in format 
                  <code className="bg-muted px-2 py-1 rounded text-sm mx-1">
                    {'{{ Link Name > Board Name > Item Name or View Name }}'}
                  </code> 
                  with the appropriate links.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Button
                onClick={handleCheckLinks}
                disabled={isCheckingLinks}
                className="w-full h-16 text-lg"
                variant="outline"
              >
                {isCheckingLinks ? (
                  <>
                    <Spinner className="mr-2" />
                    Checking Links...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-5 w-5 mr-2" />
                    Check Links
                  </>
                )}
              </Button>

              <Button
                onClick={handleCreateLinks}
                disabled={isCreatingLinks}
                className="w-full h-16 text-lg"
              >
                {isCreatingLinks ? (
                  <>
                    <Spinner className="mr-2" />
                    Creating Links...
                  </>
                ) : (
                  <>
                    <Link className="h-5 w-5 mr-2" />
                    Create Links
                  </>
                )}
              </Button>
            </div>
          </Card>

          {/* Results Display */}
          {checkResults && (
            <Card className="p-6 shadow-lg">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                Link Check Results
              </h3>
              {Array.isArray(checkResults) && checkResults.length > 0 ? (
                <div className="space-y-3">
                  {checkResults.map((result, index) => (
                    <div key={index} className="border rounded-lg p-4 bg-card">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <h4 className="font-medium text-primary mb-2">Link Details</h4>
                          <div className="space-y-2 text-sm">
                            <div><span className="font-medium">Label:</span> {result.link?.label || 'N/A'}</div>
                            <div><span className="font-medium">Target Board:</span> {result.link?.targetBoardName || 'N/A'}</div>
                            <div><span className="font-medium">Target Name:</span> {result.link?.targetName || 'N/A'}</div>
                          </div>
                        </div>
                        <div>
                          <h4 className="font-medium text-primary mb-2">Original Match</h4>
                          <div className="text-sm">
                            <code className="bg-muted px-2 py-1 rounded text-xs break-all">
                              {decodeHtmlEntities(result.originalMatch || 'N/A')}
                            </code>
                          </div>
                        </div>
                      </div>
                      {result.originItem && (
                        <div className="mt-3 pt-3 border-t">
                          <div className="text-sm">
                            <span className="font-medium">Origin Item:</span>
                            <a 
                              href={result.originItem} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-800 underline ml-2 break-all"
                            >
                              {result.originItem}
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="h-12 w-12 mx-auto mb-3 text-green-500" />
                  <p>No links found to check</p>
                </div>
              )}
            </Card>
          )}

          {createResults && (
            <Card className="p-6 shadow-lg">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Link className="h-5 w-5 text-blue-500" />
                Link Creation Results
              </h3>
              {Array.isArray(createResults) && createResults.length > 0 ? (
                <div className="space-y-3">
                  {createResults.map((result, index) => (
                    <div key={index} className="border rounded-lg p-4 bg-card">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <h4 className="font-medium text-primary mb-2">Link Details</h4>
                          <div className="space-y-2 text-sm">
                            <div><span className="font-medium">Label:</span> {result.link?.label || 'N/A'}</div>
                            <div><span className="font-medium">Target Board:</span> {result.link?.targetBoardName || 'N/A'}</div>
                            <div><span className="font-medium">Target Name:</span> {result.link?.targetName || 'N/A'}</div>
                          </div>
                        </div>
                        <div>
                          <h4 className="font-medium text-primary mb-2">Original Match</h4>
                          <div className="text-sm">
                            <code className="bg-muted px-2 py-1 rounded text-xs break-all">
                              {decodeHtmlEntities(result.originalMatch || 'N/A')}
                            </code>
                          </div>
                        </div>
                      </div>
                      {result.originItem && (
                        <div className="mt-3 pt-3 border-t">
                          <div className="text-sm">
                            <span className="font-medium">Origin Item:</span>
                            <a 
                              href={result.originItem} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-800 underline ml-2 break-all"
                            >
                              {result.originItem}
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Link className="h-12 w-12 mx-auto mb-3 text-blue-500" />
                  <p>No links were created</p>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
