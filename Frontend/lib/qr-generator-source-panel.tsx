'use client';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { QrCode, FileText, File, Link2, ChevronDown } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import Spinner from '@/components/ui/spin';
import { filterFormDocumentRows, resolveQrTargetUrl } from '@/lib/qr-generator-helpers';
import { getQrSelectionButtonLabel } from '@/lib/qr-generator-ui-helpers';
import { hasBusinessLogo } from '@/lib/business-logo';

type FormOrDocument = {
  id: string;
  name: string;
  url: string;
  type: 'form' | 'document';
};

type Business = {
  defaultLogo?: string;
  squareLogo?: string;
  wideLogo?: string;
};

export function QrGeneratorSourcePanel({
  items,
  business,
  selectedId,
  customUrl,
  customUrlSelectionId,
  comboOpen,
  setComboOpen,
  setSelectedId,
  setCustomUrl,
  drawLogo,
  setDrawLogo,
  generating,
  generateQRCode,
}: {
  items: FormOrDocument[];
  business?: Business;
  selectedId: string;
  customUrl: string;
  customUrlSelectionId: string;
  comboOpen: boolean;
  setComboOpen: (open: boolean) => void;
  setSelectedId: (id: string) => void;
  setCustomUrl: (url: string) => void;
  drawLogo: boolean;
  setDrawLogo: (value: boolean) => void;
  generating: boolean;
  generateQRCode: () => void;
}) {
  const filterFormDocumentRowsLocal = (value: string, search: string) =>
    filterFormDocumentRows(value, search, customUrlSelectionId, items);

  const selectionLabel = getQrSelectionButtonLabel(selectedId, customUrl, customUrlSelectionId, items);

  return (
    <Card className="p-6 space-y-6">
      <div>
        <h2
          id="qr-generator-source-heading"
          className="text-xl font-semibold text-foreground tracking-tight mb-3"
        >
          Choose a form, document, or custom link to generate a QR code
        </h2>
        {selectedId !== customUrlSelectionId ? (
          <p className="text-sm text-muted-foreground mb-4">
            <span className="font-medium text-foreground">NOTE:</span> A QR code can be generated once the
            sharing feature is enabled for the relevant form or document.
          </p>
        ) : null}
        <div className="space-y-4">
          <div className="space-y-2">
            <Popover open={comboOpen} onOpenChange={setComboOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={comboOpen}
                  aria-labelledby="qr-generator-source-heading"
                  className="w-full justify-between font-normal h-11 rounded-lg border-border/80 bg-background shadow-sm hover:bg-accent/50"
                >
                  {selectionLabel.kind === 'custom' ? (
                    <span className="flex items-center gap-2 truncate">
                      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">Custom URL{selectionLabel.suffix}</span>
                    </span>
                  ) : selectionLabel.kind === 'item' ? (
                    <span className="flex items-center gap-2 truncate">
                      {selectionLabel.item.name}
                      {selectionLabel.item.type === 'document' ? (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </span>
                  ) : (
                    selectionLabel.text
                  )}
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[var(--radix-popover-trigger-width)] p-0 shadow-lg border-border/80 rounded-xl overflow-hidden"
                align="start"
              >
                <Command filter={filterFormDocumentRowsLocal} shouldFilter>
                  <CommandInput placeholder="Search by name, id, URL, or type…" className="h-11" />
                  <CommandList className="max-h-[min(320px,50vh)]">
                    <CommandEmpty className="py-8 text-muted-foreground text-sm">
                      No form or document matches your search.
                    </CommandEmpty>
                    <CommandGroup className="p-1.5">
                      <CommandItem
                        value={customUrlSelectionId}
                        keywords={['custom', 'url', 'link', 'paste', 'own']}
                        onSelect={() => {
                          setSelectedId(customUrlSelectionId);
                          setComboOpen(false);
                        }}
                        className="rounded-md py-2.5 border-b border-border/60 mb-1"
                      >
                        <span className="flex w-full min-w-0 items-center gap-2">
                          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 font-medium text-foreground">Custom URL</span>
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/90">
                            Paste link
                          </span>
                        </span>
                      </CommandItem>
                      {items.map((item) => (
                        <CommandItem
                          key={String(item.id)}
                          value={String(item.id)}
                          keywords={[item.name, String(item.id), item.url, item.type].filter(Boolean) as string[]}
                          onSelect={(value) => {
                            setSelectedId(value);
                            setCustomUrl('');
                            setComboOpen(false);
                          }}
                          className="rounded-md py-2.5"
                        >
                          <span className="flex w-full min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.name}</span>
                            <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                              {item.type === 'document' ? (
                                <FileText className="h-4 w-4" aria-hidden />
                              ) : (
                                <File className="h-4 w-4" aria-hidden />
                              )}
                              <span className="hidden sm:inline text-[10px] font-medium uppercase tracking-wide text-muted-foreground/90">
                                {item.type === 'document' ? 'Doc' : 'Form'}
                              </span>
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {selectedId ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
                onClick={() => {
                  setSelectedId('');
                  setCustomUrl('');
                }}
              >
                Clear selection
              </Button>
            ) : null}
          </div>

          {selectedId === customUrlSelectionId ? (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <h3 className="text-base font-semibold text-foreground">Copy the Link</h3>
              <p className="text-sm text-muted-foreground">
                Copy any link and paste it into the box below to generate a QR code.
              </p>
              <div className="space-y-2 pt-1">
                <Label htmlFor="custom-qr-url" className="sr-only">
                  Link to encode in QR code
                </Label>
                <Input
                  id="custom-qr-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/your-page"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="font-mono text-sm bg-background"
                  autoComplete="off"
                />
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="drawLogo"
                checked={drawLogo}
                onCheckedChange={(checked: boolean | 'indeterminate') => setDrawLogo(checked === true)}
                disabled={!hasBusinessLogo(business)}
              />
              <Label htmlFor="drawLogo" className="text-sm font-medium">
                Include your business logo in the QR code
              </Label>
            </div>
            {!hasBusinessLogo(business) && (
              <p className="text-xs text-muted-foreground ml-6">
                No business logo available. Upload a logo in business settings to enable this option.
              </p>
            )}
          </div>

          <Button
            type="button"
            variant="destructive"
            onClick={generateQRCode}
            disabled={generating || !resolveQrTargetUrl(selectedId, customUrl, customUrlSelectionId, items)}
            className="w-full"
          >
            {generating ? (
              <>
                <Spinner className="mr-2" />
                Generating QR Code...
              </>
            ) : (
              <>
                <QrCode className="mr-2 h-4 w-4" />
                Generate QR Code
              </>
            )}
          </Button>
        </div>
      </div>
    </Card>
  );
}
