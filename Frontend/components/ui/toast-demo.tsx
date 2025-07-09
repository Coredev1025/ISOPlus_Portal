'use client';

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { 
  showSuccessToast, 
  showErrorToast, 
  showInfoToast, 
  showWarningToast, 
  showLoadingToast,
  showFetchSuccessToast,
  showFetchErrorToast,
  showSaveSuccessToast,
  showSaveErrorToast,
  dismissToast,
  dismissAllToasts
} from "@/lib/toast-utils";

export function ToastDemo() {
  const handleSuccessToast = () => {
    showSuccessToast("Operation completed successfully!");
  };

  const handleErrorToast = () => {
    showErrorToast("Something went wrong!", { 
      description: "Please check your input and try again." 
    });
  };

  const handleInfoToast = () => {
    showInfoToast("Information", { 
      description: "This is an informational message." 
    });
  };

  const handleWarningToast = () => {
    showWarningToast("Warning", { 
      description: "Please review your settings before proceeding." 
    });
  };

  const handleLoadingToast = () => {
    const loadingToastId = showLoadingToast("Processing your request...");
    
    // Simulate async operation
    setTimeout(() => {
      dismissToast(loadingToastId);
      showSuccessToast("Request completed!");
    }, 3000);
  };

  const handleFetchSuccess = () => {
    showFetchSuccessToast("User data");
  };

  const handleFetchError = () => {
    showFetchErrorToast("user data", "Network connection failed");
  };

  const handleSaveSuccess = () => {
    showSaveSuccessToast("User profile");
  };

  const handleSaveError = () => {
    showSaveErrorToast("user profile", "Validation failed: Email is required");
  };

  const handleDismissAll = () => {
    dismissAllToasts();
  };

  return (
    <Card className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Toast Notifications Demo</h2>
      
      <div className="grid grid-cols-2 gap-4">
        <Button onClick={handleSuccessToast} variant="default">
          Success Toast
        </Button>
        
        <Button onClick={handleErrorToast} variant="destructive">
          Error Toast
        </Button>
        
        <Button onClick={handleInfoToast} variant="outline">
          Info Toast
        </Button>
        
        <Button onClick={handleWarningToast} variant="outline">
          Warning Toast
        </Button>
        
        <Button onClick={handleLoadingToast} variant="outline">
          Loading Toast
        </Button>
        
        <Button onClick={handleDismissAll} variant="outline">
          Dismiss All
        </Button>
      </div>

      <div className="mt-8">
        <h3 className="text-lg font-semibold mb-4">Data Operation Toasts</h3>
        <div className="grid grid-cols-2 gap-4">
          <Button onClick={handleFetchSuccess} variant="outline">
            Fetch Success
          </Button>
          
          <Button onClick={handleFetchError} variant="outline">
            Fetch Error
          </Button>
          
          <Button onClick={handleSaveSuccess} variant="outline">
            Save Success
          </Button>
          
          <Button onClick={handleSaveError} variant="outline">
            Save Error
          </Button>
        </div>
      </div>

      <div className="mt-6 p-4 bg-muted rounded-lg">
        <h4 className="font-semibold mb-2">Usage Examples:</h4>
        <div className="text-sm space-y-2">
          <p><strong>Success:</strong> <code>showSuccessToast(&quot;Data saved successfully&quot;)</code></p>
          <p><strong>Error:</strong> <code>showErrorToast(&quot;Save failed&quot;, {"{ description: 'Network error' }"})</code></p>
          <p><strong>Fetch Success:</strong> <code>showFetchSuccessToast(&quot;Users&quot;)</code></p>
          <p><strong>Fetch Error:</strong> <code>showFetchErrorToast(&quot;users&quot;, &quot;API timeout&quot;)</code></p>
          <p><strong>Save Success:</strong> <code>showSaveSuccessToast(&quot;User profile&quot;)</code></p>
          <p><strong>Save Error:</strong> <code>showSaveErrorToast(&quot;user profile&quot;, &quot;Validation failed&quot;)</code></p>
        </div>
      </div>
    </Card>
  );
} 