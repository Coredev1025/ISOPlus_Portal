import { toast } from 'sonner';

export interface ToastOptions {
  duration?: number;
  description?: string;
}

/**
 * Show a success toast notification
 */
export const showSuccessToast = (message: string, options?: ToastOptions) => {
  toast.success(message, {
    duration: options?.duration || 4000,
    description: options?.description,
  });
};

/**
 * Show an error toast notification
 */
export const showErrorToast = (message: string, options?: ToastOptions) => {
  toast.error(message, {
    duration: options?.duration || 6000,
    description: options?.description,
  });
};

/**
 * Show an info toast notification
 */
export const showInfoToast = (message: string, options?: ToastOptions) => {
  toast.info(message, {
    duration: options?.duration || 4000,
    description: options?.description,
  });
};

/**
 * Show a warning toast notification
 */
export const showWarningToast = (message: string, options?: ToastOptions) => {
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