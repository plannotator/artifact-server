/** Interface languages, in the order the switcher lists them. */
export const locales = ["zh-TW", "en"] as const;

/** One interface language. */
export type Locale = (typeof locales)[number];

/** The language a reader gets until they choose another. */
export const defaultLocale: Locale = "zh-TW";

const storageKey = "artifact-review-locale";

/** Read the stored choice; anything unknown or unreadable is the default. */
function readLocale(): Locale {
  try {
    return window.localStorage.getItem(storageKey) === "en" ? "en" : defaultLocale;
  } catch {
    return defaultLocale;
  }
}

/**
 * The active language, fixed for the life of the page. Changing it reloads
 * the page, so every string in every module is read once, in one language.
 */
export const locale: Locale = readLocale();

/** BCP 47 tag for `<html lang>`, so assistive technology reads the right language. */
export const htmlLang = locale === "en" ? "en" : "zh-Hant-TW";

/**
 * Locale for Intl formatting. English keeps the browser's own locale, which
 * is what the interface did before it had a language setting.
 */
export const intlLocale: string | undefined = locale === "en" ? undefined : "zh-TW";

/** Store a new choice and reload so the whole interface reads in it. */
export function setLocale(next: Locale): void {
  try {
    window.localStorage.setItem(storageKey, next);
  } catch {
    return;
  }
  window.location.reload();
}

/**
 * What every translation must match: the same keys, plain strings
 * for strings, and functions with the same parameters for formatted text.
 */
export type Translation<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : T[K] extends string
      ? string
      : Translation<T[K]>;
};

/**
 * Declare one area's text in both languages and get the active one. English
 * is the key source; the Traditional Chinese table must match its shape.
 */
export function defineMessages<T extends Translation<T>>(table: {
  readonly en: T;
  readonly "zh-TW": Translation<T>;
}): Translation<T> {
  return locale === "en" ? table.en : table["zh-TW"];
}
