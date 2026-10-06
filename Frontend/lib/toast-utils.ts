import Toastify from 'toastify-js';

export interface ToastOptions {
  duration?: number;
  description?: string;
}

type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading';

type ToastInstance = ReturnType<typeof Toastify>;

// Track recent toasts to prevent duplicates
const recentToasts = new Map<string, number>();
const DEDUPE_WINDOW_MS = 2000; // Prevent same toast within 2 seconds

let nextToastId = 1;
const activeToasts = new Map<number, ToastInstance>();

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

const TOAST_BACKGROUNDS: Record<ToastType, string> = {
  success: '#16a34a', // green-600
  error: '#dc2626', // red-600
  info: '#2563eb', // blue-600
  warning: '#d97706', // amber-600
  loading: '#334155', // slate-700
};

const baseStyle = (type: ToastType): { [cssRule: string]: string } => ({
  background: TOAST_BACKGROUNDS[type],
  color: '#ffffff',
  borderRadius: '8px',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  fontFamily: 'inherit',
  fontSize: '0.9rem',
  padding: '12px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
});

const buildNode = (message: string, description?: string): HTMLElement => {
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '2px';
  container.style.textAlign = 'left';

  const title = document.createElement('span');
  title.textContent = message;
  title.style.fontWeight = '600';
  container.appendChild(title);

  if (description) {
    const desc = document.createElement('span');
    desc.textContent = description;
    desc.style.fontSize = '0.8rem';
    desc.style.opacity = '0.9';
    container.appendChild(desc);
  }

  return container;
};

interface ShowToastConfig {
  type: ToastType;
  message: string;
  description?: string;
  duration: number;
}

const showToast = ({
  type,
  message,
  description,
  duration,
}: ShowToastConfig): number => {
  const id = nextToastId++;

  const instance = Toastify({
    node: buildNode(message, description),
    duration,
    gravity: 'bottom',
    position: 'right',
    close: true,
    stopOnFocus: true,
    style: baseStyle(type),
    className: `isoplus-toast isoplus-toast-${type}`,
    callback: () => {
      activeToasts.delete(id);
    },
  });

  activeToasts.set(id, instance);
  instance.showToast();
  return id;
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
  return showToast({
    type: 'success',
    message,
    description: options?.description,
    duration: options?.duration ?? 4000,
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
  return showToast({
    type: 'error',
    message,
    description: options?.description,
    duration: options?.duration ?? 6000,
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
  return showToast({
    type: 'info',
    message,
    description: options?.description,
    duration: options?.duration ?? 4000,
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
  return showToast({
    type: 'warning',
    message,
    description: options?.description,
    duration: options?.duration ?? 5000,
  });
};

/**
 * Show a loading toast notification. Stays visible until dismissed via the
 * returned id (duration -1 keeps it on screen).
 */
export const showLoadingToast = (message: string): number => {
  return showToast({
    type: 'loading',
    message,
    duration: -1,
  });
};

/**
 * Dismiss a specific toast by the id returned from a show* helper
 */
export const dismissToast = (toastId: number) => {
  const instance = activeToasts.get(toastId);
  if (instance) {
    instance.hideToast();
    activeToasts.delete(toastId);
  }
};

export const dismissAllToasts = () => {
  activeToasts.forEach((instance) => {
    instance.hideToast();
  });
  activeToasts.clear();
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

function readServerErrorMessage(error: AxiosLikeError): string | undefined {
  const serverMessage = error.response?.data?.message || error.response?.data?.error;
  if (typeof serverMessage === 'string' && serverMessage.trim()) {
    return serverMessage.trim();
  }
  return undefined;
}

function readStatusFallback(status: number | undefined): string | undefined {
  if (status === 401) {
    return 'Your session has expired. Please sign in again, then try the export again.';
  }
  if (status === 403) {
    return 'You do not have permission to perform this export. Contact your workspace administrator if you need access.';
  }
  return undefined;
}

function readClientErrorMessage(error: AxiosLikeError, fallback: string): string | undefined {
  const clientMessage = typeof error.message === 'string' ? error.message.trim() : '';
  if (!clientMessage) return undefined;
  if (/request failed with status code \d+/i.test(clientMessage)) return fallback;
  if (/network error/i.test(clientMessage)) {
    return 'Unable to reach the server. Check your internet connection and try again.';
  }
  return clientMessage;
}

export const getApiErrorMessage = (
  err: unknown,
  fallback = 'Something went wrong. Please try again.'
): string => {
  const error = err as AxiosLikeError;
  return (
    readServerErrorMessage(error) ||
    readStatusFallback(error.response?.status) ||
    readClientErrorMessage(error, fallback) ||
    fallback
  );
};
