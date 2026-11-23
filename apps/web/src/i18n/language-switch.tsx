import {Button} from "@/components/ui/button";
import {commonText} from "./messages/common.ts";
import {locale, setLocale} from "./locale.ts";

/** One button that switches the interface to the other language and reloads. */
export function LanguageSwitch() {
  return (
    <Button
      aria-label={commonText.language.switchToLabel}
      lang={locale === "en" ? "zh-Hant-TW" : "en"}
      onClick={() => setLocale(locale === "en" ? "zh-TW" : "en")}
      size="sm"
      title={commonText.language.switchToLabel}
      type="button"
      variant="ghost"
    >
      {commonText.language.switchTo}
    </Button>
  );
}
