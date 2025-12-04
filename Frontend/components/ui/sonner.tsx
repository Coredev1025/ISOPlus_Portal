'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner } from 'sonner';
import { useEffect } from 'react';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  useEffect(() => {
    // Add observer to set animation duration based on toast type and custom duration
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement && node.hasAttribute('data-sonner-toast')) {
            const toast = node as HTMLElement;
            // Try to get duration from data attribute or aria-label (Sonner may set this)
            let duration: number | null = null;
            
            // Check for data-duration attribute
            const dataDuration = toast.getAttribute('data-duration');
            if (dataDuration) {
              duration = parseInt(dataDuration, 10);
            }
            
            // If no duration found, use defaults based on toast type
            if (!duration || isNaN(duration)) {
              const type = toast.getAttribute('data-type');
              duration = type === 'error' ? 6000 : type === 'warning' ? 5000 : 4000;
            }
            
            toast.style.setProperty('--toast-duration', `${duration}ms`);
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, []);

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg relative overflow-hidden',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          closeButton:
            'opacity-100 !opacity-100 hover:opacity-100 group-[.toast]:opacity-100 group-[.toast]:hover:opacity-100',
          success:
            'group-[.toaster]:bg-green-50 group-[.toaster]:border-green-200 group-[.toaster]:text-green-900 dark:group-[.toaster]:bg-green-950 dark:group-[.toaster]:border-green-800 dark:group-[.toaster]:text-green-100',
          error:
            'group-[.toaster]:bg-red-50 group-[.toaster]:border-red-200 group-[.toaster]:text-red-900 dark:group-[.toaster]:bg-red-950 dark:group-[.toaster]:border-red-800 dark:group-[.toaster]:text-red-100',
          warning:
            'group-[.toaster]:bg-yellow-50 group-[.toaster]:border-yellow-200 group-[.toaster]:text-yellow-900 dark:group-[.toaster]:bg-yellow-950 dark:group-[.toaster]:border-yellow-800 dark:group-[.toaster]:text-yellow-100',
          info:
            'group-[.toaster]:bg-blue-50 group-[.toaster]:border-blue-200 group-[.toaster]:text-blue-900 dark:group-[.toaster]:bg-blue-950 dark:group-[.toaster]:border-blue-800 dark:group-[.toaster]:text-blue-100',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
