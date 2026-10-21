import {
  Button,
  Checkbox,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  ToggleGroup,
  ToggleGroupItem,
  useLang,
} from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState, useSyncExternalStore } from "react";

import { decades } from "@/data";
import { isUnnamed } from "@/shared/lib/names";
import type { Country, StormSummary } from "@/shared/model/types";
import { useStormName } from "@/shared/ui/use-storm-name";

import { type CategoryFilter, categoryOf, searchStorms, unnamedStats } from "./picker-model";

/** Results rendered at once; typing or a filter narrows the rest. */
const LIMIT = 60;

// Full-screen sheet on phones and touch screens, popover with a fine pointer on a wide screen (standing rule 6b:
// never width alone; re-checked when the media queries change).
const PHONE = "(max-width: 767px), (pointer: coarse)";
function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia(PHONE);
      m.addEventListener("change", fn);
      return () => m.removeEventListener("change", fn);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function ResultRow({ s }: { s: StormSummary }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const stormName = useStormName();
  const named = !isUnnamed(s.name);
  const local = [named ? s.localNames?.ph : undefined, lang === "ja" ? s.localNames?.ja : undefined].filter(Boolean).join(" · ");
  const cat = categoryOf(s);
  return (
    <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span>
        <b className="font-semibold">{named ? s.name : stormName(s)}</b>
        {local ? <span className="text-muted-foreground"> · {local}</span> : null}
        <span className="font-mono text-muted-foreground"> · {s.season}</span>
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {[
          cat ? t`Cat ${cat}` : undefined,
          s.peakWindKt !== undefined ? `${s.peakWindKt} kt` : undefined,
          s.landfallCountries.join(" ") || undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </span>
  );
}

function PickerBody({ storms, onPick }: { storms: readonly StormSummary[]; onPick: (sid: string) => void }) {
  const { t } = useLingui();
  const id = useId();
  const [q, setQ] = useState("");
  const [decade, setDecade] = useState("");
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [includeUnnamed, setIncludeUnnamed] = useState(false);
  const decadeList = useMemo(() => decades(storms), [storms]);
  const stats = useMemo(() => unnamedStats(storms), [storms]);
  const res = useMemo(
    () =>
      searchStorms(storms, {
        q,
        includeUnnamed,
        decade: decade ? Number(decade) : undefined,
        country: (country || undefined) as Country | undefined,
        category: (category || undefined) as CategoryFilter | undefined,
      }),
    [storms, q, includeUnnamed, decade, country, category],
  );
  const shown = res.storms.slice(0, LIMIT);
  const n = res.storms.length;
  const hidden = res.hiddenUnnamed;
  const count = n === 0 ? t`No storms found` : n > LIMIT ? t`${n} storms found, showing the newest ${LIMIT}` : t`${n} storms found`;
  const { count: unnamed, before1980 } = stats;
  const chip = "h-8 rounded-full px-3 text-xs";

  return (
    <Command shouldFilter={false} label={t`Search storms`} className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] gap-2 bg-transparent">
      <CommandInput value={q} onValueChange={setQ} placeholder={t`Name, PAGASA name, 台風第…号, year or ID`} aria-label={t`Search storms`} />
      <div className="grid gap-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span id={`${id}-dec`} className="w-16 font-mono uppercase tracking-wider text-muted-foreground">{t`Decade`}</span>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} className="flex-wrap" value={decade} onValueChange={setDecade} aria-labelledby={`${id}-dec`}>
            {[...decadeList].reverse().map((d) => (
              <ToggleGroupItem key={d} value={String(d)} className={chip}>
                {t`${d}s`}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span id={`${id}-lf`} className="w-16 font-mono uppercase tracking-wider text-muted-foreground">{t`Landfall`}</span>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={country} onValueChange={setCountry} aria-labelledby={`${id}-lf`}>
            <ToggleGroupItem value="PH" className={chip}>{t`Philippines`}</ToggleGroupItem>
            <ToggleGroupItem value="JP" className={chip}>{t`Japan`}</ToggleGroupItem>
          </ToggleGroup>
          <span id={`${id}-cat`} className="ml-2 font-mono uppercase tracking-wider text-muted-foreground">{t`Category`}</span>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={category} onValueChange={setCategory} aria-labelledby={`${id}-cat`}>
            <ToggleGroupItem value="5" className={chip}>5</ToggleGroupItem>
            <ToggleGroupItem value="4+" className={chip}>4+</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="picker-count">
        {count}
        {hidden && !includeUnnamed ? ` · ${t`${hidden} unnamed hidden`}` : ""}
      </p>
      <CommandList className="max-h-none min-h-0 overflow-y-auto sm:max-h-80" data-testid="picker-results">
        <CommandEmpty>{t`No storm matches. Try a year, a PAGASA name or 台風第…号.`}</CommandEmpty>
        {shown.map((s) => (
          <CommandItem key={s.sid} value={s.sid} onSelect={() => onPick(s.sid)} className="px-2 py-2 text-sm">
            <ResultRow s={s} />
          </CommandItem>
        ))}
      </CommandList>
      <div className="flex items-center gap-2 border-t border-border pt-2">
        <Checkbox id={`${id}-unnamed`} checked={includeUnnamed} onCheckedChange={(v) => setIncludeUnnamed(v === true)} />
        <Label htmlFor={`${id}-unnamed`} className="text-xs font-normal text-muted-foreground">
          {before1980 * 2 > unnamed ? t`Include unnamed storms (${unnamed}, mostly before 1980)` : t`Include unnamed storms (${unnamed})`}
        </Label>
      </div>
    </Command>
  );
}

/** "Change storm": a search popover on desktop, a full-screen sheet on phones. */
export function StormPicker({ slot, storms, onPick, hasValue }: { slot: "A" | "B"; storms: readonly StormSummary[]; onPick: (sid: string) => void; hasValue: boolean }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const phone = usePhoneLayout();
  const pick = (sid: string) => {
    onPick(sid);
    setOpen(false);
  };
  const title = slot === "A" ? t`Choose storm A` : t`Choose storm B`;
  const trigger = (
    <Button variant="outline" size="sm" className="justify-self-start rounded-full" aria-label={hasValue ? (slot === "A" ? t`Change storm A` : t`Change storm B`) : title}>
      {hasValue ? t`Change storm` : t`Choose a storm`}
    </Button>
  );
  const body = <PickerBody storms={storms} onPick={pick} />;
  if (phone)
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="flex h-dvh max-h-dvh flex-col gap-2 p-4">
          <SheetHeader className="p-0">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription className="sr-only">{t`Search by name, PAGASA name, Japanese number, year or ID, then pick a storm.`}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">{body}</div>
        </SheetContent>
      </Sheet>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(36rem,calc(100vw-2rem))] p-3" aria-label={title}>
        {body}
      </PopoverContent>
    </Popover>
  );
}
