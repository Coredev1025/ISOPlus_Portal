import { toast } from 'sonner';

export interface ToastOptions {
  duration?: number;
  description?: string;
}

// Track recent toasts to prevent duplicates
const recentToasts = new Map<string, number>();
const DEDUPE_WINDOW_MS = 2000; // Prevent same toast within 2 seconds

const getToastKey = (message: string, description?: string) => {
  return `${message}|${description || ''}`;
};

const isDuplicate = (key: string): boolean => {
  const lastShown = recentToasts.get(key);
  if (!lastShown) return false;
  const now = Date.now();
  if (now - lastShown < DEDUPE_WINDOW_MS) {
    return true;
  }
  return false;
};

const recordToast = (key: string) => {
  recentToasts.set(key, Date.now());
  // Clean up old entries (older than 5 seconds)
  const now = Date.now();
  const keysToDelete: string[] = [];
  recentToasts.forEach((timestamp, k) => {
    if (now - timestamp > 5000) {
      keysToDelete.push(k);
    }
  });
  keysToDelete.forEach(k => recentToasts.delete(k));
};

/**
 * Show a success toast notification
 */
export const showSuccessToast = (message: string, options?: ToastOptions) => {
  if (!message || message.trim() === '') {
    console.warn('showSuccessToast called with empty message');
    return;
  }
  const key = getToastKey(message, options?.description);
  if (isDuplicate(key)) {
    return; // Skip duplicate toast
  }
  recordToast(key);
  toast.success(message, {
    duration: options?.duration || 4000,
    description: options?.description,
  });
};

/**
 * Show an error toast notification
 */
export const showErrorToast = (message: string, options?: ToastOptions) => {
  if (!message || message.trim() === '') {
    console.warn('showErrorToast called with empty message');
    return;
  }
  const key = getToastKey(message, options?.description);
  if (isDuplicate(key)) {
    return; // Skip duplicate toast
  }
  recordToast(key);
  toast.error(message, {
    duration: options?.duration || 6000,
    description: options?.description,
  });
};

/**
 * Show an info toast notification
 */
export const showInfoToast = (message: string, options?: ToastOptions) => {
  if (!message || message.trim() === '') {
    console.warn('showInfoToast called with empty message');
    return;
  }
  const key = getToastKey(message, options?.description);
  if (isDuplicate(key)) {
    return; // Skip duplicate toast
  }
  recordToast(key);
  toast.info(message, {
    duration: options?.duration || 4000,
    description: options?.description,
  });
};

/**
 * Show a warning toast notification
 */
export const showWarningToast = (message: string, options?: ToastOptions) => {
  if (!message || message.trim() === '') {
    console.warn('showWarningToast called with empty message');
    return;
  }
  const key = getToastKey(message, options?.description);
  if (isDuplicate(key)) {
    return; // Skip duplicate toast
  }
  recordToast(key);
  toast.warning(message, {
    duration: options?.duration || 5000,
    description: options?.description,
  });
};

/**
 * Show a loading toast notification
 */
export const showLoadingToast = (message: string) => {
  return toast.loading(message);
};

/**
 * Dismiss a specific toast
 */
export const dismissToast = (toastId: string | number) => {
  toast.dismiss(toastId);
};

/**
 * Dismiss all toasts
 */
export const dismissAllToasts = () => {
  toast.dismiss();
};

/**
 * Show a toast for successful data fetch
 */
export const showFetchSuccessToast = (resource: string) => {
  showSuccessToast(`${resource} loaded successfully`);
};

/**
 * Show a toast for failed data fetch
 */
export const showFetchErrorToast = (resource: string, error?: string) => {
  showErrorToast(`Failed to load ${resource}`, {
    description: error || 'Please try again later',
  });
};

/**
 * Show a toast for successful data save
 */
export const showSaveSuccessToast = (resource: string) => {
  showSuccessToast(`${resource} saved successfully`);
};

/**
 * Show a toast for failed data save
 */
export const showSaveErrorToast = (resource: string, error?: string) => {
  showErrorToast(`Failed to save ${resource}`, {
    description: error || 'Please check your input and try again',
  });
};

/**
 * Show a toast for successful data update
 */
export const showUpdateSuccessToast = (resource: string) => {
  showSuccessToast(`${resource} updated successfully`);
};

/**
 * Show a toast for failed data update
 */
export const showUpdateErrorToast = (resource: string, error?: string) => {
  showErrorToast(`Failed to update ${resource}`, {
    description: error || 'Please check your input and try again',
  });
};

/**
 * Show a toast for successful data deletion
 */
export const showDeleteSuccessToast = (resource: string) => {
  showSuccessToast(`${resource} deleted successfully`);
};

/**
 * Show a toast for failed data deletion
 */
export const showDeleteErrorToast = (resource: string, error?: string) => {
  showErrorToast(`Failed to delete ${resource}`, {
    description: error || 'Please try again later',
  });
};

type AxiosLikeError = {
  response?: {
    status?: number;
    data?: {
      message?: string;
      error?: string;
    };
  };
  message?: string;
};

export const getApiErrorMessage = (
  err: unknown,
  fallback = 'Something went wrong. Please try again.'
): string => {
  const error = err as AxiosLikeError;
  const serverMessage = error.response?.data?.message || error.response?.data?.error;
  if (typeof serverMessage === 'string' && serverMessage.trim()) {
    return serverMessage.trim();
  }

  const status = error.response?.status;
  if (status === 401) {
    return 'Your session has expired. Please sign in again, then try the export again.';
  }
  if (status === 403) {
    return 'You do not have permission to perform this export. Contact your workspace administrator if you need access.';
  }

  const clientMessage = typeof error.message === 'string' ? error.message.trim() : '';
  if (clientMessage) {
    if (/request failed with status code \d+/i.test(clientMessage)) {
      return fallback;
    }
    if (/network error/i.test(clientMessage)) {
      return 'Unable to reach the server. Check your internet connection and try again.';
    }
    return clientMessage;
  }

  return fallback;
}; 