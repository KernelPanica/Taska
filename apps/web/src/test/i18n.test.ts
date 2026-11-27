import { describe, expect, test } from "vitest";
import { ERROR_CODES } from "@yourtask/contracts";
import { dictionaries, translate } from "../i18n";
import { ru } from "../i18n/ru";

describe("dictionaries", () => {
  test("Russian and English have the same keys and no empty strings", () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(ru).sort());
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dictionary)) expect(value.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  test("every API error code has a translation", () => {
    for (const code of ERROR_CODES) expect(Object.keys(ru)).toContain(`error.${code}`);
  });

  test("parameters are substituted", () => {
    expect(translate("en", "sessions.revokedOthers", { count: 3 })).toBe("Other sessions revoked: 3");
  });
});
